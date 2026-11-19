import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { IntentAcceptanceService, type IntentBriefRecord, WorkOrderError, WorkOrderService } from "./index.js";

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

async function countOrders(objective: string): Promise<number> {
  const r = await pool.query("SELECT count(*)::int AS n FROM orders WHERE objective = $1", [objective]);
  return r.rows[0].n as number;
}

const uniq = () => `Intent order ${randomUUID()}`;

beforeAll(async () => {
  await migrate(pool);
  await pool.query("INSERT INTO organizations (id, name) VALUES ($1, 'Order Intent Org')", [organizationId]);
  await pool.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Order Intent Project')", [projectId, organizationId]);
  await pool.query(
    `INSERT INTO repositories (id, project_id, full_name, role, primary_repository, default_branch, staging_branch)
     VALUES ($1, $2, 'novo34/order-intent', 'backend', TRUE, 'main', 'staging')`,
    [repositoryId, projectId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("createOrder requires an IntentBrief (PLT-040 PR 3)", () => {
  it("rejects a missing intent and creates nothing", async () => {
    const objective = uniq();
    await expect(service.createOrder({ projectId, objective })).rejects.toMatchObject({ code: "INTENT_REQUIRED" });
    expect(await countOrders(objective)).toBe(0);
  });

  it("rejects an invalid intent and creates nothing", async () => {
    const objective = uniq();
    const error = await service
      .createOrder({ projectId, objective, intent: intentDoc({ ambiguity_score: 7, extra: 1 }) })
      .catch((e) => e);
    expect(error).toBeInstanceOf(WorkOrderError);
    expect(error.code).toBe("INVALID_INTENT");
    expect(error.details.length).toBeGreaterThan(0);
    await expect(service.createOrder({ projectId, objective, intent: "text" })).rejects.toMatchObject({ code: "INVALID_INTENT" });
    expect(await countOrders(objective)).toBe(0);
  });

  it("rejects an unknown project without creating anything", async () => {
    await expect(
      service.createOrder({ projectId: randomUUID(), objective: uniq(), intent: intentDoc() })
    ).rejects.toMatchObject({ code: "INVALID_ORDER" });
  });

  it("creates order and IntentBrief together, not legacy", async () => {
    const order = await service.createOrder({ projectId, objective: uniq(), intent: intentDoc() });
    expect(order.intent).toMatchObject({ version: 1 });
    expect(order.intent?.brief).toMatchObject({ orderId: order.id, organizationId });
    const row = await pool.query("SELECT intent_legacy FROM orders WHERE id = $1", [order.id]);
    expect(row.rows[0].intent_legacy).toBe(false);
    const stored = await intents.getLatestIntentBriefForOrder(organizationId, order.id);
    expect(stored?.id).toBe(order.intent?.id);
  });

  it("leaves no orphan order when saving the brief fails", async () => {
    class Failing extends IntentAcceptanceService {
      override async saveIntentBrief(...args: Parameters<IntentAcceptanceService["saveIntentBrief"]>): Promise<IntentBriefRecord> {
        await super.saveIntentBrief(...args); // really inserted inside the transaction
        throw new Error("boom after insert");
      }
    }
    const failing = new WorkOrderService(pool, undefined, { intentService: new Failing(pool) });
    const objective = uniq();
    const goal = `orphan-check-${randomUUID()}`;
    await expect(failing.createOrder({ projectId, objective, intent: intentDoc({ goal }) })).rejects.toThrow("boom after insert");
    expect(await countOrders(objective)).toBe(0);
    const briefs = await pool.query("SELECT count(*)::int AS n FROM intent_briefs WHERE document->>'goal' = $1", [goal]);
    expect(briefs.rows[0].n).toBe(0);
    // A database-level failure (CHECK) is also rolled back with the order.
    const objective2 = uniq();
    const spy = new IntentAcceptanceService(pool);
    spy.saveIntentBrief = async () => {
      await pool.query("SELECT 1");
      throw new WorkOrderError("INVALID_INTENT", "simulated");
    };
    const svc = new WorkOrderService(pool, undefined, { intentService: spy });
    await expect(svc.createOrder({ projectId, objective: objective2, intent: intentDoc() })).rejects.toMatchObject({ code: "INVALID_INTENT" });
    expect(await countOrders(objective2)).toBe(0);
  });

  it("rolls back the brief too when the order fails after the brief (requirements)", async () => {
    const objective = uniq();
    const goal = `orphan-check-${randomUUID()}`;
    await expect(
      service.createOrder({
        projectId, objective, intent: intentDoc({ goal }),
        requirements: [
          { key: "R1", title: "t", description: "d" },
          { key: "R1", title: "t", description: "d" }
        ]
      })
    ).rejects.toMatchObject({ code: "INVALID_ORDER" });
    expect(await countOrders(objective)).toBe(0);
    const briefs = await pool.query("SELECT count(*)::int AS n FROM intent_briefs WHERE document->>'goal' = $1", [goal]);
    expect(briefs.rows[0].n).toBe(0);
  });

  it("is unchanged without an IntentAcceptanceService", async () => {
    const plain = new WorkOrderService(pool);
    const order = await plain.createOrder({ projectId, objective: uniq() });
    expect(order.intent).toBeUndefined();
    const withIgnored = await plain.createOrder({ projectId, objective: uniq(), intent: { not: "validated" } });
    expect(withIgnored.intent).toBeUndefined();
    expect(await intents.getLatestIntentBriefForOrder(organizationId, order.id)).toBeNull();
  });

  it("keeps legacy orders without intent working with createTask", async () => {
    const legacy = await pool.query(
      "INSERT INTO orders (project_id, objective, intent_legacy) VALUES ($1, 'Legacy', TRUE) RETURNING id",
      [projectId]
    );
    const created = await service.createTask({ projectId, orderId: legacy.rows[0].id, title: "Legacy task" });
    expect(created.status).toBe("PLANNED");
    expect(await intents.getLatestIntentBriefForOrder(organizationId, legacy.rows[0].id)).toBeNull();
  });

  it("end to end: ambiguous intent blocks tasks, clear intent plans them", async () => {
    const ambiguous = await service.createOrder({
      projectId, objective: uniq(),
      intent: intentDoc({ ambiguity_score: 0.8, clarification_required: true, open_questions: ["Which page?"] })
    });
    expect(ambiguous.id).toBeTruthy(); // the order itself is created
    const blocked = await service.createTask({ projectId, orderId: ambiguous.id, title: "Do it" });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.implementationBlock?.intentId).toBe(ambiguous.intent?.id);

    const clear = await service.createOrder({ projectId, objective: uniq(), intent: intentDoc() });
    const planned = await service.createTask({ projectId, orderId: clear.id, title: "Do it" });
    expect(planned.status).toBe("PLANNED");
  });
});
