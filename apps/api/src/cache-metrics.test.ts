import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { hashPassword } from "@jev/auth";
import { buildApi } from "./app.js";

const pool = createDatabasePool();
const password = "cache-metrics-password-123";
const orgA = randomUUID();
const orgB = randomUUID();
const adminA = randomUUID();
const devA = randomUUID();
const projectA = randomUUID();
const projectB = randomUUID();
const repoA = randomUUID();
const repoB = randomUUID();
const taskA = randomUUID();
const taskB = randomUUID();

beforeAll(async () => {
  await migrate(pool);
  const hash = hashPassword(password);
  for (const [org, name] of [[orgA, "Metrics API A"], [orgB, "Metrics API B"]] as const) {
    await pool.query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [org, name]);
  }
  await pool.query(
    `INSERT INTO users (id, organization_id, email, display_name, role, password_hash) VALUES
     ($1, $3, 'metrics-admin@test.local', 'Admin', 'ADMIN', $4),
     ($2, $3, 'metrics-dev@test.local', 'Dev', 'DEVELOPER', $4)`, [adminA, devA, orgA, hash]);
  for (const [org, project, repo, task] of [[orgA, projectA, repoA, taskA], [orgB, projectB, repoB, taskB]] as const) {
    await pool.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'P')", [project, org]);
    await pool.query("INSERT INTO repositories (id, project_id, full_name, role) VALUES ($1, $2, $3, 'backend')",
      [repo, project, `novo34/metrics-${repo}`]);
    await pool.query("INSERT INTO tasks (id, project_id, repository_id, title) VALUES ($1, $2, $3, 'T')",
      [task, project, repo]);
    await pool.query(
      `INSERT INTO model_provider_calls (request_id, organization_id, project_id, task_id, provider, model,
         outcome, attempt_count, usage, cache_read_tokens, cache_status, estimated_cost_chf,
         estimated_cost_without_cache_chf, estimated_cache_savings_chf)
       VALUES ($1, $2, $3, $4, 'anthropic', 'm', 'SUCCESS', 1,
         '{"inputTokens":100,"outputTokens":1}'::jsonb, $5, 'PARTIAL', 0.001, 0.002, 0.001)`,
      [randomUUID(), org, project, task, org === orgA ? 400 : 9000]);
  }
});

afterAll(async () => {
  await pool.query("TRUNCATE task_state_history");
  for (const org of [orgA, orgB]) {
    await pool.query("DELETE FROM model_provider_calls WHERE organization_id = $1", [org]);
    await pool.query("DELETE FROM audit_events WHERE organization_id = $1", [org]);
  }
  await pool.query("DELETE FROM auth_sessions WHERE user_id IN ($1, $2)", [adminA, devA]);
  await pool.query("DELETE FROM tasks WHERE id IN ($1, $2)", [taskA, taskB]);
  await pool.query("DELETE FROM repositories WHERE id IN ($1, $2)", [repoA, repoB]);
  await pool.query("DELETE FROM projects WHERE id IN ($1, $2)", [projectA, projectB]);
  await pool.query("DELETE FROM users WHERE id IN ($1, $2)", [adminA, devA]);
  await pool.query("DELETE FROM organizations WHERE id IN ($1, $2)", [orgA, orgB]);
  await pool.end();
});

async function login(email: string): Promise<string> {
  const app = buildApi({ pool });
  const response = await app.inject({
    method: "POST", url: "/auth/login", payload: { organizationId: orgA, email, password }
  });
  await app.close();
  return response.json().token as string;
}

describe("GET /model-gateway/cache-metrics/:level", () => {
  it("requires authentication and the ADMIN role", async () => {
    const app = buildApi({ pool });
    expect((await app.inject({ method: "GET", url: "/model-gateway/cache-metrics/project" })).statusCode).toBe(401);
    const dev = await login("metrics-dev@test.local");
    const forbidden = await app.inject({
      method: "GET", url: "/model-gateway/cache-metrics/project", headers: { authorization: `Bearer ${dev}` }
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });

  it("returns only the session organization at every level and ignores any organization in the request", async () => {
    const token = await login("metrics-admin@test.local");
    const app = buildApi({ pool });
    const headers = { authorization: `Bearer ${token}` };
    const project = await app.inject({
      method: "GET", url: `/model-gateway/cache-metrics/project?organizationId=${orgB}`, headers
    });
    // An organizationId in the query is dropped by the schema: the session decides.
    expect(project.statusCode).toBe(200);
    expect(project.json().metrics.map((m: { organizationId: string }) => m.organizationId)).toEqual([orgA]);
    const own = await app.inject({ method: "GET", url: "/model-gateway/cache-metrics/project", headers });
    expect(own.statusCode).toBe(200);
    expect(own.json().metrics.map((m: { projectId: string }) => m.projectId)).toEqual([projectA]);
    expect(own.json().metrics[0]).toMatchObject({ cacheReadTokens: "400", callsPartial: "1" });
    const tasks = await app.inject({ method: "GET", url: "/model-gateway/cache-metrics/task", headers });
    expect(tasks.json().metrics.map((m: { taskId: string }) => m.taskId)).toEqual([taskA]);
    const calls = await app.inject({
      method: "GET", url: `/model-gateway/cache-metrics/call?taskId=${taskB}`, headers
    });
    expect(calls.statusCode).toBe(200);
    expect(calls.json().metrics).toEqual([]);
    const callsOwn = await app.inject({ method: "GET", url: "/model-gateway/cache-metrics/call", headers });
    expect(callsOwn.json().metrics).toHaveLength(1);
    expect(JSON.stringify(callsOwn.json())).not.toMatch(/sha256|segment/i);
    const bad = await app.inject({ method: "GET", url: "/model-gateway/cache-metrics/call?limit=0", headers });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
