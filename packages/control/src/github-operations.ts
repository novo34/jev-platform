import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { authorizeProject, lockActorAuthorization, type AuthenticatedUser, type ProjectPermission } from "@jev/auth";
import { z } from "zod";
import { GitHubAppClient, GitHubError, assertTaskBranch, type GitHubRepositoryScope } from "./github-app.js";
import type { ControlCommand, ControlContext } from "./types.js";
import { recordAudit } from "./audit.js";

const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const taskPayload = z.object({ taskId: z.uuid() }).strict();
const pullPayload = z.object({ number }).strict();
const filePayload = taskPayload.extend({ path: z.string().min(1).max(1024), content: z.string().max(1_000_000),
  message: z.string().min(1).max(4096), previousBlobSha: sha.optional() }).strict();
const prPayload = taskPayload.extend({ title: z.string().min(1).max(256), body: z.string().max(65_536) }).strict();
const mergePayload = taskPayload.extend({ number, approvedSha: sha }).strict();

const writes = new Set<string>(["GITHUB_CREATE_BRANCH", "GITHUB_WRITE_FILE", "GITHUB_CREATE_PR", "GITHUB_MERGE_PR"]);
const mergePolicySchema = z.object({
  trustedReviewerIds: z.array(number).min(1),
  requiredChecks: z.array(z.object({ name: z.string().min(1), appId: number }).strict()).min(1)
}).strict();
export type GitHubMergePolicy = z.infer<typeof mergePolicySchema>;
type Scope = GitHubRepositoryScope & { organizationId: string; repositoryKey: string; defaultBranch: string; stagingBranch: string | null };

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GitHubError("GITHUB_INVALID_REQUEST");
  return result.data;
}

/** Subordinate to ControlService authorization; no independently exposed API. */
export class GitHubOperations {
  private readonly policy?: GitHubMergePolicy;
  constructor(private readonly pool: Pool, private readonly app: GitHubAppClient, policy?: GitHubMergePolicy) {
    if (policy !== undefined) {
      const result = mergePolicySchema.safeParse(policy);
      if (!result.success) throw new GitHubError("GITHUB_INVALID_CONFIGURATION");
      this.policy = result.data;
    }
  }

  private async scope(db: Pool | PoolClient, command: ControlCommand, context: ControlContext): Promise<Scope> {
    const repositoryKey = parse(z.uuid(), command.targetId);
    const result = await db.query(
      `SELECT r.id,r.full_name,r.external_repository_id,r.default_branch,r.staging_branch,g.installation_id
        FROM repositories r JOIN projects p ON p.id=r.project_id
        JOIN github_repository_installations l ON l.repository_id=r.id
        JOIN github_installations g ON g.installation_id=l.installation_id AND g.organization_id=p.organization_id
        WHERE r.id=$1 AND r.project_id=$2 AND p.organization_id=$3 AND p.status='ACTIVE'`,
      [repositoryKey, command.projectId, context.actor.organizationId]
    );
    const row = result.rows[0];
    if (!row) throw new GitHubError("GITHUB_FORBIDDEN");
    return { installationId: parse(number, Number(row.installation_id)),
      repositoryId: parse(number, Number(row.external_repository_id)), fullName: row.full_name,
      organizationId: context.actor.organizationId, repositoryKey, defaultBranch: row.default_branch, stagingBranch: row.staging_branch };
  }

  private async task(db: Pool | PoolClient, command: ControlCommand, scope: Scope, taskId: string, merging = false): Promise<string> {
    const result = await db.query<{ branch_name: string | null; status: string }>(
      `SELECT t.branch_name,t.status FROM tasks t JOIN projects p ON p.id=t.project_id
        WHERE t.id=$1 AND t.project_id=$2 AND t.repository_id=$3 AND p.organization_id=$4
          AND NOT EXISTS (SELECT 1 FROM tasks other WHERE other.project_id=t.project_id
            AND other.repository_id=t.repository_id AND other.id<>t.id
            AND COALESCE(other.branch_name,'feat/jev-'||other.id::text)=COALESCE(t.branch_name,'feat/jev-'||t.id::text))`,
      [taskId, command.projectId, scope.repositoryKey, scope.organizationId]
    );
    const row = result.rows[0];
    if (!row || row.status !== (merging ? "APPROVED" : "RUNNING")) throw new GitHubError("GITHUB_FORBIDDEN");
    const branch = row.branch_name ?? `feat/jev-${taskId}`;
    assertTaskBranch(branch);
    if ([scope.defaultBranch, scope.stagingBranch, "main", "master"].includes(branch)) throw new GitHubError("GITHUB_FORBIDDEN");
    return branch;
  }

  async execute(command: ControlCommand, context: ControlContext, permission: ProjectPermission): Promise<unknown> {
    const scope = await this.scope(this.pool, command, context);
    if (!writes.has(command.action)) {
      switch (command.action) {
        case "GITHUB_READ_REPOSITORY":
          parse(z.object({}).strict(), command.payload ?? {});
          return this.app.repository(scope);
        case "GITHUB_READ_PR": return this.app.pullRequest(scope, parse(pullPayload, command.payload).number);
        case "GITHUB_READ_REVIEWS": return this.app.reviews(scope, parse(pullPayload, command.payload).number);
        case "GITHUB_READ_CHECKS": return this.app.checks(scope, parse(z.object({ sha }).strict(), command.payload).sha);
        default: throw new GitHubError("GITHUB_INVALID_REQUEST");
      }
    }
    const payload = command.action === "GITHUB_WRITE_FILE" ? parse(filePayload, command.payload) :
      command.action === "GITHUB_CREATE_PR" ? parse(prPayload, command.payload) :
      command.action === "GITHUB_MERGE_PR" ? parse(mergePayload, command.payload) : parse(taskPayload, command.payload);
    await this.task(this.pool, command, scope, payload.taskId, command.action === "GITHUB_MERGE_PR");
    const fingerprint = createHash("sha256").update(JSON.stringify({ action: command.action, repository: scope.repositoryKey, payload })).digest("hex");
    const db = await this.pool.connect();
    let sent = false;
    let ownedReservation = false;
    try {
      await db.query("BEGIN");
      const reserved = await db.query(
        `INSERT INTO github_operations(organization_id,project_id,repository_id,task_id,actor_id,command_id,action,request_hash,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING') ON CONFLICT(organization_id,command_id) DO NOTHING RETURNING command_id`,
        [context.actor.organizationId, command.projectId, scope.repositoryKey, payload.taskId,
          context.actor.id, command.commandId, command.action, fingerprint]
      );
      if (reserved.rowCount !== 1) {
        const old = (await db.query(
          `SELECT actor_id,request_hash,status,result FROM github_operations WHERE organization_id=$1 AND command_id=$2`,
          [context.actor.organizationId, command.commandId])).rows[0];
        if (old?.actor_id !== context.actor.id || old.request_hash !== fingerprint) throw new GitHubError("GITHUB_CONFLICT");
        if (old.status === "SUCCESS") { await db.query("ROLLBACK"); return old.result; }
        if (old.status !== "FAILED") throw new GitHubError("GITHUB_CONFLICT");
        const retried = await db.query(
          "UPDATE github_operations SET status='PENDING',result=NULL WHERE organization_id=$1 AND command_id=$2 AND status='FAILED' RETURNING command_id",
          [context.actor.organizationId, command.commandId]);
        if (retried.rowCount !== 1) throw new GitHubError("GITHUB_CONFLICT");
      }
      await recordAudit(db, context, { ...command, action: "GITHUB_OPERATION_AUTHORIZED" }, "SUCCESS", {
        requestedAction: command.action, taskId: payload.taskId
      });
      await db.query("COMMIT");
      ownedReservation = true;
      await db.query("BEGIN");
      await db.query("SELECT jev_lock_project_scope($1::uuid)", [command.projectId]);
      await lockActorAuthorization(db, context.actor.id, command.projectId);
      const activeActor = await this.activeActor(db, context, command.projectId, permission);
      const lockedScope = await this.scope(db, command, context);
      if (JSON.stringify(lockedScope) !== JSON.stringify(scope)) throw new GitHubError("GITHUB_CONFLICT");
      const branch = await this.task(db, command, scope, payload.taskId, command.action === "GITHUB_MERGE_PR");
      const beforeSend = async () => {
        const current = await this.activeActor(db, context, command.projectId, permission);
        if (command.action === "GITHUB_MERGE_PR" && current.role !== "ADMIN") throw new GitHubError("GITHUB_FORBIDDEN");
        sent = true;
      };
      let result: unknown;
      switch (command.action) {
        case "GITHUB_CREATE_BRANCH": {
          const base = await this.app.branch(scope, scope.defaultBranch);
          result = await this.app.createBranch(scope, branch, base.commit.sha, beforeSend); break;
        }
        case "GITHUB_WRITE_FILE": {
          const input = parse(filePayload, payload);
          const written = await this.app.writeFile(scope, { ...input, branch }, beforeSend);
          result = { commit: { sha: parse(sha, written.commit?.sha) }, branch }; break;
        }
        case "GITHUB_CREATE_PR": {
          const input = parse(prPayload, payload);
          const pr = await this.app.createPullRequest(scope, { ...input, branch, base: scope.defaultBranch }, beforeSend);
          const prNumber = parse(number, pr.number);
          result = { number: prNumber, html_url: `https://github.com/${scope.fullName}/pull/${prNumber}`, head: { sha: parse(sha, pr.head?.sha) } }; break;
        }
        case "GITHUB_MERGE_PR": {
          const input = parse(mergePayload, payload);
          await this.authorizeMerge(db, command, { ...context, actor: activeActor }, scope, branch, input);
          result = await this.app.mergePullRequest(scope, input.number, input.approvedSha, beforeSend); break;
        }
        default: throw new GitHubError("GITHUB_INVALID_REQUEST");
      }
      await db.query("UPDATE github_operations SET status='SUCCESS',result=$3::jsonb WHERE organization_id=$1 AND command_id=$2",
        [context.actor.organizationId, command.commandId, JSON.stringify(result)]);
      await recordAudit(db, context, command, "SUCCESS", { taskId: payload.taskId });
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      const definitelyRejected = error instanceof GitHubError &&
        ["GITHUB_FORBIDDEN", "GITHUB_RATE_LIMITED", "GITHUB_CONFLICT"].includes(error.code);
      if (ownedReservation) await db.query("UPDATE github_operations SET status=$3 WHERE organization_id=$1 AND command_id=$2",
        [context.actor.organizationId, command.commandId, sent && !definitelyRejected ? "UNKNOWN" : "FAILED"]);
      throw error instanceof GitHubError ? error : new GitHubError("GITHUB_UNAVAILABLE");
    } finally { db.release(); }
  }

  private async activeActor(db: PoolClient, context: ControlContext, projectId: string, permission: ProjectPermission): Promise<AuthenticatedUser> {
    const result = await db.query(
      `SELECT u.* FROM users u JOIN auth_sessions s ON s.user_id=u.id
        JOIN github_user_identities i ON i.user_id=u.id AND i.organization_id=u.organization_id
        WHERE u.id=$1 AND u.organization_id=$2 AND u.status='ACTIVE' AND s.id=$3 AND s.expires_at>clock_timestamp()
        FOR SHARE OF s`, [context.actor.id, context.actor.organizationId, context.actor.sessionId]);
    const row = result.rows[0];
    if (!row) throw new GitHubError("GITHUB_FORBIDDEN");
    const actor: AuthenticatedUser = { id: row.id, organizationId: row.organization_id,
      role: row.role, sessionId: context.actor.sessionId, email: row.email, displayName: row.display_name };
    try { await authorizeProject(db, actor, projectId, permission); }
    catch { throw new GitHubError("GITHUB_FORBIDDEN"); }
    return actor;
  }

  private async authorizeMerge(db: PoolClient, command: ControlCommand, context: ControlContext, scope: Scope, branch: string,
    input: z.infer<typeof mergePayload>): Promise<void> {
    if (!this.policy || context.actor.role !== "ADMIN") throw new GitHubError("GITHUB_FORBIDDEN");
    const pr = await this.app.pullRequest(scope, input.number);
    if (pr.state !== "open" || pr.draft !== false || pr.head?.sha !== input.approvedSha || pr.head.ref !== branch ||
        pr.head.repo?.id !== scope.repositoryId || pr.base?.repo?.id !== scope.repositoryId ||
        pr.base.ref !== scope.defaultBranch || !number.safeParse(pr.user?.id).success) throw new GitHubError("GITHUB_FORBIDDEN");
    const approval = await db.query(
      `SELECT a.id FROM approvals a JOIN tasks t ON t.id=a.task_id JOIN projects p ON p.id=t.project_id
        WHERE a.task_id=$1 AND t.project_id=$2 AND p.organization_id=$3 AND t.status='APPROVED'
          AND a.decision='APPROVED' AND NOT a.stale AND a.commit_sha=$4 AND a.pull_request_url=$5`,
      [input.taskId, command.projectId, context.actor.organizationId, input.approvedSha,
        `https://github.com/${scope.fullName}/pull/${input.number}`]
    );
    if (approval.rowCount !== 1) throw new GitHubError("GITHUB_FORBIDDEN");
    const observations = await this.app.checks(scope, input.approvedSha);
    const checks = z.object({ total_count: z.number().int().nonnegative(), check_runs: z.array(z.object({
      id: number, name: z.string(), head_sha: sha, status: z.string(), conclusion: z.string().nullable(), app: z.object({ id: number })
    })) }).safeParse(observations.checkRuns);
    if (!checks.success || checks.data.total_count !== checks.data.check_runs.length) throw new GitHubError("GITHUB_FORBIDDEN");
    for (const required of this.policy.requiredChecks) {
      const latest = checks.data.check_runs.filter((item) => item.name === required.name && item.app.id === required.appId)
        .sort((a, b) => b.id - a.id)[0];
      if (!latest || latest.head_sha !== input.approvedSha || latest.status !== "completed" || latest.conclusion !== "success") {
        throw new GitHubError("GITHUB_FORBIDDEN");
      }
    }
    const reviews = z.array(z.object({ id: number, commit_id: sha, state: z.string(), user: z.object({ id: number, login: z.string() }) })).safeParse(await this.app.reviews(scope, input.number));
    if (!reviews.success) throw new GitHubError("GITHUB_FORBIDDEN");
    const writers = await db.query(
      `SELECT DISTINCT o.actor_id,i.github_user_id FROM github_operations o
        LEFT JOIN github_user_identities i ON i.organization_id=o.organization_id AND i.user_id=o.actor_id
        WHERE o.organization_id=$1 AND o.project_id=$2 AND o.repository_id=$3 AND o.task_id=$4
          AND o.action IN ('GITHUB_CREATE_BRANCH','GITHUB_WRITE_FILE','GITHUB_CREATE_PR')
          AND o.status IN ('PENDING','SUCCESS','UNKNOWN')`,
      [context.actor.organizationId, command.projectId, scope.repositoryKey, input.taskId]);
    if (!writers.rowCount || writers.rows.some((row) => !row.github_user_id)) throw new GitHubError("GITHUB_FORBIDDEN");
    // Every PR commit must have been produced by the controlled App path.
    // This rejects an unrecorded direct GitHub writer, including a trusted reviewer.
    const commits = z.array(z.object({ sha })).min(1).max(249).safeParse(await this.app.pullRequestCommits(scope, input.number));
    if (!commits.success || commits.data.at(-1)?.sha !== input.approvedSha) throw new GitHubError("GITHUB_FORBIDDEN");
    const recorded = await db.query(
      `SELECT result->'commit'->>'sha' AS sha FROM github_operations
        WHERE organization_id=$1 AND project_id=$2 AND repository_id=$3 AND task_id=$4
          AND action='GITHUB_WRITE_FILE' AND status='SUCCESS'`,
      [context.actor.organizationId, command.projectId, scope.repositoryKey, input.taskId]);
    const controlledCommits = new Set(recorded.rows.map(row => row.sha));
    if (commits.data.some(commit => !controlledCommits.has(commit.sha))) throw new GitHubError("GITHUB_FORBIDDEN");
    const writerIdentities = new Set(writers.rows.map((row) => Number(row.github_user_id)));
    await this.assertServerMergePolicy(scope, writerIdentities, pr.user.id);
    const latest = new Map<number, typeof reviews.data[number]>();
    for (const review of reviews.data.sort((a, b) => a.id - b.id)) {
      if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) latest.set(review.user.id, review);
    }
    if ([...latest.values()].some((item) => item.state === "CHANGES_REQUESTED") ||
        !this.policy.trustedReviewerIds.some((id) => {
          const review = latest.get(id);
          return review?.state === "APPROVED" && review.commit_id === input.approvedSha &&
            review.user.id !== pr.user.id && !writerIdentities.has(review.user.id);
        })) throw new GitHubError("GITHUB_FORBIDDEN");
  }

  /** Read-only Administration permission inspects complete classic protection;
   * GitHub enforces these requirements atomically at merge. No bypass is granted.
   */
  private async assertServerMergePolicy(scope: Scope, writers: Set<number>, prAuthorId: number): Promise<void> {
    if (!this.policy) throw new GitHubError("GITHUB_FORBIDDEN");
    const empty = z.array(z.unknown()).max(0);
    const protection = z.object({
      enforce_admins: z.object({ enabled: z.literal(true) }),
      allow_force_pushes: z.object({ enabled: z.literal(false) }),
      allow_deletions: z.object({ enabled: z.literal(false) }),
      required_status_checks: z.object({ strict: z.literal(true), checks: z.array(z.object({ context: z.string(), app_id: number })) }),
      required_pull_request_reviews: z.object({ required_approving_review_count: z.number().int().min(1),
        dismiss_stale_reviews: z.literal(true), require_code_owner_reviews: z.literal(true), require_last_push_approval: z.literal(true),
        bypass_pull_request_allowances: z.object({ users: empty, teams: empty, apps: empty }).optional() })
    }).safeParse(await this.app.branchProtection(scope, scope.defaultBranch));
    if (!protection.success || !this.policy.requiredChecks.every(required => protection.data.required_status_checks.checks.some(check => check.context === required.name && check.app_id === required.appId))) throw new GitHubError("GITHUB_FORBIDDEN");
    if (protection.data.required_pull_request_reviews.bypass_pull_request_allowances === undefined) {
      // REST may omit this optional field. Require an explicit zero from the
      // matching GraphQL rule; unknown, hidden, null or partial data is denied.
      const bypass = z.object({ errors: empty.optional(), data: z.object({ repository: z.object({ ref: z.object({
        branchProtectionRule: z.object({ bypassPullRequestAllowances: z.object({ totalCount: z.literal(0) }) })
      }) }) }) }).safeParse(await this.app.branchBypassAllowances(scope, scope.defaultBranch));
      if (!bypass.success) throw new GitHubError("GITHUB_FORBIDDEN");
    }
    const errors = z.object({ errors: empty }).safeParse(await this.app.codeOwnerErrors(scope, scope.defaultBranch));
    if (!errors.success) throw new GitHubError("GITHUB_FORBIDDEN");
    const file = z.object({ type: z.literal("file"), encoding: z.literal("base64"), content: z.string(), size: z.number().int().min(1).max(8192) })
      .safeParse(await this.app.codeOwners(scope, scope.defaultBranch));
    if (!file.success) throw new GitHubError("GITHUB_FORBIDDEN");
    const lines = Buffer.from(file.data.content, "base64").toString("utf8").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
    if (lines.length !== 1 || !/^\*\s+@[A-Za-z0-9-]+(?:\s+@[A-Za-z0-9-]+)*$/.test(lines[0])) throw new GitHubError("GITHUB_FORBIDDEN");
    const owners = lines[0].split(/\s+/).slice(1);
    if (!owners.length || owners.length > 20) throw new GitHubError("GITHUB_FORBIDDEN");
    for (const owner of owners) {
      const identity = z.object({ id: number }).safeParse(await this.app.publicIdentity(scope, owner.slice(1)));
      if (!identity.success || !this.policy.trustedReviewerIds.includes(identity.data.id) || writers.has(identity.data.id) || identity.data.id === prAuthorId) throw new GitHubError("GITHUB_FORBIDDEN");
      const access = z.object({ permission: z.enum(["admin", "write", "maintain"]), user: z.object({ id: number }) })
        .safeParse(await this.app.collaboratorPermission(scope, owner.slice(1)));
      if (!access.success || access.data.user.id !== identity.data.id) throw new GitHubError("GITHUB_FORBIDDEN");
    }
  }

}
