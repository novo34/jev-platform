import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, DEFAULT_MIGRATIONS_DIR } from "./index.js";
import { migrate } from "./migrations.js";

const pool = createDatabasePool();
const VIEWS = ["model_cache_metrics_by_call", "model_cache_metrics_by_task", "model_cache_metrics_by_project"];
const organizationId = randomUUID();
const projectId = randomUUID();
const taskId = randomUUID();
const repositoryId = randomUUID();

beforeAll(async () => {
  await migrate(pool);
  await pool.query("INSERT INTO organizations (id, name) VALUES ($1, 'Cache Metrics Org')", [organizationId]);
  await pool.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'P')", [projectId, organizationId]);
  await pool.query("INSERT INTO repositories (id, project_id, full_name, role) VALUES ($1, $2, 'novo34/cache-metrics-mig', 'backend')", [repositoryId, projectId]);
  await pool.query("INSERT INTO tasks (id, project_id, repository_id, title) VALUES ($1, $2, $3, 'T')", [taskId, projectId, repositoryId]);
});

afterAll(async () => {
  await pool.query("TRUNCATE task_state_history");
  await pool.query("DELETE FROM model_provider_calls WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM tasks WHERE id = $1", [taskId]);
  await pool.query("DELETE FROM repositories WHERE id = $1", [repositoryId]);
  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
  await pool.end();
});

const insertCall = (extra: Record<string, unknown> = {}) => {
  const columns = ["request_id", "organization_id", "project_id", "task_id", "provider", "model",
    "outcome", "attempt_count", ...Object.keys(extra)];
  const values = [randomUUID(), organizationId, projectId, taskId, "anthropic", "m", "SUCCESS", 1,
    ...Object.values(extra)];
  return pool.query(
    `INSERT INTO model_provider_calls (${columns.join(",")})
     VALUES (${values.map((_, i) => "$" + (i + 1)).join(",")})`, values);
};

describe("PLT-052 migration 0030 (cache metrics views)", () => {
  it("adds the fingerprint columns with CHECKs that still allow NULL", async () => {
    await insertCall();
    await insertCall({ prefix_tools_sha256: "a".repeat(64), prefix_segment_refs: JSON.stringify(["x"]) });
    await expect(insertCall({ prefix_tools_sha256: "nothex" })).rejects.toMatchObject({ code: "23514" });
    await expect(insertCall({ prefix_segment_refs: JSON.stringify({ a: 1 }) })).rejects.toMatchObject({ code: "23514" });
  });

  it("creates read-only views whose first column is organization_id and that cannot be written", async () => {
    for (const view of VIEWS) {
      const cols = (await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [view]
      )).rows.map(r => r.column_name);
      expect(cols[0], view).toBe("organization_id");
    }
    // The aggregated views are not updatable at all.
    for (const view of VIEWS.slice(1)) {
      await expect(pool.query(`DELETE FROM ${view}`)).rejects.toMatchObject({ code: "55000" });
    }
  });

  it("gives a restricted role SELECT on the views only, using the real provisioning block", async () => {
    const role = "jev_metrics_role_" + randomUUID().replaceAll("-", "");
    const client = await pool.connect();
    try {
      await client.query(`CREATE ROLE "${role}" NOLOGIN`);
      const provision = await readFile(
        path.join(DEFAULT_MIGRATIONS_DIR, "..", "security", "provision-runtime-role.sql"), "utf8"
      );
      const start = provision.indexOf("DO $jev_cache_views$");
      const end = provision.indexOf("$jev_cache_views$;", start + 10) + "$jev_cache_views$;".length;
      expect(start).toBeGreaterThan(0);
      await client.query(provision.slice(start, end).replaceAll("jev_runtime", `"${role}"`));
      await client.query(`SET ROLE "${role}"`);
      for (const view of VIEWS) {
        const read = await client.query(`SELECT organization_id FROM ${view} WHERE organization_id = $1`, [randomUUID()]);
        expect(read.rowCount).toBe(0);
      }
      // No write of any kind, and no direct read of the table it was not given.
      // 42501 = no privilege; 55000 = the view is not even updatable. Either way nothing is written.
      const denied = { code: expect.stringMatching(/^(42501|55000)$/) };
      await expect(client.query(
        "UPDATE model_cache_metrics_by_call SET cache_status = 'HIT'")).rejects.toMatchObject(denied);
      await expect(client.query(
        "DELETE FROM model_cache_metrics_by_call")).rejects.toMatchObject(denied);
      await expect(client.query(
        "INSERT INTO model_cache_metrics_by_project (organization_id) VALUES (gen_random_uuid())")).rejects.toMatchObject(denied);
      await expect(client.query("SELECT 1 FROM model_provider_calls LIMIT 1")).rejects.toMatchObject({ code: "42501" });
      await client.query("RESET ROLE");
      const privileges = await client.query(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee = $1 ORDER BY table_name`, [role]);
      expect(privileges.rows.every(r => r.privilege_type === "SELECT")).toBe(true);
      expect(privileges.rows.map(r => r.table_name).sort()).toEqual([...VIEWS].sort());
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      await client.query(`DROP OWNED BY "${role}"`).catch(() => undefined);
      await client.query(`DROP ROLE IF EXISTS "${role}"`);
      client.release();
    }
  });

  it("states no GRANT/REVOKE in the migration and keeps provisioning free of table-level writes on the views", async () => {
    const migration = await readFile(
      path.join(DEFAULT_MIGRATIONS_DIR, "0030_model_gateway_cache_metrics.sql"), "utf8");
    const code = migration.split("\n").filter(line => !line.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(GRANT|REVOKE)\b/);
    const provision = await readFile(
      path.join(DEFAULT_MIGRATIONS_DIR, "..", "security", "provision-runtime-role.sql"), "utf8");
    expect(provision).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*model_cache_metrics/);
  });

  it("applies over a database that already holds 0029 data", async () => {
    const schema = "jev_mig30_" + randomUUID().replaceAll("-", "");
    const owner = await pool.connect();
    try {
      await owner.query(`CREATE SCHEMA "${schema}"`);
      await owner.query(`SET search_path TO "${schema}", public`);
      const files = (await readdir(DEFAULT_MIGRATIONS_DIR)).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
      const index = files.indexOf("0030_model_gateway_cache_metrics.sql");
      expect(index).toBe(files.length - 1);
      for (const file of files.slice(0, index)) {
        let sql = await readFile(path.join(DEFAULT_MIGRATIONS_DIR, file), "utf8");
        if (file.startsWith("0001_")) sql = sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "");
        await owner.query(sql);
      }
      const org = randomUUID(); const project = randomUUID(); const repo = randomUUID(); const task = randomUUID();
      await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'Legacy')", [org]);
      await owner.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'P')", [project, org]);
      await owner.query("INSERT INTO repositories (id, project_id, full_name, role) VALUES ($1, $2, 'novo34/legacy-30', 'backend')", [repo, project]);
      await owner.query("INSERT INTO tasks (id, project_id, repository_id, title) VALUES ($1, $2, $3, 'T')", [task, project, repo]);
      await owner.query(
        `INSERT INTO model_provider_calls (request_id, organization_id, project_id, task_id, provider, model,
           outcome, attempt_count, usage, cache_read_tokens, cache_status,
           estimated_cost_chf, estimated_cost_without_cache_chf, estimated_cache_savings_chf)
         VALUES ('legacy', $1, $2, $3, 'openai', 'm', 'SUCCESS', 1,
           '{"inputTokens":100,"outputTokens":5}'::jsonb, 300, 'PARTIAL', 0.001, 0.003, 0.002)`,
        [org, project, task]);
      await owner.query(await readFile(path.join(DEFAULT_MIGRATIONS_DIR, files[index]!), "utf8"));
      const call = (await owner.query("SELECT * FROM model_cache_metrics_by_call WHERE organization_id = $1", [org])).rows[0];
      expect(call).toMatchObject({ total_input_tokens: "400", cache_hit_rate: "0.750000", prefix_tools_sha256: null });
      const proj = (await owner.query("SELECT * FROM model_cache_metrics_by_project WHERE organization_id = $1", [org])).rows[0];
      expect(proj).toMatchObject({ calls_total: "1", calls_partial: "1", cache_savings_chf: "0.002000" });
    } finally {
      await owner.query("RESET search_path");
      await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      owner.release();
    }
  });
});
