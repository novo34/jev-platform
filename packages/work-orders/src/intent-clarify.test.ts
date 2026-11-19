import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import {
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
  buildClarifySegments,
  type IntentModelGateway
} from "./index.js";

// PLT-040 PR 5. No test touches the network: the gateway is a fake.
const pool = createDatabasePool();
const intents = new IntentAcceptanceService(pool);
const organizationId = randomUUID();
const projectId = randomUUID();
const repositoryId = randomUUID();
const taskId = randomUUID();
const TARGETS = [{ provider: "anthropic" as const, model: "fake-model" }];

const doc = (overrides: Record<string, unknown> = {}) => ({
  goal: "Replace hero image", requested_change: "Swap the hero image",
  in_scope: ["hero"], out_of_scope: [], observed_context: [], assumptions: [],
  open_questions: [], ambiguity_score: 0.1, change_radius: "LOCAL", risk_signals: [],
  documentation_depth: "L0", clarification_required: false, evidence_needed: [],
  ...overrides
});
const ambiguous = (extra: Record<string, unknown> = {}) =>
  JSON.stringify(doc({ ambiguity_score: 0.9, clarification_required: true, open_questions: ["Which page?"], ...extra }));
const clear = JSON.stringify(doc({ assumptions: ["Page is /home (stated in requirement R1)"] }));

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
function setup(steps: Step[], rounds?: number) {
  const gateway = fakeGateway(steps);
  const generator = new IntentBriefGenerator({ gateway, targets: TARGETS, newRequestId: () => "req" });
  const service = new WorkOrderService(pool, undefined, {
    intentService: intents, intentGenerator: generator, ambiguityThreshold: 0.5, intentClarifyRounds: rounds
  });
  return { gateway, service };
}
const uniq = () => `Clarify ${randomUUID()}`;
const versionsOf = async (orderId: string) =>
  (await pool.query("SELECT version, ambiguity_score, clarification_required FROM intent_briefs WHERE order_id=$1 ORDER BY version", [orderId])).rows;
const countOrders = async (objective: string) =>
  (await pool.query("SELECT count(*)::int AS n FROM orders WHERE objective = $1", [objective])).rows[0].n as number;

beforeAll(async () => {
  await migrate(pool);
  await pool.query("INSERT INTO organizations (id, name) VALUES ($1, 'Clarify Org')", [organizationId]);
  await pool.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Clarify Project')", [projectId, organizationId]);
  await pool.query(
    `INSERT INTO repositories (id, project_id, full_name, role, primary_repository, default_branch, staging_branch)
     VALUES ($1, $2, 'novo34/clarify', 'backend', TRUE, 'main', 'staging')`,
    [repositoryId, projectId]
  );
});
afterAll(async () => { await pool.end(); });

describe("automatic clarification rounds", () => {
  it("resolves the ambiguity from context: final version not blocking, task PLANNED (E2E)", async () => {
    const { service, gateway } = setup([ambiguous(), clear]);
    const order = await service.createOrderWithGeneratedIntent({
      projectId, objective: uniq(),
      requirements: [{ key: `R-${randomUUID()}`, title: "Page", description: "The hero lives on /home" }]
    }, taskId);
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[1]).toMatchObject({ maxRetries: 0, agentRole: "intent-brief-clarifier" });
    expect(order.intent?.version).toBe(2);
    expect(order.intent?.brief.document.clarification_required).toBe(false);
    const versions = await versionsOf(order.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0].clarification_required).toBe(true);
    const task = await service.createTask({ projectId, orderId: order.id, title: "Do it" });
    expect(task.status).toBe("PLANNED");
    expect(task.implementationBlock).toBeUndefined();
  });

  it("keeps the ambiguity when the model cannot resolve it: last version saved, task BLOCKED", async () => {
    const { service, gateway } = setup([ambiguous(), ambiguous({ ambiguity_score: 0.8 })]);
    const order = await service.createOrderWithGeneratedIntent({ projectId, objective: uniq() }, taskId);
    expect(gateway.requests).toHaveLength(2);
    expect(order.intent?.version).toBe(2);
    expect(order.intent?.brief.ambiguityScore).toBe(0.8);
    const task = await service.createTask({ projectId, orderId: order.id, title: "Do it" });
    expect(task.status).toBe("BLOCKED");
    expect(task.implementationBlock?.code).toBe("AMBIGUOUS_INTENT");
    expect(task.implementationBlock?.intentVersion).toBe(2);
  });

  it("rounds = 0 makes no extra call and stores one version", async () => {
    const { service, gateway } = setup([ambiguous()], 0);
    const order = await service.createOrderWithGeneratedIntent({ projectId, objective: uniq() }, taskId);
    expect(gateway.requests).toHaveLength(1);
    expect(await versionsOf(order.id)).toHaveLength(1);
  });

  it("does not clarify when the first brief is not blocking", async () => {
    const { service, gateway } = setup([JSON.stringify(doc())], 3);
    await service.createOrderWithGeneratedIntent({ projectId, objective: uniq() }, taskId);
    expect(gateway.requests).toHaveLength(1);
  });

  it("respects N as a cap (rounds=2: 1 generate + 2 clarify) and stops early when resolved", async () => {
    const capped = setup([ambiguous(), ambiguous(), ambiguous(), clear], 2);
    const order = await capped.service.createOrderWithGeneratedIntent({ projectId, objective: uniq() }, taskId);
    expect(capped.gateway.requests).toHaveLength(3);
    expect(order.intent?.version).toBe(3);
    const early = setup([ambiguous(), clear, clear], 3);
    const order2 = await early.service.createOrderWithGeneratedIntent({ projectId, objective: uniq() }, taskId);
    expect(early.gateway.requests).toHaveLength(2);
    expect(order2.intent?.version).toBe(2);
  });

  it("invalid JSON in clarification: one retry, then typed error and no orphan order", async () => {
    const objective = uniq();
    const failing = setup([ambiguous(), "nope", "still nope"]);
    const error = await failing.service.createOrderWithGeneratedIntent({ projectId, objective }, taskId).catch((e) => e);
    expect(error).toBeInstanceOf(IntentGenerationError);
    expect(error.code).toBe("INTENT_GENERATION_FAILED");
    expect(failing.gateway.requests).toHaveLength(3);
    expect(await countOrders(objective)).toBe(0);
    const recovering = setup([ambiguous(), "nope", clear]);
    const order = await recovering.service.createOrderWithGeneratedIntent({ projectId, objective: uniq() }, taskId);
    expect(recovering.gateway.requests).toHaveLength(3);
    expect(recovering.gateway.requests[2].segments!.find((s) => s.kind === "input")!.content).toContain("not valid JSON");
    expect(order.intent?.version).toBe(2);
  });

  it("clarification prompt carries context and keeps a stable prefix", async () => {
    const tenant = deriveTenantNamespace("secret", "org", "proj");
    const { service, gateway } = setup([ambiguous(), clear, ambiguous(), clear]);
    await service.createOrderWithGeneratedIntent({
      projectId, objective: uniq(),
      requirements: [{ key: `R-${randomUUID()}`, title: "Hero", description: "DESC-MARKER-1" }],
      constraints: ["CONSTRAINT-MARKER-2"], acceptanceCriteria: ["CRITERIA-MARKER-3"]
    }, taskId);
    await service.createOrderWithGeneratedIntent({ projectId, objective: uniq() }, taskId);
    const first = buildPrompt(gateway.requests[1].segments!, undefined, tenant);
    const second = buildPrompt(gateway.requests[3].segments!, undefined, tenant);
    for (const marker of ["DESC-MARKER-1", "CONSTRAINT-MARKER-2", "CRITERIA-MARKER-3", "Which page?", "Clarify Project", "Anti-invention rule"]) {
      expect(first.text).toContain(marker);
    }
    expect(first.prefix_project_sha256).toBe(second.prefix_project_sha256);
    expect(first.blocks.at(-1)!.kind).toBe("input");
    expect(first.warnings).toEqual([]);
  });

  it("buildClarifySegments is deterministic", () => {
    const tenant = deriveTenantNamespace("secret", "org", "proj");
    const input = { objective: "X", brief: doc() as never, projectName: "P" };
    expect(buildPrompt(buildClarifySegments(input), undefined, tenant).text)
      .toBe(buildPrompt(buildClarifySegments({ ...input }), undefined, tenant).text);
  });

  it("validates the rounds option and JEV_INTENT_CLARIFY_ROUNDS", () => {
    for (const bad of [-1, 4, 1.5, Number.NaN]) {
      expect(() => new WorkOrderService(pool, undefined, { intentClarifyRounds: bad })).toThrow(RangeError);
    }
    expect(() => new WorkOrderService(pool, undefined, { intentClarifyRounds: 0 })).not.toThrow();
    const previous = process.env.JEV_INTENT_CLARIFY_ROUNDS;
    try {
      process.env.JEV_INTENT_CLARIFY_ROUNDS = "9";
      expect(() => new WorkOrderService(pool)).toThrow(RangeError);
      process.env.JEV_INTENT_CLARIFY_ROUNDS = "2";
      expect(() => new WorkOrderService(pool)).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.JEV_INTENT_CLARIFY_ROUNDS;
      else process.env.JEV_INTENT_CLARIFY_ROUNDS = previous;
    }
  });
});

describe("reevaluateBlockedTasks", () => {
  const service = new WorkOrderService(pool, undefined, { intentService: intents, ambiguityThreshold: 0.5 });
  const newOrder = async () =>
    (await pool.query("INSERT INTO orders (project_id, objective) VALUES ($1, 'Reeval') RETURNING id", [projectId])).rows[0].id as string;
  const save = (orderId: string, overrides: Record<string, unknown>) =>
    intents.saveIntentBrief(organizationId, { orderId, document: doc(overrides) });

  it("unblocks only AMBIGUOUS_INTENT tasks, is idempotent, and leaves other BLOCKED tasks", async () => {
    const order = await newOrder();
    await save(order, { ambiguity_score: 0.9, clarification_required: true });
    const ambiguousTask = await service.createTask({ projectId, orderId: order, title: "A" });
    const other = await service.createTask({ projectId, orderId: order, title: "B" });
    // other is blocked for a different cause: re-block it manually with different evidence.
    await service.transitionTask(other.id, "READY", { actorType: "SYSTEM", cause: "manual" });
    await service.transitionTask(other.id, "BLOCKED", { actorType: "SYSTEM", cause: "dependency", evidence: { code: "DEPENDENCY" } });
    expect(ambiguousTask.status).toBe("BLOCKED");

    // Latest version still blocks: nothing changes.
    const same = await service.reevaluateBlockedTasks(order);
    expect(same).toMatchObject({ stillBlocked: true, unblockedTaskIds: [] });
    expect((await service.getTask(ambiguousTask.id)).status).toBe("BLOCKED");

    // A new version alone does not unblock (explicit method only).
    const v2 = await save(order, { ambiguity_score: 0.1 });
    expect((await service.getTask(ambiguousTask.id)).status).toBe("BLOCKED");

    const result = await service.reevaluateBlockedTasks(order);
    expect(result).toMatchObject({ stillBlocked: false, intentId: v2.id, intentVersion: 2, unblockedTaskIds: [ambiguousTask.id] });
    const after = await service.getTask(ambiguousTask.id);
    expect(after.status).toBe("READY");
    const last = after.stateHistory[after.stateHistory.length - 1];
    expect(last).toMatchObject({ fromStatus: "BLOCKED", toStatus: "READY", actorType: "SYSTEM" });
    expect(last.evidence).toMatchObject({ intent_id: v2.id, intent_version: 2, previous_intent_version: 1 });
    expect((await service.getTask(other.id)).status).toBe("BLOCKED");

    const again = await service.reevaluateBlockedTasks(order);
    expect(again.unblockedTaskIds).toEqual([]);
    expect((await service.getTask(ambiguousTask.id)).stateHistory).toHaveLength(after.stateHistory.length);
  });

  it("does nothing when the order has no IntentBrief, requires intentService, rejects unknown order", async () => {
    const order = await newOrder();
    expect(await service.reevaluateBlockedTasks(order)).toMatchObject({ stillBlocked: true, intentId: null });
    await expect(new WorkOrderService(pool).reevaluateBlockedTasks(order)).rejects.toMatchObject({ code: "INVALID_ORDER" });
    await expect(service.reevaluateBlockedTasks(randomUUID())).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });
});
