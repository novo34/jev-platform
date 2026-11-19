import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import {
  ModelGatewayError,
  buildPrompt,
  deriveTenantNamespace,
  type ModelGatewayRequest,
  type ModelGatewayResult
} from "@jev/model-gateway";
import {
  IntentAcceptanceService,
  IntentBriefGenerator,
  IntentGenerationError,
  WorkOrderService,
  buildIntentSegments,
  parseIntentModelTargets,
  type IntentModelGateway
} from "./index.js";

// No test here touches the network: the gateway is a fake.
const pool = createDatabasePool();
const intents = new IntentAcceptanceService(pool);
const organizationId = randomUUID();
const projectId = randomUUID();
const repositoryId = randomUUID();
const TARGETS = [{ provider: "anthropic" as const, model: "fake-model" }];

const doc = (overrides: Record<string, unknown> = {}) => ({
  goal: "Replace hero image",
  requested_change: "Swap the hero image",
  in_scope: ["hero"],
  out_of_scope: [],
  observed_context: [],
  assumptions: [],
  open_questions: [],
  ambiguity_score: 0.1,
  change_radius: "LOCAL",
  risk_signals: [],
  documentation_depth: "L0",
  clarification_required: false,
  evidence_needed: [],
  ...overrides
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
        attempts: 1, latencyMs: 1, estimatedCostChf: 0,
        usage: {} as ModelGatewayResult["usage"]
      };
    }
  };
}

function setup(steps: Step[]) {
  const gateway = fakeGateway(steps);
  const generator = new IntentBriefGenerator({ gateway, targets: TARGETS, newRequestId: () => "req" });
  const service = new WorkOrderService(pool, undefined, { intentService: intents, intentGenerator: generator, ambiguityThreshold: 0.5 });
  return { gateway, service };
}

const countOrders = async (objective: string) =>
  (await pool.query("SELECT count(*)::int AS n FROM orders WHERE objective = $1", [objective])).rows[0].n as number;
const uniq = () => `Generated intent ${randomUUID()}`;
const taskId = randomUUID(); // opaque to the fake gateway

beforeAll(async () => {
  await migrate(pool);
  await pool.query("INSERT INTO organizations (id, name) VALUES ($1, 'Gen Org')", [organizationId]);
  await pool.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Gen Project')", [projectId, organizationId]);
  await pool.query(
    `INSERT INTO repositories (id, project_id, full_name, role, primary_repository, default_branch, staging_branch)
     VALUES ($1, $2, 'novo34/gen', 'backend', TRUE, 'main', 'staging')`,
    [repositoryId, projectId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("createOrderWithGeneratedIntent", () => {
  it("creates the order with the generated brief", async () => {
    const objective = uniq();
    const { service, gateway } = setup([JSON.stringify(doc())]);
    const order = await service.createOrderWithGeneratedIntent({ projectId, objective }, taskId);
    expect(order.intent?.brief.document.goal).toBe("Replace hero image");
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]).toMatchObject({ maxRetries: 0, organizationId, projectId, taskId, targets: TARGETS });
    expect(gateway.requests[0].prompt).toBeUndefined();
  });

  it("retries once with the validation error when the JSON is invalid", async () => {
    const objective = uniq();
    const { service, gateway } = setup(["not json at all", JSON.stringify(doc())]);
    const order = await service.createOrderWithGeneratedIntent({ projectId, objective }, taskId);
    expect(order.intent).toBeDefined();
    expect(gateway.requests).toHaveLength(2);
    const retryInput = gateway.requests[1].segments!.find((s) => s.kind === "input")!.content;
    expect(retryInput).toContain("not valid JSON");
    expect(gateway.requests[0].requestId).not.toBe(gateway.requests[1].requestId);
  });

  it("retries on schema-invalid JSON (extra field) and fails after two invalid answers", async () => {
    const objective = uniq();
    const bad = JSON.stringify(doc({ invented: true }));
    const { service, gateway } = setup([bad, bad]);
    const error = await service.createOrderWithGeneratedIntent({ projectId, objective }, taskId).catch((e) => e);
    expect(error).toBeInstanceOf(IntentGenerationError);
    expect(error.code).toBe("INTENT_GENERATION_FAILED");
    expect(gateway.requests).toHaveLength(2);
    expect(await countOrders(objective)).toBe(0);
  });

  it("rejects code-fenced JSON (strict parsing)", async () => {
    const { service } = setup(["```json\n" + JSON.stringify(doc()) + "\n```", "```json\n{}\n```"]);
    await expect(service.createOrderWithGeneratedIntent({ projectId, objective: uniq() }, taskId))
      .rejects.toMatchObject({ code: "INTENT_GENERATION_FAILED" });
  });

  it("high ambiguity creates the order and the task is BLOCKED (PR 2)", async () => {
    const objective = uniq();
    const { service } = setup([JSON.stringify(doc({
      ambiguity_score: 0.9, clarification_required: true, open_questions: ["Which page?"]
    }))]);
    const order = await service.createOrderWithGeneratedIntent({ projectId, objective }, taskId);
    expect(await countOrders(objective)).toBe(1);
    const task = await service.createTask({ projectId, orderId: order.id, title: "Do it" });
    expect(task.status).toBe("BLOCKED");
    expect(task.implementationBlock?.code).toBe("AMBIGUOUS_INTENT");
  });

  it("propagates a gateway BLOCKED/PRICING_REQUIRED without retrying or creating", async () => {
    const objective = uniq();
    const { service, gateway } = setup([new ModelGatewayError("PRICING_REQUIRED", "rate missing")]);
    await expect(service.createOrderWithGeneratedIntent({ projectId, objective }, taskId))
      .rejects.toMatchObject({ code: "PRICING_REQUIRED" });
    expect(gateway.requests).toHaveLength(1);
    expect(await countOrders(objective)).toBe(0);
  });

  it("requires a generator and a configured model", async () => {
    const plain = new WorkOrderService(pool, undefined, { intentService: intents });
    await expect(plain.createOrderWithGeneratedIntent({ projectId, objective: uniq() }, taskId))
      .rejects.toMatchObject({ code: "INVALID_ORDER" });
    const previous = process.env.JEV_INTENT_MODEL;
    delete process.env.JEV_INTENT_MODEL;
    try {
      const noModel = new IntentBriefGenerator({ gateway: fakeGateway([]) });
      await expect(noModel.generate({ objective: "x", organizationId, projectId, taskId }))
        .rejects.toMatchObject({ code: "INTENT_MODEL_NOT_CONFIGURED" });
    } finally {
      if (previous !== undefined) process.env.JEV_INTENT_MODEL = previous;
    }
  });
});

describe("generated intent input and prerequisites", () => {
  it("without intentService fails before calling the model and creates nothing", async () => {
    const gateway = fakeGateway([JSON.stringify(doc())]);
    const generator = new IntentBriefGenerator({ gateway, targets: TARGETS });
    const svc = new WorkOrderService(pool, undefined, { intentGenerator: generator });
    const objective = uniq();
    await expect(svc.createOrderWithGeneratedIntent({ projectId, objective }, taskId))
      .rejects.toMatchObject({ code: "INVALID_ORDER" });
    expect(gateway.requests).toHaveLength(0);
    expect(await countOrders(objective)).toBe(0);
  });

  it("sends requirement descriptions, constraints and criteria to the model; prefix stays stable", async () => {
    const tenant = deriveTenantNamespace("secret", "org", "proj");
    const { service, gateway } = setup([JSON.stringify(doc()), JSON.stringify(doc())]);
    await service.createOrderWithGeneratedIntent({
      projectId, objective: uniq(),
      requirements: [{ key: "R1", title: "Hero", description: "DESC-MARKER-123" }],
      constraints: ["CONSTRAINT-MARKER-456"],
      acceptanceCriteria: ["CRITERIA-MARKER-789"]
    }, taskId);
    await service.createOrderWithGeneratedIntent({ projectId, objective: uniq() }, taskId);
    const first = buildPrompt(gateway.requests[0].segments!, undefined, tenant);
    const second = buildPrompt(gateway.requests[1].segments!, undefined, tenant);
    for (const marker of ["DESC-MARKER-123", "CONSTRAINT-MARKER-456", "CRITERIA-MARKER-789"]) {
      expect(first.text).toContain(marker);
    }
    expect(first.prefix_project_sha256).toBe(second.prefix_project_sha256);
    expect(first.text).not.toBe(second.text);
  });
});

describe("prompt and configuration", () => {
  const tenant = deriveTenantNamespace("secret", "org", "proj");
  const input = { objective: "Do X", projectName: "P", knownRequirements: ["R1: a"] };

  it("is deterministic: same input gives the same prompt and prefix hash", () => {
    const a = buildPrompt(buildIntentSegments(input), undefined, tenant);
    const b = buildPrompt(buildIntentSegments({ ...input }), undefined, tenant);
    expect(a.text).toBe(b.text);
    expect(a.prefix_project_sha256).toBe(b.prefix_project_sha256);
    expect(a.warnings).toEqual([]);
  });

  it("keeps the stable prefix across different objectives and retries", () => {
    const a = buildPrompt(buildIntentSegments(input), undefined, tenant);
    const b = buildPrompt(buildIntentSegments({ ...input, objective: "Other" },
      { previousOutput: "x", validationError: "y" }), undefined, tenant);
    expect(a.prefix_project_sha256).toBe(b.prefix_project_sha256);
    expect(a.text).not.toBe(b.text);
    expect(a.blocks.at(-1)!.kind).toBe("input");
  });

  it("states the anti-silence rule", () => {
    const text = buildPrompt(buildIntentSegments(input), undefined, tenant).text;
    expect(text).toContain("DECLARE the ambiguity");
    expect(text).toContain("clarification_required");
  });

  it("parses JEV_INTENT_MODEL targets", () => {
    expect(parseIntentModelTargets("anthropic:m1, openai:m2")).toEqual([
      { provider: "anthropic", model: "m1" }, { provider: "openai", model: "m2" }
    ]);
    expect(() => parseIntentModelTargets("bogus:m")).toThrow(IntentGenerationError);
    expect(() => parseIntentModelTargets("")).toThrow(IntentGenerationError);
  });
});
