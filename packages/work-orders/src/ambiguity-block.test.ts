import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { IntentAcceptanceService, WorkOrderService } from "./index.js";

const pool = createDatabasePool();
const intents = new IntentAcceptanceService(pool);
const service = new WorkOrderService(pool, undefined, { intentService: intents, ambiguityThreshold: 0.5 });
const organizationId = randomUUID();
const projectId = randomUUID();
const repositoryId = randomUUID();

const intentDoc = (overrides: Record<string, unknown> = {}) => ({
  goal: "Change a local UI element safely",
  requested_change: "Replace hero image",
  in_scope: ["hero image"],
  out_of_scope: ["layout redesign"],
  observed_context: ["existing hero component"],
  assumptions: [],
  open_questions: [],
  ambiguity_score: 0.1,
  change_radius: "LOCAL",
  risk_signals: [],
  documentation_depth: "L0",
  clarification_required: false,
  evidence_needed: ["browser_runtime_evidence"],
  ...overrides
});

async function newOrder(legacy = false): Promise<string> {
  const result = await pool.query(
    "INSERT INTO orders (project_id, objective, intent_legacy) VALUES ($1, 'Ambiguity', $2) RETURNING id",
    [projectId, legacy]
  );
  return result.rows[0].id as string;
}

const task = (orderId: string, svc: WorkOrderService = service) =>
  svc.createTask({ projectId, orderId, title: "Do it" });

beforeAll(async () => {
  await migrate(pool);
  await pool.query("INSERT INTO organizations (id, name) VALUES ($1, 'Ambiguity Org')", [organizationId]);
  await pool.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Ambiguity Project')", [projectId, organizationId]);
  await pool.query(
    `INSERT INTO repositories (id, project_id, full_name, role, primary_repository, default_branch, staging_branch)
     VALUES ($1, $2, 'novo34/ambiguity', 'backend', TRUE, 'main', 'staging')`,
    [repositoryId, projectId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("createTask material ambiguity gate", () => {
  it("keeps PLANNED when the order has no IntentBrief", async () => {
    const created = await task(await newOrder());
    expect(created.status).toBe("PLANNED");
    expect(created.implementationBlock).toBeUndefined();
  });

  it("keeps PLANNED below the threshold with no clarification required", async () => {
    const order = await newOrder();
    await intents.saveIntentBrief(organizationId, { orderId: order, document: intentDoc({ ambiguity_score: 0.49 }) });
    expect((await task(order)).status).toBe("PLANNED");
  });

  it("blocks at the threshold and records a SYSTEM history entry", async () => {
    const order = await newOrder();
    const intent = await intents.saveIntentBrief(organizationId, { orderId: order, document: intentDoc({ ambiguity_score: 0.5 }) });
    const created = await task(order);
    expect(created.status).toBe("BLOCKED");
    expect(created.risk).toBe("R2"); // SPEC high_ambiguity_intent: minimum R2
    expect(created.implementationBlock).toMatchObject({
      code: "AMBIGUOUS_INTENT", intentId: intent.id, ambiguityScore: 0.5,
      clarificationRequired: false, threshold: 0.5
    });
    const last = created.stateHistory[created.stateHistory.length - 1];
    expect(last).toMatchObject({ fromStatus: "PLANNED", toStatus: "BLOCKED", actorType: "SYSTEM" });
    expect(last.evidence).toMatchObject({ intent_id: intent.id, ambiguity_score: 0.5, clarification_required: false, threshold: 0.5 });
  });

  it("raises the risk of a blocked task to at least R2 and respects a higher one (R0<R1<R2<R3<R4)", async () => {
    const order = await newOrder();
    await intents.saveIntentBrief(organizationId, { orderId: order, document: intentDoc({ ambiguity_score: 0.9 }) });
    const expected = { R0: "R2", R1: "R2", R2: "R2", R3: "R3", R4: "R4" } as const;
    for (const [requested, risk] of Object.entries(expected)) {
      const created = await service.createTask({
        projectId, orderId: order, title: `Risk ${requested}`, risk: requested as keyof typeof expected
      });
      expect(created.status).toBe("BLOCKED");
      expect(created.risk).toBe(risk);
    }
    const defaulted = await task(order);
    expect(defaulted.risk).toBe("R2");
  });

  it("does not raise the risk of a task that is not blocked", async () => {
    const order = await newOrder();
    await intents.saveIntentBrief(organizationId, { orderId: order, document: intentDoc() });
    for (const risk of ["R0", "R1"] as const) {
      const created = await service.createTask({ projectId, orderId: order, title: `Free ${risk}`, risk });
      expect(created).toMatchObject({ status: "PLANNED", risk });
    }
  });

  it("blocks when clarification is required even with a low score", async () => {
    const order = await newOrder();
    await intents.saveIntentBrief(organizationId, { orderId: order, document: intentDoc({ ambiguity_score: 0.1, clarification_required: true }) });
    expect((await task(order)).status).toBe("BLOCKED");
  });

  it("does not block when a later clarified IntentBrief version exists", async () => {
    const order = await newOrder();
    await intents.saveIntentBrief(organizationId, { orderId: order, document: intentDoc({ ambiguity_score: 0.9, clarification_required: true }) });
    expect((await task(order)).status).toBe("BLOCKED");
    await intents.saveIntentBrief(organizationId, { orderId: order, document: intentDoc({ ambiguity_score: 0.1 }) });
    expect((await task(order)).status).toBe("PLANNED");
  });

  it("does not change behaviour for legacy orders", async () => {
    const order = await newOrder(true);
    await intents.saveIntentBrief(organizationId, { orderId: order, document: intentDoc({ ambiguity_score: 0.9, clarification_required: true }) });
    expect((await task(order)).status).toBe("PLANNED");
  });

  it("honours a configurable threshold and validates it", async () => {
    const order = await newOrder();
    await intents.saveIntentBrief(organizationId, { orderId: order, document: intentDoc({ ambiguity_score: 0.3 }) });
    expect((await task(order)).status).toBe("PLANNED");
    const strict = new WorkOrderService(pool, undefined, { intentService: intents, ambiguityThreshold: 0.3 });
    const blocked = await task(order, strict);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.implementationBlock?.threshold).toBe(0.3);
    expect(() => new WorkOrderService(pool, undefined, { ambiguityThreshold: 1.5 })).toThrow(RangeError);
    expect(() => new WorkOrderService(pool, undefined, { ambiguityThreshold: Number.NaN })).toThrow(RangeError);
  });

  it("reads the threshold from JEV_AMBIGUITY_BLOCK_THRESHOLD", () => {
    const previous = process.env.JEV_AMBIGUITY_BLOCK_THRESHOLD;
    try {
      process.env.JEV_AMBIGUITY_BLOCK_THRESHOLD = "2";
      expect(() => new WorkOrderService(pool)).toThrow(RangeError);
      process.env.JEV_AMBIGUITY_BLOCK_THRESHOLD = "0.7";
      expect(() => new WorkOrderService(pool)).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.JEV_AMBIGUITY_BLOCK_THRESHOLD;
      else process.env.JEV_AMBIGUITY_BLOCK_THRESHOLD = previous;
    }
  });

  it("is unchanged without the optional IntentAcceptanceService", async () => {
    const order = await newOrder();
    await intents.saveIntentBrief(organizationId, { orderId: order, document: intentDoc({ ambiguity_score: 0.95, clarification_required: true }) });
    const created = await task(order, new WorkOrderService(pool));
    expect(created.status).toBe("PLANNED");
    expect(created.implementationBlock).toBeUndefined();
  });
});
