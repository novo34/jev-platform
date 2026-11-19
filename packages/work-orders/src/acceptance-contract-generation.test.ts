import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { buildPrompt, deriveTenantNamespace, type ModelGatewayRequest, type ModelGatewayResult } from "@jev/model-gateway";
import {
  CONTRACT_INTENT_ID_PLACEHOLDER,
  INTAKE_WORK_TYPE,
  IntentAcceptanceService,
  IntentBriefGenerator,
  WorkOrderService,
  buildContractSegments,
  type IntentModelGateway
} from "./index.js";

// PLT-040 PR 6 (A and intake task). No network: the gateway is a fake.
const pool = createDatabasePool();
const intents = new IntentAcceptanceService(pool);
const organizationId = randomUUID();
const projectId = randomUUID();
const emptyProjectId = randomUUID();
const taskId = randomUUID(); // opaque to the fake gateway
const TARGETS = [{ provider: "anthropic" as const, model: "fake-model" }];

const brief = (o: Record<string, unknown> = {}) => ({
  goal: "Replace hero image", requested_change: "Swap the hero image", in_scope: ["hero"],
  out_of_scope: ["layout redesign"], observed_context: [], assumptions: [], open_questions: [],
  ambiguity_score: 0.1, change_radius: "LOCAL", risk_signals: [], documentation_depth: "L1",
  clarification_required: false, evidence_needed: ["screenshot"], ...o
});
const contract = (o: Record<string, unknown> = {}) => ({
  intent_id: CONTRACT_INTENT_ID_PLACEHOLDER,
  acceptance_criteria: [{ criterion: "Hero shows the new image", verification: "screenshot of /home" }],
  constraints: ["No layout change"], assumptions: [], non_goals: ["layout redesign"],
  affected_requirements: [], compatibility_requirements: [], required_evidence: ["screenshot"],
  unresolved_decisions: [], specification_depth: "L1", ...o
});

type Step = string | Error;
function fakeGateway(steps: Step[]): IntentModelGateway & { requests: ModelGatewayRequest[] } {
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
function setup(steps: Step[], service?: Partial<{ intentService: IntentAcceptanceService }>) {
  const gateway = fakeGateway(steps);
  const generator = new IntentBriefGenerator({ gateway, targets: TARGETS, newRequestId: () => "req" });
  const svc = new WorkOrderService(pool, undefined, {
    intentService: service?.intentService ?? intents, intentGenerator: generator,
    ambiguityThreshold: 0.5, intentClarifyRounds: 0
  });
  return { gateway, generator, svc };
}
const uniq = () => `Contract ${randomUUID()}`;
const count = async (sql: string, args: unknown[]) => (await pool.query(sql, args)).rows[0].n as number;
const orders = (objective: string) => count("SELECT count(*)::int AS n FROM orders WHERE objective=$1", [objective]);

beforeAll(async () => {
  await migrate(pool);
  await pool.query("INSERT INTO organizations (id, name) VALUES ($1, 'Contract Org')", [organizationId]);
  await pool.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Contract Project'), ($3, $2, 'Empty Project')", [projectId, organizationId, emptyProjectId]);
  await pool.query(
    `INSERT INTO repositories (id, project_id, full_name, role, primary_repository, default_branch, staging_branch)
     VALUES ($1, $2, 'novo34/contract', 'backend', TRUE, 'main', 'staging')`,
    [randomUUID(), projectId]
  );
});
afterAll(async () => { await pool.end(); });

describe("IntentBriefGenerator.generateContract", () => {
  const input = { objective: "Do X", organizationId, projectId, taskId, brief: brief() as never };

  it("returns a validated contract, forces the placeholder intent_id and uses maxRetries 0", async () => {
    const gateway = fakeGateway([JSON.stringify(contract({ intent_id: "model-invented-id" }))]);
    const generator = new IntentBriefGenerator({ gateway, targets: TARGETS });
    const result = await generator.generateContract(input);
    expect(result.document.intent_id).toBe(CONTRACT_INTENT_ID_PLACEHOLDER);
    expect(result.attempts).toBe(1);
    expect(gateway.requests[0]).toMatchObject({ maxRetries: 0, agentRole: "acceptance-contract-generator", targets: TARGETS });
  });

  it("retries once on invalid output and then fails with a typed error", async () => {
    const gateway = fakeGateway(["nope", JSON.stringify(contract())]);
    const ok = await new IntentBriefGenerator({ gateway, targets: TARGETS }).generateContract(input);
    expect(ok.attempts).toBe(2);
    expect(gateway.requests[1].segments!.find((s) => s.kind === "input")!.content).toContain("not valid JSON");
    const bad = JSON.stringify(contract({ invented: true }));
    const gateway2 = fakeGateway([bad, bad]);
    await expect(new IntentBriefGenerator({ gateway: gateway2, targets: TARGETS }).generateContract(input))
      .rejects.toMatchObject({ code: "INTENT_GENERATION_FAILED" });
    expect(gateway2.requests).toHaveLength(2);
    // Schema: at least one acceptance criterion.
    const gateway3 = fakeGateway([JSON.stringify(contract({ acceptance_criteria: [] })), JSON.stringify(contract({ acceptance_criteria: [] }))]);
    await expect(new IntentBriefGenerator({ gateway: gateway3, targets: TARGETS }).generateContract(input))
      .rejects.toMatchObject({ code: "INTENT_GENERATION_FAILED" });
  });

  it("without a configured model fails safe before any call", async () => {
    const previous = process.env.JEV_INTENT_MODEL;
    delete process.env.JEV_INTENT_MODEL;
    try {
      const gateway = fakeGateway([]);
      await expect(new IntentBriefGenerator({ gateway }).generateContract(input))
        .rejects.toMatchObject({ code: "INTENT_MODEL_NOT_CONFIGURED" });
      expect(gateway.requests).toHaveLength(0);
    } finally {
      if (previous !== undefined) process.env.JEV_INTENT_MODEL = previous;
    }
  });

  it("builds a deterministic prompt with a stable prefix and the brief in the volatile input", () => {
    const tenant = deriveTenantNamespace("secret", "org", "proj");
    const a = buildPrompt(buildContractSegments({ objective: "A", projectName: "P", brief: brief() as never }), undefined, tenant);
    const a2 = buildPrompt(buildContractSegments({ objective: "A", projectName: "P", brief: brief() as never }), undefined, tenant);
    const b = buildPrompt(buildContractSegments({ objective: "B", projectName: "P", brief: brief({ goal: "Other" }) as never,
      }, { previousOutput: "x", validationError: "y" }), undefined, tenant);
    expect(a.text).toBe(a2.text);
    expect(a.prefix_project_sha256).toBe(b.prefix_project_sha256);
    expect(a.text).toContain("Replace hero image");
    expect(a.text).toContain("Anti-invention rule");
    expect(a.text).toContain(CONTRACT_INTENT_ID_PLACEHOLDER);
    expect(a.blocks.at(-1)!.kind).toBe("input");
    expect(a.warnings).toEqual([]);
  });
});

describe("createOrderWithGeneratedIntent with contract", () => {
  it("saves order, brief and contract together; the contract points at the stored brief", async () => {
    const objective = uniq();
    const { svc, gateway } = setup([JSON.stringify(brief()), JSON.stringify(contract())]);
    const order = await svc.createOrderWithGeneratedIntent({ projectId, objective }, taskId);
    expect(gateway.requests.map((r) => r.agentRole)).toEqual(["intent-brief-generator", "acceptance-contract-generator"]);
    expect(order.acceptanceContract).toMatchObject({ intentId: order.intent!.id, orderId: order.id, version: 1, specificationDepth: "L1" });
    expect(order.acceptanceContract!.document.intent_id).toBe(order.intent!.id);
    const stored = await intents.getLatestAcceptanceContractForIntent(organizationId, order.intent!.id);
    expect(stored?.id).toBe(order.acceptanceContract!.id);
  });

  it("passes the gateway order id to every call", async () => {
    const orderId = randomUUID();
    const { svc, gateway } = setup([JSON.stringify(brief()), JSON.stringify(contract())]);
    await svc.createOrderWithGeneratedIntent({ projectId, objective: uniq() }, taskId, orderId);
    expect(gateway.requests.every((r) => r.orderId === orderId)).toBe(true);
  });

  it("does not generate a contract when the final brief is blocking (high ambiguity)", async () => {
    const objective = uniq();
    const { svc, gateway } = setup([JSON.stringify(brief({ ambiguity_score: 0.9, clarification_required: true, open_questions: ["Which page?"] }))]);
    const order = await svc.createOrderWithGeneratedIntent({ projectId, objective }, taskId);
    expect(gateway.requests).toHaveLength(1);
    expect(order.acceptanceContract).toBeUndefined();
    expect(await count("SELECT count(*)::int AS n FROM acceptance_contracts WHERE order_id=$1", [order.id])).toBe(0);
  });

  it("a contract generation failure leaves nothing behind", async () => {
    const objective = uniq();
    const { svc, gateway } = setup([JSON.stringify(brief()), "bad", "worse"]);
    await expect(svc.createOrderWithGeneratedIntent({ projectId, objective }, taskId))
      .rejects.toMatchObject({ code: "INTENT_GENERATION_FAILED" });
    expect(gateway.requests).toHaveLength(3);
    expect(await orders(objective)).toBe(0);
  });

  it("a failure saving the contract rolls back the order and every brief version", async () => {
    const objective = uniq();
    class Failing extends IntentAcceptanceService {
      override async saveAcceptanceContract(): Promise<never> { throw new Error("boom inside transaction"); }
    }
    const { svc } = setup([JSON.stringify(brief()), JSON.stringify(contract())], { intentService: new Failing(pool) });
    await expect(svc.createOrderWithGeneratedIntent({ projectId, objective }, taskId)).rejects.toThrow("boom inside transaction");
    expect(await orders(objective)).toBe(0);
    expect(await count(
      "SELECT count(*)::int AS n FROM intent_briefs b WHERE b.document->>'goal' = 'Replace hero image' AND b.order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id=b.order_id)", [])).toBe(0);
  });

  it("saveAcceptanceContract without an executor keeps working (backwards compatible)", async () => {
    const saved = await intents.saveIntentBrief(organizationId, { document: brief() });
    const record = await intents.saveAcceptanceContract(organizationId, { document: contract({ intent_id: saved.id }) });
    expect(record).toMatchObject({ intentId: saved.id, version: 1 });
  });
});

describe("ensureIntakeTask", () => {
  it("creates a marked, non-blocking intake order and task once, idempotently and concurrently", async () => {
    const { svc } = setup([]);
    const results = await Promise.all([svc.ensureIntakeTask(projectId), svc.ensureIntakeTask(projectId), svc.ensureIntakeTask(projectId)]);
    expect(new Set(results.map((r) => r.taskId)).size).toBe(1);
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    expect(await svc.ensureIntakeTask(projectId)).toEqual(results[0]);
    expect(await count("SELECT count(*)::int AS n FROM orders WHERE project_id=$1 AND work_type=$2", [projectId, INTAKE_WORK_TYPE])).toBe(1);
    const task = await pool.query("SELECT status, risk, order_id FROM tasks WHERE id=$1", [results[0].taskId]);
    expect(task.rows[0]).toMatchObject({ status: "PLANNED", risk: "R0", order_id: results[0].orderId });
    const intent = await intents.getLatestIntentBriefForOrder(organizationId, results[0].orderId);
    expect(intent?.ambiguityScore).toBe(0);
    expect(intent?.clarificationRequired).toBe(false);
  });

  it("fails clearly when the project has no repository, creating nothing reusable", async () => {
    const { svc } = setup([]);
    await expect(svc.ensureIntakeTask(emptyProjectId)).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
  });

  it("creates one intake order per project", async () => {
    const { svc } = setup([]);
    const second = randomUUID();
    await pool.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Half')", [second, organizationId]);
    await pool.query(
      `INSERT INTO repositories (id, project_id, full_name, role, primary_repository, default_branch, staging_branch)
       VALUES ($1, $2, 'novo34/half', 'backend', TRUE, 'main', 'staging')`, [randomUUID(), second]);
    await expect(svc.ensureIntakeTask(second)).resolves.toBeDefined();
    expect(await count("SELECT count(*)::int AS n FROM orders WHERE project_id=$1", [second])).toBe(1);
  });
});
