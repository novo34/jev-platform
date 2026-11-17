/**
 * Executor policy. Everything here is fixed in code or set by the operator when
 * building the executor. No value in this file can come from a job or task.
 */

/** Fixed Node image for task containers. Pin by digest when promoting to a server. */
export const DEFAULT_IMAGE = "node:22-alpine";

/**
 * Image used only by the ephemeral clone helper (node:22-alpine has no git).
 * Tag must be verified/pinned by digest in the Docker CI step (PLT-011 step 5).
 */
export const DEFAULT_GIT_IMAGE = "alpine/git:v2.47.2";

/** Operator defaults (2026-11-17): 1 CPU, 2 GB RAM without extra swap, 256 pids, 15 min/command, 60 min/task. */
export const DEFAULT_LIMITS = Object.freeze({
  cpus: "1",
  memory: "2g",
  memorySwap: "2g",
  pidsLimit: 256,
  commandTimeoutMs: 15 * 60_000,
  taskTimeoutMs: 60 * 60_000
});
export interface WorkspaceLimits {
  cpus: string;
  memory: string;
  memorySwap: string;
  pidsLimit: number;
  commandTimeoutMs: number;
  taskTimeoutMs: number;
}

/** Unprivileged uid:gid inside the containers. */
export const CONTAINER_USER = "1000:1000";
export const WORKSPACE_DIR = "/workspace";
export const TMPFS_SPEC = "/tmp:rw,noexec,nosuid,size=256m";
export const LABEL_WORKSPACE = "jev.workspace";
export const LABEL_TASK = "jev.task";

/** Flags applied to every task container (limits are appended from WorkspaceLimits). */
export const HARDENING_FLAGS: readonly string[] = Object.freeze([
  "--user", CONTAINER_USER,
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges",
  "--read-only",
  "--tmpfs", TMPFS_SPEC
]);

/**
 * Exact allowlist. The key is the only accepted input; the value is the fixed argv.
 * No free arguments and no shell.
 *
 * RISK: `npm ci` runs dependency install scripts (preinstall/postinstall) with
 * network access (the only phase with network). A malicious dependency can
 * exfiltrate anything readable in the container (the repo checkout; the Git token
 * is never in the task container). `--ignore-scripts` is NOT used by design, since many
 * projects need install scripts. Mitigations: non-root, no caps, resource limits,
 * no credentials inside, network removed right after.
 *
 * `git` commands run in an ephemeral helper of the git image (node:22-alpine has no git):
 * `--network none`, unprivileged, read-only root and the workspace volume mounted `:ro`
 * (see Workspace.gitArgs). The argv here is the git subcommand; the helper adds
 * `--no-pager -c safe.directory=/workspace`.
 */
export const COMMAND_ALLOWLIST: ReadonlyMap<string, readonly string[]> = new Map([
  ["npm ci", ["npm", "ci"]],
  ["npm test", ["npm", "test"]],
  ["npm run build", ["npm", "run", "build"]],
  ["npm run lint", ["npm", "run", "lint"]],
  ["git status", ["git", "status"]],
  ["git diff", ["git", "--no-pager", "diff"]],
  ["git log", ["git", "--no-pager", "log"]]
]);
export type AllowedCommand = "npm ci" | "npm test" | "npm run build" | "npm run lint" | "git status" | "git diff" | "git log";

/** Maximum bytes of (sanitized) output kept per command record. */
export const MAX_RECORD_OUTPUT_BYTES = 16 * 1024;

const BRANCH_RE = /^(feat|fix|chore)\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

/**
 * Replica of `assertTaskBranch` in packages/control/src/github-app.ts (kept in sync by
 * a test that compares both). Rejects main/master and anything outside feat|fix|chore/.
 */
export function isTaskBranch(branch: unknown): branch is string {
  return !(
    typeof branch !== "string" || branch.length > 200 || !BRANCH_RE.test(branch) ||
    branch.includes("..") || branch.includes("//") || branch.includes("@{") ||
    branch.endsWith("/") || branch.split("/").some((part) =>
      part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
  );
}

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export function isTaskId(value: unknown): value is string {
  return typeof value === "string" && TASK_ID_RE.test(value);
}

export function isRepoFullName(value: unknown): value is string {
  if (typeof value !== "string" || !REPO_RE.test(value)) return false;
  const repo = value.split("/")[1]!;
  return repo !== "." && repo !== ".." && !repo.endsWith(".git") && !repo.endsWith(".");
}
