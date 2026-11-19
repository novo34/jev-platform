import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, DEFAULT_MIGRATIONS_DIR, migrate } from "@jev/db";
import { hashPassword } from "@jev/auth";
import type { ModelGatewayRequest, ModelGatewayResult } from "@jev/model-gateway";
import type { IntentModelGateway } from "@jev/work-orders";
import path from "node:path";
import { buildApi } from "./app.js";

// PLT-040 PR 6 routes end to end under the RESTRICTED runtime role: the API
// pool authenticates as a disposable copy of jev_runtime provisioned by the
// real script; fixtures are created as the migrator. The gateway is a fake.
const admin = createDatabasePool();
const role = `jev_rt_api_${randomBytes(5).toString("hex")}`;
let runtime: Pool;
const password = "restricted-routes-password-1";
const org = randomUUID();
const project = randomUUID();
const adminUser = randomUUID();
const TARGETS = [{ provider: "anthropic" as const, model: "fake-model" }];
const brief = (o: Record<string, unknown> = {}) => ({
  goal: "g", requested_change: "c", in_scope: [], out_of_scope: [], observed_context: [],
  assumptions: [], open_questions: [], ambiguity_score: 0.1, change_radius: "LOCAL", risk_signals: [],
  documentation_depth: "L0", clarification_required: false, evidence_needed: [], ...o
});
const contract = {
  intent_id: "PENDING_INTENT_ID",
  acceptance_criteria: [{ criterion: "works", verification: "manual check" }],
  constraints: [], assumptions: [], non_goals: [], affected_requirements: [],
  compatibility_requirements: [], required_evidence: [], unresolved_decisions: [], specification_depth: "L0"
};
function fakeGateway(steps: string[]): IntentModelGateway & { requests: ModelGatewayRequest[] } {
  const requests: ModelGatewayRequest[] = [];
  return {
    requests,
    async execute(request) {
      requests.push(request);
      const step = steps.shift();
      if (step === undefined) throw new Error("fake gateway: no more steps");
      return {
        content: step, requestId: request.requestId, provider: "anthropic", model: "fake-model",
        attempts: 1, latencyMs: 1, estimatedCostChf: 0, usage: {} as ModelGatewayResult["usage"]
      };
    }
  };
}

beforeAll(async () => {
  await migrate(admin);
  await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
  const script = await readFile(path.join(DEFAULT_MIGRATIONS_DIR, "..", "security", "provision-runtime-role.sql"), "utf8");
  await admin.query(script.replaceAll("jev_runtime", role));
  const dbPassword = randomBytes(24).toString("hex");
  const literal = (await admin.query("SELECT quote_literal($1::text) AS v", [dbPassword])).rows[0].v;
  await admin.query(`ALTER ROLE "${role}" PASSWORD ${literal}`);
  const url = new URL(process.env.DATABASE_URL!);
  url.username = role;
  url.password = dbPassword;
  runtime = createDatabasePool({ connectionString: url.toString() });

  await admin.query("INSERT INTO organizations (id, name) VALUES ($1,'RT API Org')", [org]);
  await admin.query(
    "INSERT INTO users (id, organization_id, email, display_name, role, password_hash) VALUES ($1,$2,'rt-admin@test.local','U','ADMIN',$3)",
    [adminUser, org, hashPassword(password)]
  );
  await admin.query("INSERT INTO projects (id, organization_id, name) VALUES ($1,$2,'RT API')", [project, org]);
  await admin.query(
    `INSERT INTO repositories (id, project_id, full_name, role, primary_repository, default_branch, staging_branch)
     VALUES ($1,$2,'novo34/rt-api','backend',TRUE,'main','staging')`, [randomUUID(), project]);
});
afterAll(async () => {
  await runtime?.end();
  await admin.query(`DROP OWNED BY "${role}"`);
  await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});

describe("work-order routes with the restricted runtime role", () => {
  it("login, intake + generated order, tasks, blocking and re-evaluation all work", async () => {
    const gateway = fakeGateway([JSON.stringify(brief()), JSON.stringify(contract)]);
    const app = buildApi({ pool: runtime, workOrders: { intentGateway: gateway, intentTargets: TARGETS, env: {} } });
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { organizationId: org, email: "rt-admin@test.local", password } });
    expect(login.statusCode).toBe(200);
    const headers = { authorization: `Bearer ${login.json().token}` };

    const created = await app.inject({ method: "POST", url: `/projects/${project}/work-orders`, payload: { objective: "Replace the hero image" }, headers });
    expect(created.statusCode, created.body).toBe(201);
    const order = created.json().order;
    expect(order.acceptanceContract.intentId).toBe(order.intent.id);
    const intake = (await admin.query("SELECT id, intent_legacy FROM orders WHERE project_id=$1 AND work_type='SYSTEM_INTAKE'", [project])).rows;
    expect(intake).toHaveLength(1);
    expect(intake[0].intent_legacy).toBe(false);
    for (const request of gateway.requests) expect(request.orderId).toBe(intake[0].id);

    const base = `/projects/${project}/orders/${order.id}`;
    const task = await app.inject({ method: "POST", url: `${base}/tasks`, payload: { title: "Do it", risk: "R1" }, headers });
    expect(task.statusCode, task.body).toBe(201);
    expect(task.json().task).toMatchObject({ status: "PLANNED", risk: "R1" });

    // An ambiguous order blocks its tasks at R2 minimum; a clarified brief (saved by
    // the migrator here, as the route that saves versions is out of scope) unblocks them.
    const ambiguous = (await admin.query("INSERT INTO orders (project_id, objective) VALUES ($1,'Ambiguous') RETURNING id", [project])).rows[0].id;
    await admin.query(
      `INSERT INTO intent_briefs (organization_id, order_id, version, document, ambiguity_score, change_radius, documentation_depth, clarification_required)
       VALUES ($1,$2,1,$3::jsonb,0.9,'LOCAL','L0',true)`,
      [org, ambiguous, JSON.stringify(brief({ ambiguity_score: 0.9, clarification_required: true }))]);
    const blocked = await app.inject({ method: "POST", url: `/projects/${project}/orders/${ambiguous}/tasks`, payload: { title: "Blocked" }, headers });
    expect(blocked.statusCode, blocked.body).toBe(201);
    expect(blocked.json().task).toMatchObject({ status: "BLOCKED", risk: "R2" });
    const url = `/projects/${project}/orders/${ambiguous}/reevaluate-blocked-tasks`;
    expect((await app.inject({ method: "POST", url, headers })).json().result).toMatchObject({ stillBlocked: true, unblockedTaskIds: [] });
    await admin.query(
      `INSERT INTO intent_briefs (organization_id, order_id, version, document, ambiguity_score, change_radius, documentation_depth, clarification_required)
       VALUES ($1,$2,2,$3::jsonb,0.1,'LOCAL','L0',false)`,
      [org, ambiguous, JSON.stringify(brief())]);
    const done = await app.inject({ method: "POST", url, headers });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().result).toMatchObject({ stillBlocked: false, unblockedTaskIds: [blocked.json().task.id] });
    await app.close();
  });
});
