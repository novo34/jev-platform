import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { hashPassword } from "@jev/auth";
import type { ModelGatewayRequest, ModelGatewayResult } from "@jev/model-gateway";
import { ModelGatewayError } from "@jev/model-gateway";
import { IntentAcceptanceService, type IntentModelGateway } from "@jev/work-orders";
import { buildApi } from "./app.js";

// PLT-040 PR 6 routes. No network: the gateway is a fake or never built.
const pool = createDatabasePool();
const intents = new IntentAcceptanceService(pool);
const password = "work-order-routes-password-1";
const orgA = randomUUID();
const orgB = randomUUID();
const projectA = randomUUID();
const projectB = randomUUID(); // same org, no repository
const projectOther = randomUUID(); // other org
const ids = {
  admin: randomUUID(), dev: randomUUID(), devNoMember: randomUUID(), auditor: randomUUID(),
  client: randomUUID(), otherAdmin: randomUUID()
};
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

function fakeGateway(steps: (string | Error)[]): IntentModelGateway & { requests: ModelGatewayRequest[] } {
  const requests: ModelGatewayRequest[] = [];
  return {
    requests,
    async execute(request) {
      requests.push(request);
      const step = steps.shift();
      if (step === undefined) throw new Error("fake gateway: no more steps");
      if (step instanceof Error) throw step;
      return {
        content: step, requestId: request.requestId, provider: "anthropic", model: "fake-model",
        attempts: 1, latencyMs: 1, estimatedCostChf: 0, usage: {} as ModelGatewayResult["usage"]
      };
    }
  };
}
const apiWith = (gateway?: IntentModelGateway, env: NodeJS.ProcessEnv = {}) =>
  buildApi({ pool, workOrders: { intentGateway: gateway, intentTargets: gateway ? TARGETS : undefined, env } });

// Login is rate limited (5/min per user): one login per user for the whole file.
const tokens = new Map<string, { authorization: string }>();
async function token(_app: unknown, organizationId: string, email: string): Promise<{ authorization: string }> {
  const cached = tokens.get(email);
  if (cached) return cached;
  const auth = buildApi({ pool });
  const response = await auth.inject({ method: "POST", url: "/auth/login", payload: { organizationId, email, password } });
  await auth.close();
  const value = { authorization: `Bearer ${response.json().token}` };
  tokens.set(email, value);
  return value;
}
const intakeOrders = async (project: string) =>
  (await pool.query("SELECT count(*)::int AS n FROM orders WHERE project_id=$1 AND work_type='SYSTEM_INTAKE'", [project])).rows[0].n as number;

beforeAll(async () => {
  await migrate(pool);
  const hash = hashPassword(password);
  for (const [org, name] of [[orgA, "WO Routes A"], [orgB, "WO Routes B"]] as const) {
    await pool.query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [org, name]);
  }
  const users: [string, string, string, string][] = [
    [ids.admin, orgA, "wo-admin@test.local", "ADMIN"], [ids.dev, orgA, "wo-dev@test.local", "DEVELOPER"],
    [ids.devNoMember, orgA, "wo-dev2@test.local", "DEVELOPER"], [ids.auditor, orgA, "wo-auditor@test.local", "AUDITOR"],
    [ids.client, orgA, "wo-client@test.local", "CLIENT"], [ids.otherAdmin, orgB, "wo-other@test.local", "ADMIN"]
  ];
  for (const [id, org, email, role] of users) {
    await pool.query(
      "INSERT INTO users (id, organization_id, email, display_name, role, password_hash) VALUES ($1,$2,$3,'U',$4,$5)",
      [id, org, email, role, hash]
    );
  }
  for (const [project, org] of [[projectA, orgA], [projectB, orgA], [projectOther, orgB]] as const) {
    await pool.query("INSERT INTO projects (id, organization_id, name) VALUES ($1,$2,'P')", [project, org]);
  }
  await pool.query(
    `INSERT INTO repositories (id, project_id, full_name, role, primary_repository, default_branch, staging_branch)
     VALUES ($1,$2,'novo34/wo-routes','backend',TRUE,'main','staging')`, [randomUUID(), projectA]);
  for (const [user, role] of [[ids.dev, "DEVELOPER"], [ids.auditor, "AUDITOR"], [ids.client, "CLIENT"]] as const) {
    await pool.query("INSERT INTO project_memberships (project_id, user_id, role) VALUES ($1,$2,$3)", [projectA, user, role]);
  }
});
afterAll(async () => { await pool.end(); });

describe("POST /projects/:id/work-orders", () => {
  const url = `/projects/${projectA}/work-orders`;
  const payload = { objective: "Replace the hero image" };
  const withForgedAuthor = { ...payload, authorUserId: ids.admin };

  it("requires authentication and write permission on the project", async () => {
    const gateway = fakeGateway([]);
    const app = apiWith(gateway);
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
    for (const email of ["wo-auditor@test.local", "wo-client@test.local", "wo-dev2@test.local"]) {
      const response = await app.inject({ method: "POST", url, payload, headers: await token(app, orgA, email) });
      expect(response.statusCode, email).toBe(403);
    }
    const other = await app.inject({ method: "POST", url, payload, headers: await token(app, orgB, "wo-other@test.local") });
    expect(other.statusCode).toBe(403);
    expect(gateway.requests).toHaveLength(0);
    expect(await intakeOrders(projectA)).toBe(0);
    await app.close();
  });

  it("fails safe without a configured model: 503, nothing created, no call", async () => {
    const app = apiWith(undefined, {}); // no JEV_INTENT_MODEL, no pricing, no keys
    const headers = await token(app, orgA, "wo-admin@test.local");
    const response = await app.inject({ method: "POST", url, payload, headers });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("INTENT_MODEL_NOT_CONFIGURED");
    expect(await intakeOrders(projectA)).toBe(0);
    await app.close();
  });

  it("fails safe with a model but no pricing or secrets (real gateway is never reached)", async () => {
    const app = apiWith(undefined, { JEV_INTENT_MODEL: "anthropic:some-model" });
    const headers = await token(app, orgA, "wo-admin@test.local");
    const noPricing = await app.inject({ method: "POST", url, payload, headers });
    expect(noPricing.statusCode).toBe(503);
    expect(noPricing.json().error).toBe("PRICING_REQUIRED");
    await app.close();
    const priced = {
      JEV_INTENT_MODEL: "anthropic:some-model",
      JEV_MODEL_PRICING_JSON: JSON.stringify({ "anthropic:some-model": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 1 } })
    };
    const app2 = apiWith(undefined, priced);
    const headers2 = await token(app2, orgA, "wo-admin@test.local");
    const response = await app2.inject({ method: "POST", url, payload, headers: headers2 });
    expect(response.statusCode).toBe(503);
    expect(["PRICING_REQUIRED", "INTENT_GATEWAY_NOT_CONFIGURED"]).toContain(response.json().error);
    expect(await intakeOrders(projectA)).toBe(0);
    await app2.close();
  });

  it("validates the body strictly (extra fields, reserved work type)", async () => {
    const app = apiWith(fakeGateway([]));
    const headers = await token(app, orgA, "wo-admin@test.local");
    expect((await app.inject({ method: "POST", url, payload: {}, headers })).statusCode).toBe(400);
    // Unknown body fields (e.g. authorUserId) are dropped by the schema, never trusted: the author is the session user (see happy path).
    expect((await app.inject({ method: "POST", url, payload: { ...payload, workType: "SYSTEM_INTAKE" }, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/projects/not-a-uuid/work-orders", payload, headers })).statusCode).toBe(400);
    await app.close();
  });

  it("happy path: generated brief + contract, billed to the intake task, intake reused", async () => {
    const gateway = fakeGateway([JSON.stringify(brief()), JSON.stringify(contract), JSON.stringify(brief()), JSON.stringify(contract)]);
    const app = apiWith(gateway);
    const headers = await token(app, orgA, "wo-dev@test.local");
    const response = await app.inject({ method: "POST", url, payload: withForgedAuthor, headers });
    expect(response.statusCode).toBe(201);
    const order = response.json().order;
    expect(order).toMatchObject({ objective: payload.objective, authorUserId: ids.dev, status: "PLANNED" });
    expect(order.acceptanceContract.intentId).toBe(order.intent.id);
    expect(gateway.requests.map((r) => r.agentRole)).toEqual(["intent-brief-generator", "acceptance-contract-generator"]);
    const intake = (await pool.query(
      "SELECT o.id AS order_id, t.id AS task_id FROM orders o JOIN tasks t ON t.order_id=o.id WHERE o.project_id=$1 AND o.work_type='SYSTEM_INTAKE'", [projectA])).rows;
    expect(intake).toHaveLength(1);
    for (const request of gateway.requests) {
      expect(request).toMatchObject({ projectId: projectA, organizationId: orgA, taskId: intake[0].task_id, orderId: intake[0].order_id, maxRetries: 0 });
    }
    const second = await app.inject({ method: "POST", url, payload: { objective: "Another" }, headers });
    expect(second.statusCode).toBe(201);
    expect(await intakeOrders(projectA)).toBe(1);
    await app.close();
  });

  it("maps generation and gateway failures without creating the order", async () => {
    const objective = `Failing ${randomUUID()}`;
    const bad = apiWith(fakeGateway(["nope", "nope"]));
    const headers = await token(bad, orgA, "wo-admin@test.local");
    const invalid = await bad.inject({ method: "POST", url, payload: { objective }, headers });
    expect(invalid.statusCode).toBe(502);
    expect(invalid.json().error).toBe("INTENT_GENERATION_FAILED");
    await bad.close();
    const blocked = apiWith(fakeGateway([new ModelGatewayError("PRICING_REQUIRED", "secret details")]));
    const response = await blocked.inject({ method: "POST", url, payload: { objective }, headers });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "PRICING_REQUIRED" });
    await blocked.close();
    expect((await pool.query("SELECT count(*)::int AS n FROM orders WHERE objective=$1", [objective])).rows[0].n).toBe(0);
  });

  it("a project without repository fails clearly", async () => {
    const app = apiWith(fakeGateway([]));
    const headers = await token(app, orgA, "wo-admin@test.local");
    const response = await app.inject({ method: "POST", url: `/projects/${projectB}/work-orders`, payload, headers });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("REPOSITORY_NOT_FOUND");
    await app.close();
  });
});

describe("tasks and re-evaluation routes", () => {
  async function orderWith(document: Record<string, unknown>, project = projectA, org = orgA): Promise<string> {
    const order = (await pool.query("INSERT INTO orders (project_id, objective) VALUES ($1,'Routes order') RETURNING id", [project])).rows[0].id as string;
    await intents.saveIntentBrief(org, { orderId: order, document });
    return order;
  }

  it("requires authentication and write permission", async () => {
    const app = apiWith();
    const order = await orderWith(brief());
    for (const suffix of ["tasks", "reevaluate-blocked-tasks"]) {
      const url = `/projects/${projectA}/orders/${order}/${suffix}`;
      const payload = suffix === "tasks" ? { title: "T" } : undefined;
      expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url, payload, headers: await token(app, orgA, "wo-auditor@test.local") })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url, payload, headers: await token(app, orgB, "wo-other@test.local") })).statusCode).toBe(403);
    }
    await app.close();
  });

  it("creates a task (no gateway or model needed) and applies the R2 minimum when blocked", async () => {
    const app = apiWith(); // no model configured: these routes never need it
    const headers = await token(app, orgA, "wo-dev@test.local");
    const clear = await orderWith(brief());
    const ok = await app.inject({ method: "POST", url: `/projects/${projectA}/orders/${clear}/tasks`, payload: { title: "Do it", risk: "R1" }, headers });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().task).toMatchObject({ status: "PLANNED", risk: "R1" });
    const ambiguous = await orderWith(brief({ ambiguity_score: 0.9, clarification_required: true, open_questions: ["Which page?"] }));
    const blocked = await app.inject({ method: "POST", url: `/projects/${projectA}/orders/${ambiguous}/tasks`, payload: { title: "Do it" }, headers });
    expect(blocked.statusCode).toBe(201);
    expect(blocked.json().task).toMatchObject({ status: "BLOCKED", risk: "R2" });
    expect(blocked.json().task.implementationBlock.code).toBe("AMBIGUOUS_INTENT");
    await app.close();
  });

  it("rejects bad input, foreign orders and the intake order", async () => {
    const app = apiWith();
    const headers = await token(app, orgA, "wo-admin@test.local");
    const order = await orderWith(brief());
    const base = `/projects/${projectA}/orders`;
    expect((await app.inject({ method: "POST", url: `${base}/${order}/tasks`, payload: {}, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${base}/${order}/tasks`, payload: { title: "T", risk: "R9" }, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${base}/${randomUUID()}/tasks`, payload: { title: "T" }, headers })).statusCode).toBe(404);
    const foreign = await pool.query("INSERT INTO orders (project_id, objective) VALUES ($1,'Foreign') RETURNING id", [projectB]);
    const crossed = await app.inject({ method: "POST", url: `${base}/${foreign.rows[0].id}/tasks`, payload: { title: "T" }, headers });
    expect(crossed.statusCode).toBe(404);
    const intake = (await pool.query("SELECT id FROM orders WHERE project_id=$1 AND work_type='SYSTEM_INTAKE'", [projectA])).rows[0]?.id;
    if (intake) {
      const response = await app.inject({ method: "POST", url: `${base}/${intake}/tasks`, payload: { title: "T" }, headers });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });

  it("reevaluates blocked tasks: stays blocked, then unblocks after a clarified brief", async () => {
    const app = apiWith();
    const headers = await token(app, orgA, "wo-admin@test.local");
    const order = await orderWith(brief({ ambiguity_score: 0.9, clarification_required: true, open_questions: ["Which page?"] }));
    const created = await app.inject({ method: "POST", url: `/projects/${projectA}/orders/${order}/tasks`, payload: { title: "T" }, headers });
    const taskId = created.json().task.id;
    const url = `/projects/${projectA}/orders/${order}/reevaluate-blocked-tasks`;
    const still = await app.inject({ method: "POST", url, headers });
    expect(still.statusCode).toBe(200);
    expect(still.json().result).toMatchObject({ stillBlocked: true, unblockedTaskIds: [] });
    await intents.saveIntentBrief(orgA, { orderId: order, document: brief() });
    const done = await app.inject({ method: "POST", url, headers });
    expect(done.json().result).toMatchObject({ stillBlocked: false, unblockedTaskIds: [taskId] });
    const again = await app.inject({ method: "POST", url, headers });
    expect(again.json().result.unblockedTaskIds).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/projects/${projectA}/orders/${randomUUID()}/reevaluate-blocked-tasks`, headers })).statusCode).toBe(404);
    await app.close();
  });
});
