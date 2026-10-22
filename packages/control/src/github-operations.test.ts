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
let writeTimeout = false;
let writeRateLimited = false;
let onChecks: (() => Promise<void>) | undefined;
let onWriteToken: (() => Promise<void>) | undefined;

function service(database = pool, mergeEnabled = true): ControlService {
  const app = new GitHubAppClient({ appId: "123", privateKey: key }, { fetch: async (url, init) => {
    const path = String(url); const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: path, method: init?.method, body });
    if (path.endsWith("/access_tokens")) {
      if (body.permissions.contents === "write" && onWriteToken) { const hook = onWriteToken; onWriteToken = undefined; await hook(); }
      return Response.json({ token: "test-install-token", expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ id: 42 }], permissions: body.permissions });
    }
    if (path.includes("/branches/")) return Response.json({ commit: { sha: baseSha } });
    if (path.endsWith("/git/refs")) return Response.json({ ref: body.ref, object: { sha: body.sha } });
    if (path.includes("/contents/")) {
      if (writeTimeout) throw new Error("ambiguous-secret-marker");
      if (writeRateLimited) return new Response("rate limited", { status: 429, headers: { "retry-after": "12" } });
      return Response.json({ commit: { sha: headSha } });
    }
    if (path.endsWith("/pulls") && init?.method === "POST") return Response.json({ number: 9, html_url: "https://github.com/owner/op-repo/pull/9", head: { sha: headSha } });
    if (path.includes("/check-runs")) {
      if (onChecks) { const hook = onChecks; onChecks = undefined; await hook(); }
      return Response.json({ total_count: 1, check_runs: [{ id: 1, name: "validate", app: { id: checkApp }, head_sha: headSha, status: "completed", conclusion: checkConclusion }] });
    }
    if (path.includes("/status?")) return Response.json({ state: "success", total_count: 0, statuses: [] });
    if (path.includes("/actions/runs")) return Response.json({ total_count: 1, workflow_runs: [{ status: "completed", conclusion: "success" }] });
    if (path.includes("/reviews?")) return Response.json([{ id: 1, commit_id: reviewSha, state: "APPROVED", user: { id: reviewerId, login: reviewerId === 800 ? "implementer" : "independent-reviewer" } }]);
    if (path.endsWith("/merge")) return Response.json({ merged: true, sha: mergeSha });
    if (path.endsWith("/pulls/9")) return Response.json({ number: 9, state: "open", draft: false, html_url: "https://github.com/owner/op-repo/pull/9",
      user: { id: 500, login: "jev-app[bot]" }, head: { sha: prSha, ref: `feat/jev-${taskId}`, repo: { id: 42 } }, base: { ref: "main", repo: { id: 42 } } });
    return Response.json({ id: 42, full_name: "owner/op-repo", default_branch: "main" });
  } });
  const operations = new GitHubOperations(database, app, mergeEnabled ? {
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
  await pool.query("UPDATE users SET role='ADMIN' WHERE id=$1", [userId]);
  actor = (await login(pool, { organizationId, email: "admin@operations.test", password: "operations-test-password" })).user;
  const order = (await pool.query("INSERT INTO orders(project_id,objective) VALUES($1,'controlled task') RETURNING id", [projectId])).rows[0].id;
  taskId = (await pool.query("SELECT jev_create_task($1,$2,$3,'GitHub Task','R1','[]'::jsonb) AS id", [projectId, order, repositoryId])).rows[0].id;
  await transition("READY"); await transition("RUNNING");
  calls = []; reviewerId = 900; reviewSha = headSha; checkConclusion = "success"; checkApp = 15368; prSha = headSha; writeTimeout = false;
  onChecks = undefined; onWriteToken = undefined;
  writeRateLimited = false;
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

  it.each(["logout", "expiry", "role"])("revalidates %s after waiting for the project lock", async (scenario) => {
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

  it("revalidates permission after installation-token issuance, immediately before the write", async () => {
    onWriteToken = async () => { await pool.query("UPDATE users SET role='CLIENT' WHERE id=$1", [userId]); };
    const commandId = randomUUID();
    await expect(execute("GITHUB_WRITE_FILE", { taskId, path: "x", content: "x", message: "feat: x" }, commandId)).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(calls.some((call) => call.url.includes("/contents/"))).toBe(false);
    expect((await pool.query("SELECT status FROM github_operations WHERE organization_id=$1 AND command_id=$2", [organizationId, commandId])).rows[0].status).toBe("FAILED");
  });

  it("requires current ADMIN role at merge send time even if project:admin remains granted", async () => {
    await approve();
    onChecks = async () => { await pool.query("UPDATE users SET role='PROJECT_MANAGER' WHERE id=$1", [userId]); };
    await expect(execute("GITHUB_MERGE_PR", { taskId, number: 9, approvedSha: headSha })).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(calls.some((call) => call.url.endsWith("/merge"))).toBe(false);
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
});
