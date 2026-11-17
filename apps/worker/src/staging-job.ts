import {
  StagingOrchestrator, sanitizeText,
  type DeploymentRegistry, type ProjectStagingConfig, type StagingProviderAdapter, type StagingRunResult
} from "@jev/staging";
import type { JobHandler } from "./runtime.js";

export const STAGING_JOB_TYPE = "STAGING_DEPLOY";

/** Resolves the project's staging configuration (the default reads `repositories`/`tasks` plus injected settings). */
export type StagingConfigProvider = (ids: { projectId: string; repositoryId: string; taskId: string }) => Promise<ProjectStagingConfig>;

export interface StagingJobDeps {
  configProvider: StagingConfigProvider;
  /** Builds the provider adapter (Dokploy) for one project; the API key lives in the injected client, never in the database. */
  adapterFactory: (config: ProjectStagingConfig) => StagingProviderAdapter;
  /** Controlled deployment writer (`PgDeploymentRegistry`). */
  registry: DeploymentRegistry;
  /** Extra strings to redact from every result and error (for example the Dokploy API key). */
  redact?: readonly string[];
}

export interface StagingJobPayload {
  projectId: string;
  repositoryId: string;
  taskId: string;
  /** Exact SHA deployed to staging. */
  revision: string;
}

/** Sanitized `jobs.result`. */
export type StagingJobResult = Pick<StagingRunResult, "outcome" | "deploymentId" | "environmentId" | "revision" | "url" | "stages" | "failedStage">;

export class StagingJobError extends Error {
  constructor(readonly code: "invalid_payload" | "config_unavailable" | "staging_blocked" | "staging_failed", message: string) {
    super(message);
    this.name = "StagingJobError";
  }
}

const KEYS = ["projectId", "repositoryId", "revision", "taskId"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{40}$/i;

/** Strict validation: unknown or missing keys and malformed ids/SHA are rejected. Messages never echo values. */
export function parseStagingPayload(payload: unknown): StagingJobPayload {
  const bad = (reason: string): never => { throw new StagingJobError("invalid_payload", `invalid staging job payload: ${reason}`); };
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return bad("not an object");
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== KEYS.length || keys.some((key, index) => key !== KEYS[index])) return bad("unexpected or missing fields");
  for (const key of ["projectId", "repositoryId", "taskId"]) {
    if (typeof record[key] !== "string" || !UUID_RE.test(record[key] as string)) return bad(key);
  }
  if (typeof record.revision !== "string" || !SHA_RE.test(record.revision)) return bad("revision");
  return {
    projectId: record.projectId as string, repositoryId: record.repositoryId as string,
    taskId: record.taskId as string, revision: record.revision.toLowerCase()
  };
}

/**
 * Handler for `STAGING_DEPLOY`. Not registered by `server.ts`; call
 * `stagingHandlers(deps)` and merge the result into `WorkerRuntimeOptions.handlers`
 * on activation (needs the Dokploy API key and the staging base domain; R4).
 *
 * Outcome model:
 * - READY and FAILED are definitive deployment outcomes: the job completes and the
 *   sanitized per-stage evidence persists in `jobs.result` (a FAILED stage is not retried).
 * - BLOCKED (abort, exception, unknown or degraded result) and infrastructure problems
 *   (payload, configuration, database writer) throw so the runtime calls `queue.fail`.
 *   A BLOCKED run has already recorded its deployment as BLOCKED.
 */
export function createStagingJobHandler(deps: StagingJobDeps): JobHandler {
  const redact = deps.redact ?? [];
  return async (job, context) => {
    const payload = parseStagingPayload(job.payload);
    if (
      (job.taskId !== null && job.taskId !== payload.taskId) ||
      (job.projectId !== null && job.projectId !== payload.projectId)
    ) {
      throw new StagingJobError("invalid_payload", "invalid staging job payload: ids do not match the job");
    }
    if (context.signal.aborted) throw new StagingJobError("staging_blocked", "staging job aborted before start");

    let config: ProjectStagingConfig;
    try {
      config = await deps.configProvider({ projectId: payload.projectId, repositoryId: payload.repositoryId, taskId: payload.taskId });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      // Provider errors could echo configuration: only a short code survives.
      throw new StagingJobError("config_unavailable", `staging configuration unavailable${typeof code === "string" && /^[a-z_]{1,60}$/.test(code) ? ` (${code})` : ""}`);
    }
    const secrets = [...redact, ...Object.values(config.settings.secretValues ?? {})];
    const clean = (text: string): string => sanitizeText(text, secrets);

    let run: StagingRunResult;
    try {
      run = await new StagingOrchestrator(deps.adapterFactory(config), deps.registry).run({
        request: config.request, revision: payload.revision, signal: context.signal, secrets
      });
    } catch (error) {
      throw new StagingJobError("staging_failed", clean(`staging deployment failed: ${error instanceof Error ? error.message : String(error)}`).slice(0, 1000));
    }

    if (run.outcome === "BLOCKED") {
      const stage = run.stages.find((entry) => entry.stage === run.failedStage);
      throw new StagingJobError("staging_blocked", clean(`staging deployment blocked (${run.blockedReason ?? "unknown"}${run.failedStage ? ` at ${run.failedStage}` : ""}${stage ? `: ${stage.detail}` : ""})`).slice(0, 1000));
    }
    return {
      outcome: run.outcome, deploymentId: run.deploymentId, environmentId: run.environmentId,
      revision: run.revision, url: run.url, stages: run.stages, ...(run.failedStage ? { failedStage: run.failedStage } : {})
    } satisfies StagingJobResult;
  };
}

/** Handlers to merge into `WorkerRuntimeOptions.handlers` when the staging job is activated. */
export function stagingHandlers(deps: StagingJobDeps): Record<string, JobHandler> {
  return { [STAGING_JOB_TYPE]: createStagingJobHandler(deps) };
}
