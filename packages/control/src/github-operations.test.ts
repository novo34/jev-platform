import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApproval, createDatabasePool, migrate } from "@jev/db";
import { hashPassword, login, type AuthenticatedUser } from "@jev/auth";
import type { Pool } from "pg";
import { ControlService, GitHubAppClient, GitHubOperations, type ControlAction } from "./index.js";

const applicationName = "jev-gh-ops-" + randomUUID();
const pool = createDatabasePool({ application_name: applicationName });
const organizationId = randomUUID(), foreignOrganizationId = randomUUID();
const projectId = randomUUID(), foreignProjectId = randomUUID();
const repositoryId = randomUUID(), foreignRepositoryId = randomUUID(), userId = randomUUID();
const installationId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 12), 16) + 1;
const baseSha = "a".repeat(40), headSha = "b".repeat(40), mergeSha = "c".repeat(40);
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
let actor: AuthenticatedUser, taskId: string;
let calls: Array<{ url: string; method?: string; body?: any }>;
let reviewerId = 900, reviewSha = headSha, checkConclusion = "success", checkApp = 15368, prSha = headSha;
let serverPolicy = "valid", unrecordedCommit = false;
let writeTimeout = false;
let writeRateLimited = false;
let reviewsEmpty = false, reviewState = "APPROVED";
let onWriteToken: (() => Promise<void>) | undefined;

function service(database = pool, mergeEnabled = true, singleOperator = false): ControlService {
  const app = new GitHubAppClient({ appId: "123", privateKey: key }, { fetch: async (url, init) => {
    const path = String(url); const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: path, method: init?.method, body });
    if (path.endsWith("/access_tokens")) {
      if (body.permissions.contents === "write" && onWriteToken) { const hook = onWriteToken; onWriteToken = undefined; await hook(); }
      return Response.json({ token: "test-install-token", expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ id: 42 }], permissions: body.permissions });
    }
    if (path.endsWith("/protection")) { const single = serverPolicy.startsWith("single");
      const scenario = serverPolicy.replace(/^single-?/, "");
      const response = scenario === "missing" ? {} : {
      enforce_admins: { enabled: scenario !== "admins" }, allow_force_pushes: { enabled: scenario === "force" }, allow_deletions: { enabled: scenario === "delete" },
      required_status_checks: { strict: scenario !== "loose", checks: [{ context: "validate", app_id: scenario === "checks" ? 999 : 15368 }] },
      required_pull_request_reviews: { required_approving_review_count: !single || scenario === "review-required" ? 1 : 0, dismiss_stale_reviews: true,
        require_code_owner_reviews: !single || scenario === "codeowners", require_last_push_approval: !single || scenario === "last-push",
        bypass_pull_request_allowances: { users: [], teams: [], apps: scenario === "bypass" ? [{ id: 123 }] : [] } }
    };
      if (serverPolicy.includes("graphql")) delete (response as any).required_pull_request_reviews.bypass_pull_request_allowances;
      if (scenario === "no-pr") delete (response as any).required_pull_request_reviews;
      return Response.json(response);
    }
    if (path.endsWith("/graphql")) return Response.json(serverPolicy.endsWith("graphql-error") ? { errors: [{ message: "permission denied" }], data: null } : {
      data: { repository: { ref: { branchProtectionRule: { bypassPullRequestAllowances: { totalCount: serverPolicy.endsWith("graphql-bypass") ? 1 : 0 } } } } }
    });
    if (path.includes("/codeowners/errors")) return Response.json({ errors: serverPolicy === "owner-errors" ? [{ message: "invalid owner" }] : [] });
    if (path.includes("/collaborators/")) return Response.json({ permission: serverPolicy === "owner-access" ? "read" : "write", user: { id: 900 } });
    if (path.includes("/contents/.github/CODEOWNERS")) { const text = serverPolicy === "owners" ? "* @implementer" : "* @independent-reviewer";
      return Response.json({ type: "file", encoding: "base64", content: Buffer.from(text).toString("base64"), size: text.length }); }
    if (path.includes("/users/")) return Response.json({ id: path.endsWith("/implementer") ? 800 : 900 });
    if (path.includes("/pulls/9/commits?")) return Response.json(unrecordedCommit ? [{ sha: "d".repeat(40), author: { id: 900 } }, { sha: headSha }] : [{ sha: headSha }]);
    if (path.includes("/branches/")) return Response.json({ commit: { sha: baseSha } });
    if (path.endsWith("/git/refs")) return Response.json({ ref: body.ref, object: { sha: body.sha } });
    if (path.includes("/contents/")) {
      if (writeTimeout) throw new Error("ambiguous-secret-marker");
      if (writeRateLimited) return new Response("rate limited", { status: 429, headers: { "retry-after": "12" } });
      return Response.json({ commit: { sha: headSha } });
    }
    if (path.endsWith("/pulls") && init?.method === "POST") return Response.json({ number: 9, html_url: "https://github.com/owner/op-repo/pull/9", head: { sha: headSha } });
    if (path.includes("/check-runs")) {
      return Response.json({ total_count: 1, check_runs: [{ id: 1, name: "validate", app: { id: checkApp }, head_sha: headSha, status: "completed", conclusion: checkConclusion }] });
    }
    if (path.includes("/status?")) return Response.json({ state: "success", total_count: 0, statuses: [] });
    if (path.includes("/actions/runs")) return Response.json({ total_count: 1, workflow_runs: [{ status: "completed", conclusion: "success" }] });
    if (path.includes("/reviews?")) return Response.json(reviewsEmpty ? [] : [{ id: 1, commit_id: reviewSha, state: reviewState, user: { id: reviewerId, login: reviewerId === 800 ? "implementer" : "independent-reviewer" } }]);
    if (path.endsWith("/merge")) return Response.json({ merged: true, sha: mergeSha });
    if (path.endsWith("/pulls/9")) return Response.json({ number: 9, state: "open", draft: false, html_url: "https://github.com/owner/op-repo/pull/9",
      user: serverPolicy === "deleted-author" ? null : { id: 500, login: "jev-app[bot]" },
      head: { sha: prSha, ref: `feat/jev-${taskId}`, repo: serverPolicy === "deleted-fork" ? null : { id: 42 } }, base: { ref: "main", repo: { id: 42 } } });
    return Response.json({ id: 42, full_name: "owner/op-repo", default_branch: "main" });
  } });
  const operations = new GitHubOperations(database, app, mergeEnabled ? singleOperator ? {
    approvalMode: "single_operator", requiredChecks: [{ name: "validate", appId: 15368 }]
  } : {
    trustedReviewerIds: [900, 800, 500], requiredChecks: [{ name: "validate", appId: 15368 }]
  } : undefined);
  return new ControlService(database, undefined, operations);
}

function execute(action: ControlAction, payload: Record<string, unknown> = {}, commandId = randomUUID(), control = service()) {
  return control.execute({ action, projectId, targetId: repositoryId, payload, commandId }, { actor, correlationId: "github-operations-test" });
}
async function transition(status: string) {
  await pool.query("SELECT jev_transition_task($1,$2,'USER',$3,'github test','{}'::jsonb)", [taskId, status, userId]);
}
async function approve() {
  await execute("GITHUB_WRITE_FILE", { taskId, path: "acceptance.txt", content: "test", message: "feat: acceptance" });
  await execute("GITHUB_CREATE_PR", { taskId, title: "feat: controlled task", body: "test evidence" });
  for (const status of ["VERIFYING", "VERIFIED", "STAGING", "AWAITING_HUMAN"]) await transition(status);
  await createApproval(pool, { projectId, taskId, actorUserId: userId, decision: "APPROVED", revision: headSha,
    commitSha: headSha, pullRequestUrl: "https://github.com/owner/op-repo/pull/9", evidence: { verificationSource: "test-fixture" } });
  await transition("APPROVED");
}

beforeAll(async () => {
  await migrate(pool);
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Operations Org'),($2,'Foreign Operations Org')", [organizationId, foreignOrganizationId]);
  await pool.query("INSERT INTO users(id,organization_id,email,display_name,role,password_hash) VALUES($1,$2,'admin@operations.test','Admin','ADMIN',$3)", [userId, organizationId, hashPassword("operations-test-password")]);
  await pool.query("INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'Operations Project'),($3,$4,'Foreign Operations Project')", [projectId, organizationId, foreignProjectId, foreignOrganizationId]);
  await pool.query("INSERT INTO repositories(id,project_id,full_name,role,external_repository_id) VALUES($1,$2,'owner/op-repo','other','42'),($3,$4,'foreign/repo','other','99')", [repositoryId, projectId, foreignRepositoryId, foreignProjectId]);
  await pool.query("INSERT INTO github_installations(installation_id,organization_id,account_id,verified_by) VALUES($1,$2,77,$3)", [installationId, organizationId, userId]);
  await pool.query("INSERT INTO github_repository_installations(repository_id,installation_id) VALUES($1,$2)", [repositoryId, installationId]);
  await pool.query("INSERT INTO github_user_identities(organization_id,user_id,github_user_id,github_login) VALUES($1,$2,800,'implementer')", [organizationId, userId]);
  await pool.query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,'PROJECT_MANAGER')", [projectId, userId]);
});
beforeEach(async () => {
  await pool.query("UPDATE users SET role='ADMIN',status='ACTIVE' WHERE id=$1", [userId]);
  await pool.query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,'PROJECT_MANAGER') ON CONFLICT(project_id,user_id) DO UPDATE SET role=EXCLUDED.role", [projectId,userId]);
  actor = (await login(pool, { organizationId, email: "admin@operations.test", password: "operations-test-password" })).user;
  const order = (await pool.query("INSERT INTO orders(project_id,objective) VALUES($1,'controlled task') RETURNING id", [projectId])).rows[0].id;
  taskId = (await pool.query("SELECT jev_create_task($1,$2,$3,'GitHub Task','R1','[]'::jsonb) AS id", [projectId, order, repositoryId])).rows[0].id;
  await transition("READY"); await transition("RUNNING");
  calls = []; reviewerId = 900; reviewSha = headSha; checkConclusion = "success"; checkApp = 15368; prSha = headSha; writeTimeout = false;
  serverPolicy = "valid"; unrecordedCommit = false;
  onWriteToken = undefined;
  writeRateLimited = false;
  reviewsEmpty = false; reviewState = "APPROVED";
});
// Immutable task/approval/audit fixtures remain in the disposable test DB.
afterAll(async () => { await pool.end(); });

describe("GitHub operations (real PostgreSQL, simulated GitHub)", () => {
  it("reads only a linked repository in the authorized tenant/project", async () => {
    await expect(execute("GITHUB_READ_REPOSITORY")).resolves.toMatchObject({ ok: true, data: { id: 42 } });
    const count = calls.length;
    await expect(service().execute({ action: "GITHUB_READ_REPOSITORY", commandId: randomUUID(), projectId, targetId: foreignRepositoryId }, { actor, correlationId: "cross-scope" })).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(calls).toHaveLength(count);
  });

  it("derives the task branch and base from canonical state; never accepts caller branch or verifier booleans", async () => {
    await execute("GITHUB_CREATE_BRANCH", { taskId });
    expect(calls.find((call) => call.url.endsWith("/git/refs"))?.body).toEqual({ ref: `refs/heads/feat/jev-${taskId}`, sha: baseSha });
    const before = calls.length;
    await expect(execute("GITHUB_WRITE_FILE", { taskId, path: "x", content: "x", message: "feat: x", branch: "main" })).rejects.toMatchObject({ code: "GITHUB_INVALID_REQUEST" });
    await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha, verifierPassed: true, humanApproved: true })).rejects.toMatchObject({ code: "GITHUB_INVALID_REQUEST" });
    expect(calls).toHaveLength(before);
    await pool.query("UPDATE tasks SET branch_name='main' WHERE id=$1", [taskId]);
    await expect(execute("GITHUB_CREATE_BRANCH", { taskId })).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
  });

  it("commits once, returns the recorded result on replay and rejects command tampering", async () => {
    const commandId = randomUUID(), payload = { taskId, path: "src/test.ts", content: "test", message: "feat: test" };
    const first = await execute("GITHUB_WRITE_FILE", payload, commandId);
    const count = calls.length;
    expect(await execute("GITHUB_WRITE_FILE", payload, commandId)).toEqual(first);
    expect(calls).toHaveLength(count);
    await expect(execute("GITHUB_WRITE_FILE", { ...payload, content: "changed" }, commandId)).rejects.toMatchObject({ code: "GITHUB_CONFLICT" });
    expect(calls).toHaveLength(count);
  });

  it("rejects a legacy branch assignment shared by two tasks", async () => {
    const orderId = (await pool.query("SELECT order_id FROM tasks WHERE id=$1", [taskId])).rows[0].order_id;
    const other = (await pool.query("SELECT jev_create_task($1,$2,$3,'Other Task','R1','[]'::jsonb) AS id", [projectId, orderId, repositoryId])).rows[0].id;
    await pool.query("UPDATE tasks SET branch_name='feat/shared' WHERE id IN ($1,$2)", [taskId, other]);
    await expect(execute("GITHUB_CREATE_BRANCH", { taskId })).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(calls).toEqual([]);
  });

  it.each(["logout", "expiry"])("revalidates %s after waiting for the project lock", async (scenario) => {
    const blocker = await pool.connect();
    const commandId = randomUUID();
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT jev_lock_project_scope($1)", [projectId]);
      const pending = execute("GITHUB_CREATE_BRANCH", { taskId }, commandId);
      // Attach rejection handling immediately; wait until the durable reservation exists.
      const result = pending.then(() => "unexpected-success", (error: any) => error.code);
      let reserved = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await pool.query("SELECT 1 FROM github_operations WHERE organization_id=$1 AND command_id=$2", [organizationId, commandId])).rowCount) { reserved = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(reserved).toBe(true);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const activity = await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query='SELECT jev_lock_project_scope($1::uuid)'", [applicationName]);
        if (activity.rowCount) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      if (scenario === "logout") await pool.query("DELETE FROM auth_sessions WHERE id=$1", [actor.sessionId]);
      if (scenario === "expiry") await pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp() WHERE id=$1", [actor.sessionId]);
      if (scenario === "role") await pool.query("UPDATE users SET role='CLIENT' WHERE id=$1", [userId]);
      await blocker.query("COMMIT");
      expect(await result).toBe("GITHUB_FORBIDDEN");
      expect(calls).toEqual([]);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    await pool.query("UPDATE users SET role='CLIENT' WHERE id=$1", [userId]);
    await expect(execute("GITHUB_CREATE_BRANCH", { taskId })).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
  });

  it.each(["role", "status", "membership"])("holds %s authority stable until an in-flight mutation commits", async (scenario) => {
    if (scenario === "membership") {
      await pool.query("UPDATE users SET role='PROJECT_MANAGER' WHERE id=$1", [userId]); actor.role = "PROJECT_MANAGER";
    }
    let revocation: Promise<unknown> | undefined;
    onWriteToken = async () => {
      const query = scenario === "role" ? "UPDATE users SET role='CLIENT' WHERE id=$1" :
        scenario === "status" ? "UPDATE users SET status='DISABLED' WHERE id=$1" : "DELETE FROM project_memberships WHERE user_id=$1";
      revocation = pool.query(query, [userId]);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query=$2", [applicationName, query]);
        if (result.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    };
    try {
      await expect(execute("GITHUB_WRITE_FILE", { taskId, path: "x", content: "x", message: "feat: x" })).resolves.toMatchObject({ ok: true });
    } finally { await revocation; }
    const count = calls.length;
    await expect(execute("GITHUB_CREATE_BRANCH", { taskId })).rejects.toBeDefined();
    expect(calls).toHaveLength(count);
  });

  it("requires current ADMIN role at merge even if project:admin remains granted", async () => {
    await approve();
    await pool.query("UPDATE users SET role='PROJECT_MANAGER' WHERE id=$1", [userId]);
    await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha })).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(calls.some((call) => call.url.endsWith("/merge"))).toBe(false);
  });

  it("rejects a trusted reviewer who directly contributed an unrecorded PR commit", async () => {
    await approve(); unrecordedCommit = true;
    await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha })).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(calls.some(call => call.url.endsWith("/merge"))).toBe(false);
  });

  it.each(["missing", "bypass", "checks", "owners", "owner-errors", "owner-access", "graphql-bypass", "graphql-error", "deleted-fork", "deleted-author"])("denies merge without equivalent atomic server policy: %s", async (scenario) => {
    await approve(); serverPolicy = scenario;
    await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha })).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(calls.some(call => call.url.endsWith("/merge"))).toBe(false);
  });

  it("requires an explicit GraphQL zero when REST omits bypass allowances", async () => {
    await approve(); serverPolicy = "graphql-zero";
    await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha })).resolves.toMatchObject({ ok: true });
    expect(calls.find(call => call.url.endsWith("/graphql"))?.body.query).toMatch(/^query JEVBranchBypass/);
  });

  it("rejects a different review account that reused the trusted reviewer's login", async () => {
    await approve(); reviewerId = 901;
    await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha })).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(calls.some((call) => call.url.endsWith("/merge"))).toBe(false);
  });

  it("does not strand reservations after a pre-send audit failure", async () => {
    let fail = true;
    const failing = { query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect();
      return { query: (sql: string, values?: unknown[]) => {
        if (fail && sql.includes("INSERT INTO audit_events")) { fail = false; throw new Error("test-audit-failure"); }
        return client.query(sql, values);
      }, release: () => client.release() };
    } } as unknown as Pool;
    const commandId = randomUUID();
    await expect(execute("GITHUB_CREATE_BRANCH", { taskId }, commandId, service(failing))).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    expect((await pool.query("SELECT 1 FROM github_operations WHERE organization_id=$1 AND command_id=$2", [organizationId, commandId])).rowCount).toBe(0);
    expect(calls).toEqual([]);
    await expect(execute("GITHUB_CREATE_BRANCH", { taskId }, commandId)).resolves.toMatchObject({ ok: true });
  });

  it("marks ambiguous writes UNKNOWN and refuses automatic replay", async () => {
    writeTimeout = true;
    const commandId = randomUUID(), payload = { taskId, path: "x", content: "x", message: "feat: x" };
    await expect(execute("GITHUB_WRITE_FILE", payload, commandId)).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    expect((await pool.query("SELECT status FROM github_operations WHERE organization_id=$1 AND command_id=$2", [organizationId, commandId])).rows[0].status).toBe("UNKNOWN");
    const count = calls.length;
    await expect(execute("GITHUB_WRITE_FILE", payload, commandId)).rejects.toMatchObject({ code: "GITHUB_CONFLICT" });
    expect(calls).toHaveLength(count);
  });

  it("allows an explicit idempotent retry after a definitive GitHub rate-limit rejection", async () => {
    writeRateLimited = true;
    const commandId = randomUUID(), payload = { taskId, path: "x", content: "x", message: "feat: x" };
    await expect(execute("GITHUB_WRITE_FILE", payload, commandId)).rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED", retryAfterSeconds: 12 });
    expect((await pool.query("SELECT status FROM github_operations WHERE organization_id=$1 AND command_id=$2", [organizationId, commandId])).rows[0].status).toBe("FAILED");
    writeRateLimited = false;
    await expect(execute("GITHUB_WRITE_FILE", payload, commandId)).resolves.toMatchObject({ ok: true, data: { commit: { sha: headSha } } });
  });

  it("rejects self-verification by the human implementer even when the PR author is the App bot", async () => {
    await approve(); reviewerId = 800;
    await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha })).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(calls.some((call) => call.url.endsWith("/merge"))).toBe(false);
  });

  it("rejects PR-author self-review by numeric identity even if its login changed", async () => {
    await approve(); reviewerId = 500;
    await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha })).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(calls.some((call) => call.url.endsWith("/merge"))).toBe(false);
  });

  it("rejects stale approval, stale head/review, failing checks, wrong check App and disabled merge policy", async () => {
    await approve();
    const payload = { taskId, number: 9, approvedSha: headSha };
    for (const scenario of ["head", "review", "checks", "app", "disabled"]) {
      prSha = scenario === "head" ? baseSha : headSha;
      reviewSha = scenario === "review" ? baseSha : headSha;
      checkConclusion = scenario === "checks" ? "failure" : "success";
      checkApp = scenario === "app" ? 999 : 15368;
      await expect(execute("GITHUB_MERGE_PR", payload, randomUUID(), service(pool, scenario !== "disabled"))).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    }
    checkApp = 15368;
    await pool.query("UPDATE approvals SET stale=TRUE WHERE task_id=$1", [taskId]);
    await expect(execute("GITHUB_MERGE_PR", payload)).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(calls.some((call) => call.url.endsWith("/merge"))).toBe(false);
  });

  it("merges only the approved SHA after independent review and trusted checks; never marks the task DONE", async () => {
    await approve();
    await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha })).resolves.toMatchObject({ ok: true, data: { merged: true, sha: mergeSha } });
    expect(calls.find((call) => call.url.endsWith("/merge"))?.body).toEqual({ sha: headSha, merge_method: "squash" });
    expect((await pool.query("SELECT status FROM tasks WHERE id=$1", [taskId])).rows[0].status).toBe("APPROVED");
  });

  it("single operator merges without a second account only after canonical approval and trusted checks", async () => {
    await approve(); serverPolicy = "single"; reviewsEmpty = true;
    await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha }, randomUUID(), service(pool, true, true)))
      .resolves.toMatchObject({ ok: true, data: { merged: true, sha: mergeSha } });
    expect(calls.find(call => call.url.endsWith("/merge"))?.body).toEqual({ sha: headSha, merge_method: "squash" });
    expect(calls.some(call => call.url.includes("CODEOWNERS") || call.url.includes("/collaborators/") || call.url.includes("/users/"))).toBe(false);
    expect((await pool.query("SELECT status FROM tasks WHERE id=$1", [taskId])).rows[0].status).toBe("APPROVED");
  });

  it("single operator cannot merge a running task without canonical human approval", async () => {
    serverPolicy = "single"; reviewsEmpty = true;
    await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha }, randomUUID(), service(pool, true, true)))
      .rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(calls).toEqual([]);
  });

  it.each([
    { approvalMode: "single_operator", requiredChecks: [] },
    { approvalMode: "single_operator", requiredChecks: [{ name: "validate", appId: 15368 }], trustedReviewerIds: [900] },
    { approvalMode: "single_operatr", requiredChecks: [{ name: "validate", appId: 15368 }] },
    { requiredChecks: [{ name: "validate", appId: 15368 }] }
  ])("merge policy requires an explicit valid mode or legacy independent reviewers", policy => {
    expect(() => new GitHubOperations(pool, {} as GitHubAppClient, policy as any))
      .toThrowError("GITHUB_INVALID_CONFIGURATION");
  });

  it("single operator does not need an approval review by the implementer", async () => {
    await approve(); serverPolicy = "single"; reviewerId = 800;
    await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha }, randomUUID(), service(pool, true, true)))
      .resolves.toMatchObject({ ok: true });
  });

  it.each(["no-pr", "missing", "bypass", "admins", "force", "delete", "loose", "checks", "review-required", "codeowners", "last-push", "graphql-bypass", "graphql-error"])(
    "single operator rejects incompatible or bypassable server protection: %s", async scenario => {
      await approve(); serverPolicy = "single-" + scenario; reviewsEmpty = true;
      await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha }, randomUUID(), service(pool, true, true)))
        .rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
      expect(calls.some(call => call.url.endsWith("/merge"))).toBe(false);
    });

  it("single operator accepts only explicit zero bypass allowances when REST omits them", async () => {
    await approve(); serverPolicy = "single-graphql-zero"; reviewsEmpty = true;
    await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha }, randomUUID(), service(pool, true, true)))
      .resolves.toMatchObject({ ok: true });
    expect(calls.some(call => call.url.endsWith("/graphql"))).toBe(true);
  });

  it.each(["head", "checks", "app", "stale", "unrecorded", "changes-requested", "not-admin"])(
    "single operator preserves approval, CI, provenance and authority guards: %s", async scenario => {
      await approve(); serverPolicy = "single"; reviewsEmpty = true;
      if (scenario === "head") prSha = baseSha;
      if (scenario === "checks") checkConclusion = "failure";
      if (scenario === "app") checkApp = 999;
      if (scenario === "stale") await pool.query("UPDATE approvals SET stale=TRUE WHERE task_id=$1", [taskId]);
      if (scenario === "unrecorded") unrecordedCommit = true;
      if (scenario === "changes-requested") { reviewsEmpty = false; reviewState = "CHANGES_REQUESTED"; }
      if (scenario === "not-admin") await pool.query("UPDATE users SET role='DEVELOPER' WHERE id=$1", [userId]);
      try {
        await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha }, randomUUID(), service(pool, true, true)))
          .rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
        expect(calls.some(call => call.url.endsWith("/merge"))).toBe(false);
      } finally {
        if (scenario === "not-admin") await pool.query("UPDATE users SET role='ADMIN' WHERE id=$1", [userId]);
      }
    });
});
