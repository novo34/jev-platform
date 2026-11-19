import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabasePool, DEFAULT_MIGRATIONS_DIR } from "./index.js";

const pool = createDatabasePool();
const MIGRATION = "0031_intent_acceptance_storage.sql";

afterAll(async () => {
  await pool.end();
});

const doc = (extra: Record<string, unknown> = {}) => ({
  goal: "g", requested_change: "c", in_scope: [], out_of_scope: [], observed_context: [],
  assumptions: [], open_questions: [], ambiguity_score: 0.2, change_radius: "LOCAL",
  risk_signals: [], documentation_depth: "L0", clarification_required: false,
  evidence_needed: [], ...extra
});

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("PLT-040 migration 0031 (intent and acceptance storage)", () => {
  it("applies over existing data, marks existing orders LEGACY and new ones not", async () => {
    const schema = "jev_mig31_" + randomUUID().replaceAll("-", "");
    const owner = await pool.connect();
    try {
      await owner.query(`CREATE SCHEMA "${schema}"`);
      await owner.query(`SET search_path TO "${schema}", public`);
      const files = (await readdir(DEFAULT_MIGRATIONS_DIR)).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
      const index = files.indexOf(MIGRATION);
      expect(index).toBeGreaterThan(0);
      for (const file of files.slice(0, index)) {
        let sql = await readFile(path.join(DEFAULT_MIGRATIONS_DIR, file), "utf8");
        if (file.startsWith("0001_")) sql = sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "");
        await owner.query(sql);
      }
      const org = randomUUID(); const project = randomUUID();
      await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'Legacy')", [org]);
      await owner.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'P')", [project, org]);
      const before = (await owner.query(
        "INSERT INTO orders (project_id, objective, status) VALUES ($1, 'old one', 'IN_PROGRESS'), ($1, 'old two', 'PLANNED') RETURNING id, updated_at",
        [project])).rows;
      await owner.query(await readFile(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), "utf8"));

      const after = (await owner.query(
        "SELECT id, intent_legacy, status, updated_at FROM orders WHERE project_id = $1", [project])).rows;
      expect(after).toHaveLength(2);
      expect(after.every(r => r.intent_legacy === true)).toBe(true);
      // The backfill did not rewrite the orders or fire their status triggers.
      expect(after.map(r => r.status).sort()).toEqual(["IN_PROGRESS", "PLANNED"]);
      for (const row of before) {
        expect(after.find(r => r.id === row.id)!.updated_at).toEqual(row.updated_at);
      }
      const fresh = (await owner.query(
        "INSERT INTO orders (project_id, objective) VALUES ($1, 'new') RETURNING intent_legacy", [project])).rows[0];
      expect(fresh.intent_legacy).toBe(false);

      // CHECKs mirror the Foundation enumerations; the flat columns must equal the document.
      const insertIntent = (document: unknown, columns: [number, string, string, boolean] = [0.2, "LOCAL", "L0", false]) =>
        owner.query(
          `INSERT INTO intent_briefs (organization_id, document, ambiguity_score, change_radius, documentation_depth, clarification_required)
           VALUES ($1, $2::jsonb, $3, $4, $5, $6) RETURNING id`, [org, JSON.stringify(document), ...columns]);
      const ok = (await insertIntent(doc())).rows[0].id;
      await expectCode(insertIntent(doc({ ambiguity_score: 1.5 }), [1.5, "LOCAL", "L0", false]), "23514");
      await expectCode(insertIntent(doc({ ambiguity_score: -0.1 }), [-0.1, "LOCAL", "L0", false]), "23514");
      await expectCode(insertIntent(doc({ change_radius: "GLOBAL" }), [0.2, "GLOBAL", "L0", false]), "23514");
      await expectCode(insertIntent(doc({ documentation_depth: "L5" }), [0.2, "LOCAL", "L5", false]), "23514");
      await expectCode(insertIntent(doc(), [0.3, "LOCAL", "L0", false]), "23514");
      await expectCode(insertIntent(doc(), [0.2, "LOCAL", "L0", true]), "23514");
      await expectCode(insertIntent([1, 2], [0.2, "LOCAL", "L0", false]), "23514");

      const contractDoc = (intent: string, depth = "L1") => ({ intent_id: intent, specification_depth: depth });
      const insertContract = (intent: string, document: unknown, depth: string, organization = org, version = 1) =>
        owner.query(
          `INSERT INTO acceptance_contracts (organization_id, intent_id, version, document, specification_depth)
           VALUES ($1, $2, $5, $3::jsonb, $4)`, [organization, intent, JSON.stringify(document), depth, version]);
      await insertContract(ok, contractDoc(ok), "L1");
      await expectCode(insertContract(ok, contractDoc(ok), "L1"), "23505"); // same intent, same version
      await expectCode(insertContract(ok, contractDoc(ok, "L9"), "L9"), "23514");
      await expectCode(insertContract(ok, contractDoc(ok, "L2"), "L1"), "23514");
      await expectCode(insertContract(ok, contractDoc(randomUUID()), "L1"), "23514");
      const otherOrg = randomUUID();
      await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'Other')", [otherOrg]);
      // The composite foreign key rejects a contract that points at another organization's intent.
      await expectCode(insertContract(ok, contractDoc(ok), "L1", otherOrg, 99), "23503");
    } finally {
      await owner.query("RESET search_path");
      await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      owner.release();
    }
  });

  it("gives the runtime role INSERT and SELECT only, using the real provisioning lines", async () => {
    const schema = "jev_mig31r_" + randomUUID().replaceAll("-", "");
    const role = "jev_intent_role_" + randomUUID().replaceAll("-", "");
    const owner = await pool.connect();
    try {
      await owner.query(`CREATE SCHEMA "${schema}"`);
      await owner.query(`SET search_path TO "${schema}", public`);
      const files = (await readdir(DEFAULT_MIGRATIONS_DIR)).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
      for (const file of files) {
        let sql = await readFile(path.join(DEFAULT_MIGRATIONS_DIR, file), "utf8");
        if (file.startsWith("0001_")) sql = sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "");
        await owner.query(sql);
      }
      const orgA = randomUUID(); const orgB = randomUUID(); const projectA = randomUUID();
      await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [orgA, orgB]);
      await owner.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'P')", [projectA, orgA]);

      await owner.query(`CREATE ROLE "${role}" NOLOGIN`);
      await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await owner.query(`GRANT SELECT ON TABLE intent_briefs, acceptance_contracts TO "${role}"`);
      // Execute the real PLT-040 statements of both provisioning scripts for the test role.
      for (const file of [
        path.join(DEFAULT_MIGRATIONS_DIR, "..", "security", "provision-runtime-role.sql"),
        path.join(DEFAULT_MIGRATIONS_DIR, "..", "..", "..", "deploy", "staging", "provision-runtime-grants.sql")
      ]) {
        const script = await readFile(file, "utf8");
        const blocks = ["jev_intent_revoke", "jev_intent_grant"].map(tag => {
          const start = script.indexOf(`DO $${tag}$`);
          expect(start).toBeGreaterThanOrEqual(0);
          const end = script.indexOf(`$${tag}$;`, start + 10) + `$${tag}$;`.length;
          return script.slice(start, end);
        });
        for (const block of blocks) {
          await owner.query(block.replaceAll("jev_runtime", `"${role}"`).replaceAll("public.", `"${schema}".`));
        }
        await owner.query(`GRANT SELECT ON TABLE intent_briefs, acceptance_contracts TO "${role}"`);
      }

      const privileges = (await owner.query(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee = $1 AND table_name IN ('intent_briefs','acceptance_contracts')
          ORDER BY table_name, privilege_type`, [role])).rows;
      expect(privileges).toEqual([
        { table_name: "acceptance_contracts", privilege_type: "INSERT" },
        { table_name: "acceptance_contracts", privilege_type: "SELECT" },
        { table_name: "intent_briefs", privilege_type: "INSERT" },
        { table_name: "intent_briefs", privilege_type: "SELECT" }
      ]);

      await owner.query(`SET ROLE "${role}"`);
      const inserted = (await owner.query(
        `INSERT INTO intent_briefs (organization_id, document, ambiguity_score, change_radius, documentation_depth, clarification_required)
         VALUES ($1, $2::jsonb, 0.2, 'LOCAL', 'L0', false) RETURNING id`, [orgA, JSON.stringify(doc())])).rows[0].id;
      await expectCode(owner.query("DELETE FROM intent_briefs WHERE id = $1", [inserted]), "42501");
      await expectCode(owner.query("UPDATE intent_briefs SET change_radius = 'PRODUCT'"), "42501");
      await expectCode(owner.query("TRUNCATE intent_briefs"), "42501");
      await expectCode(owner.query("DELETE FROM acceptance_contracts"), "42501");
      await expectCode(owner.query("UPDATE acceptance_contracts SET specification_depth = 'L4'"), "42501");
      // Even the runtime role cannot link a contract to another organization's intent.
      await expectCode(owner.query(
        `INSERT INTO acceptance_contracts (organization_id, intent_id, document, specification_depth)
         VALUES ($1, $2, $3::jsonb, 'L1')`,
        [orgB, inserted, JSON.stringify({ intent_id: inserted, specification_depth: "L1" })]), "23503");
      // It cannot flip the LEGACY marker either.
      await expectCode(owner.query("UPDATE orders SET intent_legacy = TRUE"), "42501");
    } finally {
      await owner.query("RESET ROLE").catch(() => undefined);
      await owner.query("RESET search_path");
      await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await owner.query(`DROP OWNED BY "${role}"`).catch(() => undefined);
      await owner.query(`DROP ROLE IF EXISTS "${role}"`);
      owner.release();
    }
  });

  it("states no GRANT/REVOKE in the migration and never grants UPDATE or DELETE on the new tables", async () => {
    const migration = await readFile(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), "utf8");
    const code = migration.split("\n").filter(line => !line.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(GRANT|REVOKE)\b/);
    for (const file of [
      path.join(DEFAULT_MIGRATIONS_DIR, "..", "security", "provision-runtime-role.sql"),
      path.join(DEFAULT_MIGRATIONS_DIR, "..", "..", "..", "deploy", "staging", "provision-runtime-grants.sql")
    ]) {
      const sql = await readFile(file, "utf8");
      expect(sql).not.toMatch(/GRANT[^;]*(UPDATE|DELETE|ALL)[^;]*(intent_briefs|acceptance_contracts)/);
      expect(sql).toMatch(/GRANT INSERT ON TABLE public\.intent_briefs, public\.acceptance_contracts TO jev_runtime;/);
    }
  });
});
