import { randomUUID } from "node:crypto";
import type { DockerCli, DockerRunResult } from "./docker-cli.js";
import {
  COMMAND_ALLOWLIST, CONTAINER_USER, DEFAULT_GIT_IMAGE, DEFAULT_IMAGE, DEFAULT_LIMITS, HARDENING_FLAGS,
  LABEL_TASK, LABEL_WORKSPACE, MAX_RECORD_OUTPUT_BYTES, TMPFS_SPEC, WORKSPACE_DIR,
  isRepoFullName, isTaskBranch, isTaskId, type WorkspaceLimits
} from "./policy.js";
import { sanitizeOutput } from "./sanitize.js";

export type WorkspaceErrorCode =
  | "invalid_spec" | "invalid_branch" | "command_not_allowed" | "use_install" | "install_required"
  | "already_installed" | "clone_failed" | "docker_failed" | "network_disconnect_failed"
  | "task_timeout" | "aborted" | "workspace_destroyed";

export class WorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface WorkspaceSpec {
  taskId: string;
  /** `owner/repo`. */
  repoFullName: string;
  /** Assigned task branch (feat|fix|chore/...). Never main/master. */
  branch: string;
  /** Short-lived installation token. Sent only through the stdin of the clone helper. */
  token: string;
  signal?: AbortSignal;
}

export interface CommandRecord {
  command: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  /** Sanitized tail (last 16 KB) of stdout + stderr. */
  output: string;
}

export interface WorkspaceLogEvent { level: "info" | "warn"; message: string; workspaceId?: string }

export interface WorkspaceExecutorOptions {
  docker: DockerCli;
  image?: string;
  gitImage?: string;
  limits?: Partial<WorkspaceLimits>;
  logger?: (event: WorkspaceLogEvent) => void;
  now?: () => number;
  idGenerator?: () => string;
  cloneBaseUrl?: string;
  /**
   * TEST ONLY. Clone from a host directory mounted read-only into the clone helper
   * (never into the task container). Disabled unless explicitly provided.
   */
  unsafeLocalCloneSourceForTests?: { hostDir: string };
}

const LIMIT_RE = { cpus: /^\d+(\.\d+)?$/, memory: /^\d+[kmg]$/i };

function resolveLimits(partial: Partial<WorkspaceLimits> = {}): WorkspaceLimits {
  const limits = { ...DEFAULT_LIMITS, ...partial } as WorkspaceLimits;
  const ok = LIMIT_RE.cpus.test(limits.cpus) && LIMIT_RE.memory.test(limits.memory) &&
    LIMIT_RE.memory.test(limits.memorySwap) && Number.isInteger(limits.pidsLimit) && limits.pidsLimit > 0 &&
    limits.commandTimeoutMs > 0 && limits.taskTimeoutMs > 0;
  if (!ok) throw new WorkspaceError("invalid_spec", "invalid workspace limits");
  return limits;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Clone helper script. The token is read from stdin and only lives in this process' memory. */
export const CLONE_SCRIPT = [
  "set -eu",
  "IFS= read -r JEV_GIT_TOKEN",
  "export JEV_GIT_TOKEN GIT_TERMINAL_PROMPT=0",
  "git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo \"password=$JEV_GIT_TOKEN\"; }; f' \"$@\"",
  `chown -R ${CONTAINER_USER} ${WORKSPACE_DIR}`
].join("\n");

/**
 * Test-only: the local file:// clone spawns upload-pack, and git strips `-c`/GIT_CONFIG_PARAMETERS from
 * that child (local_repo_env), so safe.directory must be in the global config (HOME=/tmp tmpfs).
 */
export const LOCAL_CLONE_SCRIPT = ["set -eu", "git config --global --add safe.directory '*'", CLONE_SCRIPT].join("\n");

export class WorkspaceExecutor {
  private readonly docker: DockerCli;
  private readonly image: string;
  private readonly gitImage: string;
  private readonly limits: WorkspaceLimits;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly log: (event: WorkspaceLogEvent) => void;
  private readonly baseUrl: string;

  constructor(private readonly options: WorkspaceExecutorOptions) {
    this.docker = options.docker;
    this.image = options.image ?? DEFAULT_IMAGE;
    this.gitImage = options.gitImage ?? DEFAULT_GIT_IMAGE;
    this.limits = resolveLimits(options.limits);
    this.now = options.now ?? Date.now;
    this.newId = options.idGenerator ?? (() => randomUUID().replace(/-/g, "").slice(0, 16));
    this.log = options.logger ?? (() => {});
    this.baseUrl = options.cloneBaseUrl ?? "https://github.com";
    if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(this.baseUrl)) throw new WorkspaceError("invalid_spec", "invalid clone base URL");
  }

  /** Validates the spec, builds the volume, clones and starts the task container. Cleans up on failure. */
  async create(spec: WorkspaceSpec): Promise<Workspace> {
    if (!spec || !isTaskId(spec.taskId)) throw new WorkspaceError("invalid_spec", "invalid taskId");
    if (!isRepoFullName(spec.repoFullName)) throw new WorkspaceError("invalid_spec", "invalid repoFullName");
    if (!isTaskBranch(spec.branch)) throw new WorkspaceError("invalid_branch", "branch is not an allowed task branch");
    if (typeof spec.token !== "string" || !spec.token || spec.token.length > 1024 || /[\r\n\0]/.test(spec.token)) {
      throw new WorkspaceError("invalid_spec", "invalid token");
    }
    const id = this.newId();
    if (!SAFE_NAME.test(id)) throw new WorkspaceError("invalid_spec", "invalid workspace id");
    const ws = new Workspace({
      id, taskId: spec.taskId, token: spec.token, signal: spec.signal, docker: this.docker, limits: this.limits, gitImage: this.gitImage,
      now: this.now, log: this.log, deadline: this.now() + this.limits.taskTimeoutMs
    });
    try {
      await this.provision(ws, spec);
    } catch (error) {
      await ws.destroy();
      throw ws.wrap(error);
    }
    this.log({ level: "info", message: "workspace created", workspaceId: id });
    return ws;
  }

  /** Creates, runs `fn` and always destroys (success, error, timeout or abort). */
  async withWorkspace<T>(spec: WorkspaceSpec, fn: (workspace: Workspace) => Promise<T>): Promise<T> {
    const ws = await this.create(spec);
    try {
      return await fn(ws);
    } finally {
      await ws.destroy();
    }
  }

  /** Removes every container and volume labelled jev.workspace. Call at startup, not while tasks run. */
  async sweepOrphans(): Promise<{ containers: string[]; volumes: string[] }> {
    const timeoutMs = 60_000;
    const list = async (args: string[]): Promise<string[]> => {
      const result = await this.docker.run(args, { timeoutMs });
      if (result.exitCode !== 0) throw new WorkspaceError("docker_failed", sanitizeOutput(`sweep list failed: ${result.stderr}`));
      return result.stdout.split(/\s+/).filter(Boolean).filter((name) => SAFE_NAME.test(name));
    };
    const containers = await list(["ps", "-a", "--filter", `label=${LABEL_WORKSPACE}`, "--format", "{{.ID}}"]);
    if (containers.length) {
      const result = await this.docker.run(["rm", "-f", ...containers], { timeoutMs });
      if (result.exitCode !== 0) throw new WorkspaceError("docker_failed", sanitizeOutput(`sweep rm failed: ${result.stderr}`));
    }
    const volumes = await list(["volume", "ls", "-q", "--filter", `label=${LABEL_WORKSPACE}`]);
    if (volumes.length) {
      const result = await this.docker.run(["volume", "rm", "-f", ...volumes], { timeoutMs });
      if (result.exitCode !== 0) throw new WorkspaceError("docker_failed", sanitizeOutput(`sweep volume rm failed: ${result.stderr}`));
    }
    this.log({ level: "info", message: `sweep removed ${containers.length} containers and ${volumes.length} volumes` });
    return { containers, volumes };
  }

  private async provision(ws: Workspace, spec: WorkspaceSpec): Promise<void> {
    const labels = ["--label", `${LABEL_WORKSPACE}=${ws.id}`, "--label", `${LABEL_TASK}=${ws.taskId}`];
    const limitFlags = [
      "--cpus", this.limits.cpus, "--memory", this.limits.memory, "--memory-swap", this.limits.memorySwap,
      "--pids-limit", String(this.limits.pidsLimit)
    ];
    await ws.docker(["volume", "create", ...labels, ws.volumeName]);

    const local = this.options.unsafeLocalCloneSourceForTests;
    const cloneUrl = local ? "file:///src" : `${this.baseUrl}/${spec.repoFullName}.git`;
    const cloneArgs = [
      "run", "--rm", "-i", "--name", ws.cloneName, ...labels,
      "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
      "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", TMPFS_SPEC,
      ...limitFlags, "-e", "HOME=/tmp",
      "-v", `${ws.volumeName}:${WORKSPACE_DIR}`,
      ...(local ? ["-v", `${local.hostDir}:/src:ro`] : []),
      "--entrypoint", "sh", this.gitImage, "-c", local ? LOCAL_CLONE_SCRIPT : CLONE_SCRIPT, "sh",
      "clone", "--depth", "1", "--branch", spec.branch, "--", cloneUrl, WORKSPACE_DIR
    ];
    // The token travels only on stdin (first line), never in argv, env or files.
    const clone = await ws.docker(cloneArgs, { stdin: `${spec.token}\n`, allowFailure: true });
    if (clone.exitCode !== 0 || clone.timedOut) {
      throw new WorkspaceError("clone_failed", `clone failed (exit ${clone.exitCode}${clone.timedOut ? ", timeout" : ""}): ${ws.clean(clone.stderr).slice(-500)}`);
    }

    await ws.docker([
      "create", "--name", ws.containerName, ...labels, ...HARDENING_FLAGS, ...limitFlags,
      "--network", "bridge", "-e", "HOME=/tmp", "-e", "npm_config_cache=/tmp/.npm", "-e", "CI=true",
      "-v", `${ws.volumeName}:${WORKSPACE_DIR}`, "-w", WORKSPACE_DIR,
      this.image, "sleep", "infinity"
    ]);
    await ws.docker(["start", ws.containerName]);
  }
}

interface WorkspaceInit {
  id: string; taskId: string; token: string; signal?: AbortSignal; docker: DockerCli;
  limits: WorkspaceLimits; gitImage: string; now: () => number; log: (event: WorkspaceLogEvent) => void; deadline: number;
}

type State = "created" | "installed" | "dead";

export class Workspace {
  readonly id: string;
  readonly taskId: string;
  readonly volumeName: string;
  readonly containerName: string;
  readonly cloneName: string;
  readonly gitName: string;
  readonly records: CommandRecord[] = [];
  private state: State = "created";
  private cleaned = false;
  private destroying: Promise<boolean> | undefined;

  constructor(private readonly init: WorkspaceInit) {
    this.id = init.id;
    this.taskId = init.taskId;
    this.volumeName = `jev-ws-${init.id}`;
    this.containerName = `jev-ws-${init.id}`;
    this.cloneName = `jev-clone-${init.id}`;
    this.gitName = `jev-git-${init.id}`;
  }

  /** @internal */
  clean(text: string): string { return sanitizeOutput(text, [this.init.token]); }

  /** @internal */
  wrap(error: unknown): WorkspaceError {
    if (error instanceof WorkspaceError) return new WorkspaceError(error.code, this.clean(error.message));
    return new WorkspaceError("docker_failed", this.clean(error instanceof Error ? error.message : String(error)));
  }

  /** @internal Low-level call with abort/deadline checks; throws on failure unless allowFailure. */
  async docker(args: string[], opts: { stdin?: string; allowFailure?: boolean; timeoutMs?: number } = {}): Promise<DockerRunResult> {
    this.checkAbort();
    const timeoutMs = opts.timeoutMs ?? this.init.limits.commandTimeoutMs;
    const result = await this.init.docker.run(args, { stdin: opts.stdin, timeoutMs, signal: this.init.signal });
    this.checkAbort();
    if (!opts.allowFailure && (result.exitCode !== 0 || result.timedOut)) {
      throw new WorkspaceError("docker_failed", `docker ${args[0]} failed (exit ${result.exitCode}): ${this.clean(result.stderr).slice(-500)}`);
    }
    return result;
  }

  private checkAbort(): void {
    if (this.init.signal?.aborted) throw new WorkspaceError("aborted", "workspace operation aborted");
  }

  /** `npm ci` with network, then removes every network and verifies it. Fails closed. */
  async install(): Promise<CommandRecord> {
    if (this.state === "dead") throw new WorkspaceError("workspace_destroyed", "workspace was destroyed");
    if (this.state === "installed") throw new WorkspaceError("already_installed", "dependencies already installed");
    let record: CommandRecord;
    try {
      record = await this.exec("npm ci");
    } catch (error) {
      await this.destroy();
      throw this.wrap(error);
    }
    if (this.isDead()) return record; // killed by timeout
    try {
      await this.detachNetworks();
    } catch (error) {
      await this.destroy();
      throw new WorkspaceError("network_disconnect_failed", this.clean(error instanceof Error ? error.message : String(error)));
    }
    this.state = "installed";
    return record;
  }

  /** Runs one allowlisted command (not `npm ci`, see install()). Requires a detached network. */
  async run(command: string): Promise<CommandRecord> {
    if (typeof command !== "string" || !COMMAND_ALLOWLIST.has(command)) {
      throw new WorkspaceError("command_not_allowed", "command is not in the allowlist");
    }
    if (command === "npm ci") throw new WorkspaceError("use_install", "use install() for npm ci");
    if (this.state === "dead") throw new WorkspaceError("workspace_destroyed", "workspace was destroyed");
    if (this.state !== "installed") throw new WorkspaceError("install_required", "install() must succeed before run()");
    return this.exec(command);
  }

  private isDead(): boolean { return this.state === "dead"; }

  private async detachNetworks(): Promise<void> {
    const inspect = await this.docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", this.containerName], { allowFailure: true });
    let names: string[] = [];
    try {
      const parsed = JSON.parse(inspect.stdout.trim() || "null") as Record<string, unknown> | null;
      names = parsed ? Object.keys(parsed) : [];
    } catch {
      names = ["bridge"];
    }
    if (inspect.exitCode !== 0) names = ["bridge"];
    for (const network of names) {
      if (!SAFE_NAME.test(network)) throw new Error("unexpected network name");
      const result = await this.docker(["network", "disconnect", "--force", network, this.containerName], { allowFailure: true });
      if (result.exitCode !== 0) throw new Error(`network disconnect failed: ${this.clean(result.stderr).slice(-300)}`);
    }
    const verify = await this.docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", this.containerName], { allowFailure: true });
    const remaining = verify.exitCode === 0 ? verify.stdout.trim() : "";
    if (remaining !== "{}" && remaining !== "null") throw new Error("container still has network attachments");
  }

  /**
   * node:22-alpine has no git, so git commands run in an ephemeral helper of the git image:
   * no network, unprivileged, read-only root and the workspace volume mounted read-only.
   */
  private gitArgs(argv: readonly string[]): string[] {
    const { limits } = this.init;
    return [
      "run", "--rm", "--name", this.gitName,
      "--label", `${LABEL_WORKSPACE}=${this.id}`, "--label", `${LABEL_TASK}=${this.taskId}`,
      "--network", "none", "--user", CONTAINER_USER, "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", TMPFS_SPEC,
      "--cpus", limits.cpus, "--memory", limits.memory, "--memory-swap", limits.memorySwap, "--pids-limit", String(limits.pidsLimit),
      "-e", "HOME=/tmp", "-v", `${this.volumeName}:${WORKSPACE_DIR}:ro`, "-w", WORKSPACE_DIR,
      "--entrypoint", "git", this.init.gitImage,
      "--no-pager", "-c", `safe.directory=${WORKSPACE_DIR}`, ...argv.slice(1).filter((arg) => arg !== "--no-pager")
    ];
  }

  private async exec(command: string): Promise<CommandRecord> {
    const argv = COMMAND_ALLOWLIST.get(command)!;
    this.checkAbort();
    const remaining = this.init.deadline - this.init.now();
    if (remaining <= 0) {
      await this.destroy();
      throw new WorkspaceError("task_timeout", "task time limit exceeded");
    }
    const timeoutMs = Math.min(this.init.limits.commandTimeoutMs, remaining);
    const started = this.init.now();
    const result = await this.init.docker.run(
      argv[0] === "git" ? this.gitArgs(argv) : ["exec", "--user", CONTAINER_USER, "-w", WORKSPACE_DIR, this.containerName, ...argv],
      { timeoutMs, signal: this.init.signal }
    );
    const durationMs = Math.max(0, this.init.now() - started);
    const combined = this.clean(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`);
    const output = combined.length > MAX_RECORD_OUTPUT_BYTES ? combined.slice(combined.length - MAX_RECORD_OUTPUT_BYTES) : combined;
    const record: CommandRecord = { command, exitCode: result.exitCode, durationMs, timedOut: result.timedOut, output };
    this.records.push(record);
    this.init.log({ level: "info", workspaceId: this.id, message: `command "${command}" exit=${result.exitCode} timedOut=${result.timedOut} ms=${durationMs}` });
    if (this.init.signal?.aborted) {
      await this.destroy();
      throw new WorkspaceError("aborted", "workspace operation aborted");
    }
    if (result.timedOut) {
      // The exec'd process may outlive the docker client: kill the whole container.
      await this.destroy();
    }
    return record;
  }

  /** Removes container(s) and volume. Idempotent and never throws; resolves false if something could not be removed. */
  async destroy(): Promise<boolean> {
    this.state = "dead";
    if (this.cleaned) return true;
    this.destroying ??= this.doDestroy().finally(() => { this.destroying = undefined; });
    return this.destroying;
  }

  private async doDestroy(): Promise<boolean> {
    let ok = true;
    const steps: string[][] = [
      ["rm", "-f", this.cloneName, this.gitName, this.containerName],
      ["volume", "rm", "-f", this.volumeName]
    ];
    for (const args of steps) {
      try {
        // Not tied to the task's abort signal: cleanup must still run after an abort.
        const result = await this.init.docker.run(args, { timeoutMs: 60_000 });
        if (result.exitCode !== 0) {
          ok = false;
          this.init.log({ level: "warn", workspaceId: this.id, message: `cleanup "${args[0]}" failed: ${this.clean(result.stderr).slice(-300)}` });
        }
      } catch (error) {
        ok = false;
        this.init.log({ level: "warn", workspaceId: this.id, message: `cleanup "${args[0]}" error: ${this.clean(error instanceof Error ? error.message : String(error))}` });
      }
    }
    this.cleaned = ok;
    return ok;
  }
}
