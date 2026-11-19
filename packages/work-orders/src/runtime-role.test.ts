import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, DEFAULT_MIGRATIONS_DIR, migrate } from "@jev/db";
import type { ModelGatewayRequest, ModelGatewayResult } from "@jev/model-gateway";
import {
  CONTRACT_INTENT_ID_PLACEHOLDER,
  INTAKE_WORK_TYPE,
  IntentAcceptanceService,
  IntentBriefGenerator,
  WorkOrderService,
  type IntentModelGateway
} from "./index.js";

// PLT-040 PR 6 under the RESTRICTED runtime role (what staging uses). The
// fixture is created as the migrator; every service call goes through a Pool
// authenticated as a disposable copy of jev_runtime provisioned by the REAL
// scripts (security/provision-runtime-role.sql and
// deploy/staging/provision-runtime-grants.sql). The gateway is a fake (no network).
const here = path.dirname(fileURLToPath(import.meta.url));
const productionScript = path.join(DEFAULT_MIGRATIONS_DIR, "..", "security", "provision-runtime-role.sql");
const stagingScript = path.resolve(here, "../../../deploy/staging/provision-runtime-grants.sql");

const admin = createDatabasePool();
const suffix = randomBytes(5).toString("hex");
const role = `jev_rt_prod_${suffix}`;
const stagingRole = `jev_rt_stg_${suffix}`;
let runtime: Pool;
let intents: IntentAcceptanceService;

const organizationId = randomUUID();
const projectId = randomUUID();
const noRepoProjectId = randomUUID();
const raceProjectId = randomUUID();
const TARGETS = [{ provider: "anthropic" as const, model: "fake-model" }];

const brief = (o: Record<string, unknown> = {}) => ({
  goal: "Replace hero image", requested_change: "Swap the hero image", in_scope: ["hero"],
  out_of_scope: ["layout redesign"], observed_context: [], assumptions: [], open_questions: [],
  ambiguity_score: 0.1, change_radius: "LOCAL", risk_signals: [], documentation_depth: "L1",
  clarification_required: false, evidence_needed: ["screenshot"], ...o
});
const contract = () => ({
  intent_id: CONTRACT_INTENT_ID_PLACEHOLDER,
  acceptance_criteria: [{ criterion: "Hero shows the new image", verification: "screenshot of /home" }],
  constraints: [], assumptions: [], non_goals: [], affected_requirements: [],
  compatibility_requirements: [], required_evidence: ["screenshot"], unresolved_decisions: [],
  specification_depth: "L1"
});

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
function service(steps: string[] = []) {
  const gateway = fakeGateway(steps);
  const generator = new IntentBriefGenerator({ gateway, targets: TARGETS, newRequestId: () => randomUUID() });
  const svc = new WorkOrderService(runtime, undefined, {
    intentService: intents, intentGenerator: generator, ambiguityThreshold: 0.5, intentClarifyRounds: 0
  });
  return { svc, gateway };
}
const count = async (sql: string, args: unknown[]) =>
  Number((await admin.query(sql, args)).rows[0].n);

async function provision(roleName: string, scriptPath: string, createFirst: boolean) {
  if (createFirst) {
    await admin.query(`CREATE ROLE "${roleName}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
  }
  // Identifiers are generated hex (safe). The scripts name the role literally.
  const sql = (await readFile(scriptPath, "utf8")).replaceAll("jev_runtime", roleName);
  await admin.query(sql);
}

/** Effective table and column ACL of a role, independent of its name. */
async function aclSnapshot(roleName: string): Promise<string[]> {
  const tables = await admin.query(
    `SELECT c.relname || ':' || a.privilege_type AS item
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
            LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = 'public' AND r.rolname = $1`, [roleName]);
  const columns = await admin.query(
    `SELECT c.relname || '.' || at.attname || ':' || a.privilege_type AS item
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute at ON at.attrelid = c.oid,
            LATERAL aclexplode(at.attacl) a JOIN pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = 'public' AND r.rolname = $1`, [roleName]);
  const functions = await admin.query(
    `SELECT p.proname || ':' || a.privilege_type AS item
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
            LATERAL aclexplode(p.proacl) a JOIN pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = 'public' AND r.rolname = $1`, [roleName]);
  return [...tables.rows, ...columns.rows, ...functions.rows].map((r) => r.item as string).sort();
}

beforeAll(async () => {
  await migrate(admin);
  await provision(role, productionScript, false);
  await provision(stagingRole, stagingScript, true);
  const password = randomBytes(24).toString("hex");
  const literal = (await admin.query("SELECT quote_literal($1::text) AS v", [password])).rows[0].v;
  await admin.query(`ALTER ROLE "${role}" PASSWORD ${literal}`);
  const url = new URL(process.env.DATABASE_URL!);
  url.username = role;
  url.password = password;
  runtime = createDatabasePool({ connectionString: url.toString(), max: 10 });
  intents = new IntentAcceptanceService(runtime);

  await admin.query("INSERT INTO organizations (id, name) VALUES ($1, 'Runtime Org')", [organizationId]);
  await admin.query(
    "INSERT INTO projects (id, organization_id, name) VALUES ($1,$4,'RT'), ($2,$4,'RT no repo'), ($3,$4,'RT race')",
    [projectId, noRepoProjectId, raceProjectId, organizationId]
  );
  for (const project of [projectId, raceProjectId]) {
    await admin.query(
      `INSERT INTO repositories (id, project_id, full_name, role, primary_repository, default_branch, staging_branch)
       VALUES ($1, $2, $3, 'backend', TRUE, 'main', 'staging')`,
      [randomUUID(), project, `novo34/rt-${randomUUID()}`]
    );
  }
});

afterAll(async () => {
  await runtime?.end();
  for (const roleName of [role, stagingRole]) {
    await admin.query(`DROP OWNED BY "${roleName}"`);
    await admin.query(`DROP ROLE "${roleName}"`);
  }
  await admin.end();
});

describe("PLT-040 PR 6 flow as the restricted runtime role", () => {
  it("really connects as the restricted role", async () => {
    const who = (await runtime.query(
      "SELECT current_user AS u, session_user AS s, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su"
    )).rows[0];
    expect(who).toEqual({ u: role, s: role, su: false });
  });

  it("both provisioning scripts grant exactly the same ACL", async () => {
    const production = await aclSnapshot(role);
    expect(production.length).toBeGreaterThan(50);
    // The staging script predates the cache-metrics views and only differs by
    // the views' explicit SELECT (already covered by the schema-wide SELECT).
    expect(await aclSnapshot(stagingRole)).toEqual(production);
  });

  it("ensureIntakeTask is idempotent and sequentially stable", async () => {
    const { svc } = service();
    const first = await svc.ensureIntakeTask(projectId);
    const second = await svc.ensureIntakeTask(projectId);
    expect(second).toEqual(first);
    expect(await count("SELECT count(*) AS n FROM orders WHERE project_id=$1 AND work_type=$2", [projectId, INTAKE_WORK_TYPE])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM tasks WHERE order_id=$1", [first.orderId])).toBe(1);
    const order = (await admin.query("SELECT intent_legacy, work_type FROM orders WHERE id=$1", [first.orderId])).rows[0];
    expect(order).toEqual({ intent_legacy: false, work_type: INTAKE_WORK_TYPE });
    expect(await count("SELECT count(*) AS n FROM intent_briefs WHERE order_id=$1", [first.orderId])).toBe(1);
  });

  it("ensureIntakeTask is concurrent-safe (single order and task, advisory lock)", async () => {
    const callers = Array.from({ length: 6 }, () => service().svc);
    const results = await Promise.all(callers.map((svc) => svc.ensureIntakeTask(raceProjectId)));
    expect(new Set(results.map((r) => r.taskId)).size).toBe(1);
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    expect(await count("SELECT count(*) AS n FROM orders WHERE project_id=$1 AND work_type=$2", [raceProjectId, INTAKE_WORK_TYPE])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM tasks t JOIN orders o ON o.id=t.order_id WHERE o.project_id=$1", [raceProjectId])).toBe(1);
    // No session advisory lock is left behind by the pool.
    expect(await count("SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND granted AND pid <> pg_backend_pid()", [])).toBe(0);
  });

  it("ensureIntakeTask without repository fails and creates no task", async () => {
    const { svc } = service();
    await expect(svc.ensureIntakeTask(noRepoProjectId)).rejects.toBeTruthy();
    expect(await count("SELECT count(*) AS n FROM tasks t JOIN orders o ON o.id=t.order_id WHERE o.project_id=$1", [noRepoProjectId])).toBe(0);
  });

  it("creates an order with generated IntentBrief and AcceptanceContract in one transaction", async () => {
    const { svc, gateway } = service([JSON.stringify(brief()), JSON.stringify(contract())]);
    const intake = await svc.ensureIntakeTask(projectId);
    const objective = `Runtime order ${randomUUID()}`;
    const order = await svc.createOrderWithGeneratedIntent({ projectId, objective }, intake.taskId, intake.orderId);
    expect(gateway.requests).toHaveLength(2);
    expect(order.intent?.version).toBe(1);
    expect(order.acceptanceContract?.intentId).toBe(order.intent?.id);
    const row = (await admin.query("SELECT intent_legacy, status FROM orders WHERE id=$1", [order.id])).rows[0];
    expect(row).toEqual({ intent_legacy: false, status: "PLANNED" });
    expect(await count("SELECT count(*) AS n FROM acceptance_contracts WHERE order_id=$1", [order.id])).toBe(1);
    // Reads through the runtime role itself.
    expect((await intents.getLatestIntentBriefForOrder(organizationId, order.id))?.id).toBe(order.intent?.id);
    expect((await intents.getLatestAcceptanceContractForIntent(organizationId, order.intent!.id))?.id).toBe(order.acceptanceContract?.id);
  });

  it("rolls back order, brief and contract together when the contract cannot be saved", async () => {
    const { svc } = service([JSON.stringify(brief()), JSON.stringify({ ...contract(), specification_depth: "L9" })]);
    const intake = await svc.ensureIntakeTask(projectId);
    const objective = `Runtime rollback ${randomUUID()}`;
    await expect(svc.createOrderWithGeneratedIntent({ projectId, objective }, intake.taskId, intake.orderId)).rejects.toBeTruthy();
    expect(await count("SELECT count(*) AS n FROM orders WHERE objective=$1", [objective])).toBe(0);
  });

  it("createTask: normal keeps the requested risk; ambiguous order blocks at least R2; reevaluate unblocks only ambiguity blocks", async () => {
    const { svc: clear } = service([JSON.stringify(brief()), JSON.stringify(contract())]);
    const intake = await clear.ensureIntakeTask(projectId);
    const clearOrder = await clear.createOrderWithGeneratedIntent(
      { projectId, objective: `Clear ${randomUUID()}` }, intake.taskId, intake.orderId
    );
    const normal = await clear.createTask({ projectId, orderId: clearOrder.id, title: "Normal", risk: "R1" });
    expect(normal).toMatchObject({ status: "PLANNED", risk: "R1" });
    expect(normal.implementationBlock).toBeUndefined();

    const { svc } = service([JSON.stringify(brief({ ambiguity_score: 0.9, clarification_required: true }))]);
    const order = await svc.createOrderWithGeneratedIntent(
      { projectId, objective: `Ambiguous ${randomUUID()}` }, intake.taskId, intake.orderId
    );
    // High ambiguity: no contract is generated (and none is stored).
    expect(order.acceptanceContract).toBeUndefined();
    const blocked = await svc.createTask({ projectId, orderId: order.id, title: "Blocked", risk: "R0" });
    expect(blocked).toMatchObject({ status: "BLOCKED", risk: "R2" });
    expect(blocked.implementationBlock?.code).toBe("AMBIGUOUS_INTENT");
    const last = blocked.stateHistory[blocked.stateHistory.length - 1];
    expect(last).toMatchObject({ fromStatus: "PLANNED", toStatus: "BLOCKED", actorType: "SYSTEM" });
    const higher = await svc.createTask({ projectId, orderId: order.id, title: "Blocked R3", risk: "R3" });
    expect(higher.risk).toBe("R3");

    // Still ambiguous: nothing is touched.
    const still = await svc.reevaluateBlockedTasks(order.id);
    expect(still).toMatchObject({ stillBlocked: true, unblockedTaskIds: [] });
    expect((await svc.getTask(blocked.id)).status).toBe("BLOCKED");

    // A clarified version is saved with the runtime role (INSERT on intent_briefs).
    const v2 = await intents.saveIntentBrief(organizationId, { orderId: order.id, document: brief() });
    expect(v2.version).toBe(2);
    // A task blocked for ANOTHER reason must stay blocked.
    const other = await svc.createTask({ projectId, orderId: order.id, title: "Dependency" });
    await svc.transitionTask(other.id, "READY", { actorType: "SYSTEM", cause: "released" });
    await svc.transitionTask(other.id, "BLOCKED", { actorType: "SYSTEM", cause: "dependency", evidence: { code: "DEPENDENCY" } });

    const result = await svc.reevaluateBlockedTasks(order.id);
    expect(result.stillBlocked).toBe(false);
    expect(result.intentVersion).toBe(2);
    expect([...result.unblockedTaskIds].sort()).toEqual([blocked.id, higher.id].sort());
    expect((await svc.getTask(blocked.id)).status).toBe("READY");
    expect((await svc.getTask(other.id)).status).toBe("BLOCKED");
    const history = (await svc.getTask(blocked.id)).stateHistory;
    expect(history[history.length - 1]).toMatchObject({ fromStatus: "BLOCKED", toStatus: "READY", actorType: "SYSTEM" });
    // Idempotent.
    expect((await svc.reevaluateBlockedTasks(order.id)).unblockedTaskIds).toEqual([]);
  });

  it("reads orders.work_type and takes the per-order advisory lock", async () => {
    const intake = await service().svc.ensureIntakeTask(projectId);
    const read = await runtime.query("SELECT work_type FROM orders WHERE id=$1", [intake.orderId]);
    expect(read.rows[0].work_type).toBe(INTAKE_WORK_TYPE);
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS ok", [`lock-${randomUUID()}`]);
      expect(locked.rows[0].ok).toBe(true);
      await client.query("COMMIT");
      const session = await client.query("SELECT pg_try_advisory_lock(7) AS a, pg_advisory_unlock(7) AS b");
      expect(session.rows[0]).toEqual({ a: true, b: true });
    } finally {
      client.release();
    }
  });
});

describe("the restricted role gains no unwanted capability", () => {
  const denied = async (sql: string, args: unknown[] = []) => {
    // A rejected statement inside a transaction must not leave side effects.
    await expect(runtime.query(sql, args)).rejects.toMatchObject({ code: "42501" });
  };

  it("cannot create a LEGACY order or flip intent_legacy", async () => {
    await denied("INSERT INTO orders (project_id, objective, intent_legacy) VALUES ($1,'x',TRUE)", [projectId]);
    await denied("INSERT INTO orders (project_id, objective, intent_legacy) VALUES ($1,'x',FALSE)", [projectId]);
    const order = (await admin.query("SELECT id FROM orders WHERE project_id=$1 LIMIT 1", [projectId])).rows[0].id;
    await denied("UPDATE orders SET intent_legacy = TRUE WHERE id=$1", [order]);
    await denied("UPDATE orders SET work_type = 'GENERAL' WHERE id=$1", [order]);
    // A plain INSERT without the column is allowed and is never legacy.
    const created = await runtime.query("INSERT INTO orders (project_id, objective) VALUES ($1,'plain') RETURNING intent_legacy", [projectId]);
    expect(created.rows[0].intent_legacy).toBe(false);
  });

  it("cannot UPDATE or write tasks directly, nor delete history", async () => {
    const task = (await admin.query("SELECT id FROM tasks LIMIT 1")).rows[0].id;
    await denied("UPDATE tasks SET status='APPROVED' WHERE id=$1", [task]);
    await denied("UPDATE tasks SET risk='R0' WHERE id=$1", [task]);
    await denied("INSERT INTO tasks (project_id, order_id, repository_id, title) SELECT project_id, order_id, repository_id, 'x' FROM tasks LIMIT 1");
    await denied("DELETE FROM tasks WHERE id=$1", [task]);
    await denied("DELETE FROM task_state_history");
    await denied("INSERT INTO task_state_history (task_id, to_status, actor_type, cause) VALUES ($1,'READY','SYSTEM','x')", [task]);
    await denied("DELETE FROM order_state_history");
    await denied("UPDATE order_state_history SET cause = 'x'");
    await denied("TRUNCATE task_state_history");
    await denied("DELETE FROM orders");
  });

  it("IntentBrief and AcceptanceContract are append-only for the runtime role", async () => {
    for (const table of ["intent_briefs", "acceptance_contracts"]) {
      await denied(`UPDATE ${table} SET created_at = NOW()`);
      await denied(`DELETE FROM ${table}`);
      await denied(`TRUNCATE ${table}`);
      const privileges = (await runtime.query(
        `SELECT has_table_privilege(current_user,$1,'SELECT') AS s, has_table_privilege(current_user,$1,'INSERT') AS i,
                has_table_privilege(current_user,$1,'UPDATE') AS u, has_table_privilege(current_user,$1,'DELETE') AS d`, [table]
      )).rows[0];
      expect(privileges).toEqual({ s: true, i: true, u: false, d: false });
    }
  });

  it("the exact column grants on orders and tasks hold", async () => {
    const orderCols = (await runtime.query(
      `SELECT a.attname,
              has_column_privilege(current_user,'public.orders',a.attname,'INSERT') AS ins,
              has_column_privilege(current_user,'public.orders',a.attname,'UPDATE') AS upd
         FROM pg_attribute a WHERE a.attrelid='public.orders'::regclass AND a.attnum>0 AND NOT a.attisdropped`
    )).rows;
    for (const col of orderCols) {
      expect(col.ins, `INSERT ${col.attname}`).toBe(col.attname !== "intent_legacy");
      expect(col.upd, `UPDATE ${col.attname}`).toBe(col.attname === "status");
    }
    const taskCols = (await runtime.query(
      `SELECT count(*)::int AS n FROM pg_attribute a WHERE a.attrelid='public.tasks'::regclass AND a.attnum>0 AND NOT a.attisdropped
          AND (has_column_privilege(current_user,'public.tasks',a.attname,'UPDATE') OR has_column_privilege(current_user,'public.tasks',a.attname,'INSERT'))`
    )).rows[0].n;
    expect(taskCols).toBe(0);
  });
});
