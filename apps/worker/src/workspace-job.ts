import {
  COMMAND_ALLOWLIST, WorkspaceExecutor, isRepoFullName, isTaskBranch, isTaskId, sanitizeOutput,
  type CommandRecord
} from "@jev/workspace";
import type { JobHandler } from "./runtime.js";

export const WORKSPACE_JOB_TYPE = "WORKSPACE_RUN";
export const MAX_WORKSPACE_COMMANDS = 10;

/**
 * Contract of the token provider injected by whoever activates the job. It must return a
 * read-only, single-repository installation token for a repository registered to the
 * project (the control layer does this with `GitHubOperations.cloneToken`). The worker
 * never imports `@jev/control` and never holds the GitHub App private key.
 */
export type TokenProvider = (projectId: string, repoFullName: string) => Promise<{ token: string; expiresAt: string }>;

export interface WorkspaceJobDeps {
  executor: WorkspaceExecutor;
  tokenProvider: TokenProvider;
  now?: () => number;
}

export interface WorkspaceJobPayload {
  taskId: string;
  projectId: string;
  repoFullName: string;
  branch: string;
  commands: string[];
}

export interface WorkspaceJobResult {
  workspaceId: string;
  branch: string;
  /** PASSED when every command exited 0 without timing out; otherwise FAILED (execution stops at the first failure). */
  status: "PASSED" | "FAILED";
  commands: Array<Pick<CommandRecord, "command" | "exitCode" | "durationMs" | "timedOut" | "output">>;
}

/** Invalid job input. The message never echoes payload values. */
export class WorkspaceJobError extends Error {
  constructor(readonly code: "invalid_payload" | "token_unavailable" | "workspace_failed", message: string) {
    super(message);
    this.name = "WorkspaceJobError";
  }
}

const KEYS = ["taskId", "projectId", "repoFullName", "branch", "commands"].sort();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict validation: unknown or missing keys, bad types and non-allowlisted commands are rejected. */
export function parseWorkspacePayload(payload: unknown): WorkspaceJobPayload {
  const bad = (reason: string): never => { throw new WorkspaceJobError("invalid_payload", `invalid workspace job payload: ${reason}`); };
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return bad("not an object");
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== KEYS.length || keys.some((key, index) => key !== KEYS[index])) return bad("unexpected or missing fields");
  if (!isTaskId(record.taskId)) return bad("taskId");
  if (typeof record.projectId !== "string" || !UUID_RE.test(record.projectId)) return bad("projectId");
  if (!isRepoFullName(record.repoFullName)) return bad("repoFullName");
  if (!isTaskBranch(record.branch)) return bad("branch");
  const commands = record.commands;
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > MAX_WORKSPACE_COMMANDS) return bad("commands");
  for (const command of commands) {
    // `npm ci` is never requested: install() always runs first.
    if (typeof command !== "string" || command === "npm ci" || !COMMAND_ALLOWLIST.has(command)) return bad("commands");
  }
  return {
    taskId: record.taskId, projectId: record.projectId, repoFullName: record.repoFullName,
    branch: record.branch, commands: [...(commands as string[])]
  };
}

const view = (record: CommandRecord) => ({
  command: record.command, exitCode: record.exitCode, durationMs: record.durationMs,
  timedOut: record.timedOut, output: record.output
});
const failed = (record: CommandRecord) => record.exitCode !== 0 || record.timedOut;

/**
 * Handler for `WORKSPACE_RUN`. Not registered by `server.ts`; call `workspaceHandlers(deps)` and
 * pass the result in `WorkerRuntimeOptions.handlers` when the executor is activated.
 *
 * Outcome model:
 * - A command that exits non-zero (or times out) is a deterministic task outcome: the handler
 *   stops, returns `status: "FAILED"` with the full detail and the job is COMPLETED, so the
 *   detail persists in `jobs.result` (queue.fail only stores a message) and is not retried.
 * - Infrastructure problems (invalid payload, token, clone, Docker, abort, timeout) throw, so
 *   the runtime calls `queue.fail` (retry policy of the queue) with a sanitized message.
 * State lives in `jobs.result` (not `task_runs`: `jev_runtime` has no DML on it, PLT-008).
 */
export function createWorkspaceJobHandler(deps: WorkspaceJobDeps): JobHandler {
  const now = deps.now ?? Date.now;
  return async (job, context) => {
    const payload = parseWorkspacePayload(job.payload);
    if ((job.taskId !== null && job.taskId !== payload.taskId) || (job.projectId !== null && job.projectId !== payload.projectId)) {
      throw new WorkspaceJobError("invalid_payload", "invalid workspace job payload: ids do not match the job");
    }
    if (context.signal.aborted) throw new WorkspaceJobError("workspace_failed", "workspace job aborted before start");

    let granted: { token: string; expiresAt: string };
    try {
      granted = await deps.tokenProvider(payload.projectId, payload.repoFullName);
      const expiry = Date.parse(granted.expiresAt);
      if (typeof granted.token !== "string" || !granted.token || !Number.isFinite(expiry) || expiry <= now()) throw new Error();
    } catch {
      // Fixed message: provider errors could echo credentials or internals.
      throw new WorkspaceJobError("token_unavailable", "clone token unavailable");
    }
    const { token } = granted;
    const clean = (text: string) => sanitizeOutput(text, [token]);

    try {
      return await deps.executor.withWorkspace(
        { taskId: payload.taskId, repoFullName: payload.repoFullName, branch: payload.branch, token, signal: context.signal },
        async (workspace): Promise<WorkspaceJobResult> => {
          const records: CommandRecord[] = [];
          let ok = true;
          const install = await workspace.install();
          records.push(install);
          ok = !failed(install);
          for (const command of payload.commands) {
            if (!ok) break;
            const record = await workspace.run(command);
            records.push(record);
            ok = !failed(record);
          }
          // Defence in depth: outputs are already sanitized by the executor; clean again with the token.
          return {
            workspaceId: workspace.id, branch: payload.branch, status: ok ? "PASSED" : "FAILED",
            commands: records.map((record) => ({ ...view(record), output: clean(record.output) }))
          };
        }
      );
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      throw new WorkspaceJobError("workspace_failed", clean(`workspace failed${typeof code === "string" ? ` (${code})` : ""}: ${error instanceof Error ? error.message : String(error)}`).slice(0, 1000));
    }
  };
}

/** Handlers to merge into `WorkerRuntimeOptions.handlers` when the workspace job is activated. */
export function workspaceHandlers(deps: WorkspaceJobDeps): Record<string, JobHandler> {
  return { [WORKSPACE_JOB_TYPE]: createWorkspaceJobHandler(deps) };
}
