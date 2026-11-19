import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { IntentAcceptanceError, IntentAcceptanceService } from "./index.js";

const pool = createDatabasePool();
const service = new IntentAcceptanceService(pool);
const orgA = randomUUID();
const orgB = randomUUID();
const projectA = randomUUID();
const projectB = randomUUID();
let orderA: string;
let orderB: string;

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
const contractDoc = (intent_id: string, overrides: Record<string, unknown> = {}) => ({
  intent_id,
  acceptance_criteria: [{ criterion: "Hero image is replaced", verification: "browser screenshot" }],
  constraints: ["no layout change"],
  assumptions: [],
  non_goals: ["layout redesign"],
  affected_requirements: ["REQ-X-001"],
  compatibility_requirements: [],
  required_evidence: ["browser screenshot"],
  unresolved_decisions: [],
  specification_depth: "L1",
  ...overrides
});

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_CODE";
  }
  return "NO_ERROR";
}

beforeAll(async () => {
  await migrate(pool);
  for (const [org, project] of [[orgA, projectA], [orgB, projectB]]) {
    await pool.query("INSERT INTO organizations (id, name) VALUES ($1, 'Intent Org')", [org]);
    await pool.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Intent Project')", [project, org]);
  }
  orderA = (await pool.query("INSERT INTO orders (project_id, objective) VALUES ($1, 'A') RETURNING id", [projectA])).rows[0].id;
  orderB = (await pool.query("INSERT INTO orders (project_id, objective) VALUES ($1, 'B') RETURNING id", [projectB])).rows[0].id;
});

// Rows are append-only (trigger), so test data is not deleted; ids are random.
afterAll(async () => {
  await pool.end();
});

describe("IntentAcceptanceService", () => {
  it("persists an IntentBrief with its flat columns and reads it back", async () => {
    const saved = await service.saveIntentBrief(orgA, {
      orderId: orderA,
      document: intentDoc({ ambiguity_score: 0.35, change_radius: "COMPONENT", documentation_depth: "L2", clarification_required: true })
    });
    expect(saved).toMatchObject({
      organizationId: orgA, orderId: orderA, version: 1, ambiguityScore: 0.35,
      changeRadius: "COMPONENT", documentationDepth: "L2", clarificationRequired: true
    });
    const read = await service.getIntentBrief(orgA, saved.id);
    expect(read).toEqual(saved);
    expect(read.document.requested_change).toBe("Replace hero image");
  });

  it("stores a brief without an order and rejects invalid documents before touching the database", async () => {
    const free = await service.saveIntentBrief(orgA, { document: intentDoc() });
    expect(free).toMatchObject({ orderId: null, version: 1 });
    await expect(service.saveIntentBrief(orgA, { document: intentDoc({ extra: 1 }) }))
      .rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(service.saveIntentBrief(orgA, { document: intentDoc({ ambiguity_score: 2 }) }))
      .rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("versions a brief per order instead of updating it", async () => {
    const order = (await pool.query("INSERT INTO orders (project_id, objective) VALUES ($1, 'V') RETURNING id", [projectA])).rows[0].id;
    const first = await service.saveIntentBrief(orgA, { orderId: order, document: intentDoc({ ambiguity_score: 0.8, clarification_required: true }) });
    const second = await service.saveIntentBrief(orgA, { orderId: order, document: intentDoc({ ambiguity_score: 0.1 }) });
    expect([first.version, second.version]).toEqual([1, 2]);
    expect(second.id).not.toBe(first.id);
    expect((await service.getLatestIntentBriefForOrder(orgA, order))?.id).toBe(second.id);
    expect((await service.getIntentBrief(orgA, first.id)).clarificationRequired).toBe(true);
    expect(await service.getLatestIntentBriefForOrder(orgA, randomUUID())).toBeNull();
  });

  it("serialises concurrent saves into distinct versions", async () => {
    const order = (await pool.query("INSERT INTO orders (project_id, objective) VALUES ($1, 'C') RETURNING id", [projectA])).rows[0].id;
    const saved = await Promise.all(
      [1, 2, 3].map(() => service.saveIntentBrief(orgA, { orderId: order, document: intentDoc() }))
    );
    expect(saved.map((s) => s.version).sort()).toEqual([1, 2, 3]);
  });

  it("isolates organizations for briefs and orders", async () => {
    const saved = await service.saveIntentBrief(orgA, { orderId: orderA, document: intentDoc() });
    await expect(service.getIntentBrief(orgB, saved.id)).rejects.toMatchObject({ code: "INTENT_NOT_FOUND" });
    expect(await service.getLatestIntentBriefForOrder(orgB, orderA)).toBeNull();
    // An order of another organization cannot be linked, and does not leak.
    await expect(service.saveIntentBrief(orgA, { orderId: orderB, document: intentDoc() }))
      .rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    await expect(service.saveIntentBrief(orgA, { orderId: randomUUID(), document: intentDoc() }))
      .rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    await expect(service.saveIntentBrief("not-a-uuid", { document: intentDoc() }))
      .rejects.toMatchObject({ code: "INVALID_ORGANIZATION" });
    await expect(service.saveIntentBrief(randomUUID(), { document: intentDoc() }))
      .rejects.toMatchObject({ code: "INVALID_ORGANIZATION" });
  });

  it("persists an AcceptanceContract linked to its intent and copies the order", async () => {
    const intent = await service.saveIntentBrief(orgA, { orderId: orderA, document: intentDoc() });
    const saved = await service.saveAcceptanceContract(orgA, { document: contractDoc(intent.id) });
    expect(saved).toMatchObject({
      organizationId: orgA, intentId: intent.id, orderId: orderA, version: 1, specificationDepth: "L1"
    });
    expect(saved.document.affected_requirements).toEqual(["REQ-X-001"]);
    expect(await service.getAcceptanceContract(orgA, saved.id)).toEqual(saved);
    const second = await service.saveAcceptanceContract(orgA, { document: contractDoc(intent.id, { specification_depth: "L2" }) });
    expect(second.version).toBe(2);
    expect((await service.getLatestAcceptanceContractForIntent(orgA, intent.id))?.id).toBe(second.id);
    expect(await service.getLatestAcceptanceContractForIntent(orgA, randomUUID())).toBeNull();
  });

  it("rejects a contract without a stored intent", async () => {
    await expect(service.saveAcceptanceContract(orgA, { document: contractDoc(randomUUID()) }))
      .rejects.toMatchObject({ code: "INTENT_NOT_FOUND" });
    // Foundation's example id is not a Platform UUID.
    await expect(service.saveAcceptanceContract(orgA, { document: contractDoc("INT-1") }))
      .rejects.toMatchObject({ code: "INTENT_NOT_FOUND" });
    await expect(service.saveAcceptanceContract(orgA, { document: contractDoc(randomUUID(), { acceptance_criteria: [] }) }))
      .rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("rejects a contract whose intent belongs to another organization and hides foreign contracts", async () => {
    const foreign = await service.saveIntentBrief(orgB, { orderId: orderB, document: intentDoc() });
    const err = await service.saveAcceptanceContract(orgA, { document: contractDoc(foreign.id) }).catch((e) => e);
    expect(err).toBeInstanceOf(IntentAcceptanceError);
    expect(err.code).toBe("INTENT_NOT_FOUND");
    const own = await service.saveAcceptanceContract(orgB, { document: contractDoc(foreign.id) });
    await expect(service.getAcceptanceContract(orgA, own.id)).rejects.toMatchObject({ code: "INTENT_NOT_FOUND" });
    expect(await service.getLatestAcceptanceContractForIntent(orgA, foreign.id)).toBeNull();
    const none = await pool.query("SELECT 1 FROM acceptance_contracts WHERE intent_id = $1 AND organization_id = $2", [foreign.id, orgA]);
    expect(none.rowCount).toBe(0);
  });

  it("makes stored rows immutable even for the owner, and keeps flat columns equal to the document", async () => {
    const intent = await service.saveIntentBrief(orgA, { document: intentDoc() });
    const contract = await service.saveAcceptanceContract(orgA, { document: contractDoc(intent.id) });
    expect(await code(pool.query("UPDATE intent_briefs SET change_radius = 'PRODUCT' WHERE id = $1", [intent.id]))).toBe("23514");
    expect(await code(pool.query("DELETE FROM intent_briefs WHERE id = $1", [intent.id]))).toBe("23514");
    expect(await code(pool.query("UPDATE acceptance_contracts SET specification_depth = 'L4' WHERE id = $1", [contract.id]))).toBe("23514");
    expect(await code(pool.query("DELETE FROM acceptance_contracts WHERE id = $1", [contract.id]))).toBe("23514");
    // A direct INSERT whose columns disagree with the document is rejected.
    expect(await code(pool.query(
      `INSERT INTO intent_briefs (organization_id, document, ambiguity_score, change_radius, documentation_depth, clarification_required)
       VALUES ($1, $2::jsonb, 0.9, 'LOCAL', 'L0', false)`,
      [orgA, JSON.stringify(intentDoc())]))).toBe("23514");
  });

  it("marks new orders as not legacy", async () => {
    const row = (await pool.query("SELECT intent_legacy FROM orders WHERE id = $1", [orderA])).rows[0];
    expect(row.intent_legacy).toBe(false);
  });
});
