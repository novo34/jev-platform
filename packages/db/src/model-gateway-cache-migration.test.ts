import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, DEFAULT_MIGRATIONS_DIR } from "./index.js";
import { migrate } from "./migrations.js";

const pool = createDatabasePool();
const organizationId = randomUUID();
const projectId = randomUUID();
const taskId = randomUUID();
const repositoryId = randomUUID();

const insertCall = (extra: Record<string, unknown> = {}, provider = "openai") => {
  const columns = ["request_id", "organization_id", "project_id", "task_id", "provider",
    "model", "outcome", "attempt_count", ...Object.keys(extra)];
  const values = [randomUUID(), organizationId, projectId, taskId, provider, "m", "SUCCESS", 1,
    ...Object.values(extra)];
  return pool.query(
    `INSERT INTO model_provider_calls (${columns.join(",")})
     VALUES (${values.map((_, i) => "$" + (i + 1)).join(",")})`, values
  );
};

beforeAll(async () => {
  await migrate(pool);
  await pool.query("INSERT INTO organizations (id, name) VALUES ($1, 'Cache Migration Org')", [organizationId]);
  await pool.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'P')", [projectId, organizationId]);
  await pool.query("INSERT INTO repositories (id, project_id, full_name, role) VALUES ($1, $2, 'novo34/cache-migration', 'backend')", [repositoryId, projectId]);
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

describe("PLT-052 migration 0029 (prompt cache accounting)", () => {
  it("admits anthropic in both provider CHECKs and still rejects unknown providers", async () => {
    await insertCall({}, "anthropic");
    await expect(insertCall({}, "mystery")).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      `INSERT INTO provider_credentials (organization_id, provider, ciphertext, iv, auth_tag, last_four)
       VALUES ($1, 'mystery', 'c', 'i', 't', 'abcd')`, [organizationId]
    )).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `INSERT INTO provider_credentials (organization_id, provider, ciphertext, iv, auth_tag, last_four)
       VALUES ($1, 'anthropic', 'c', 'i', 't', 'abcd')`, [organizationId]
    );
    await pool.query("DELETE FROM provider_credentials WHERE organization_id = $1", [organizationId]);
  });

  it("defaults cache columns to zero/null and accepts negative savings", async () => {
    const requestId = randomUUID();
    await pool.query(
      `INSERT INTO model_provider_calls (request_id, organization_id, project_id, task_id, provider, model,
         outcome, attempt_count, estimated_cache_savings_chf)
       VALUES ($1, $2, $3, $4, 'openai', 'm', 'SUCCESS', 1, -0.010000)`,
      [requestId, organizationId, projectId, taskId]
    );
    const row = (await pool.query("SELECT * FROM model_provider_calls WHERE request_id = $1", [requestId])).rows[0];
    expect(row).toMatchObject({
      cache_read_tokens: "0", cache_write_tokens: "0", cache_write_5m_tokens: "0",
      cache_write_1h_tokens: "0", cache_status: null, cache_reason: null,
      prefix_project_sha256: null, prefix_task_sha256: null,
      estimated_cost_without_cache_chf: null
    });
    expect(Number(row.estimated_cache_savings_chf)).toBe(-0.01);
  });

  it("enforces the cache CHECK constraints", async () => {
    for (const status of ["HIT", "PARTIAL", "MISS", "WRITE", "DISABLED", "BELOW_MINIMUM", "ERROR", "UNSUPPORTED"]) {
      await insertCall({ cache_status: status });
    }
    const hash = "a".repeat(64);
    await insertCall({ prefix_project_sha256: hash, prefix_task_sha256: hash });
    const bad: Array<Record<string, unknown>> = [
      { cache_status: "NOT_ESTIMABLE" },
      { cache_read_tokens: -1 },
      { cache_write_tokens: -1 },
      { cache_write_5m_tokens: -1, cache_write_tokens: 0 },
      { cache_write_1h_tokens: -1 },
      { prefix_project_sha256: "A".repeat(64) },
      { prefix_task_sha256: "abc" },
      { estimated_cost_without_cache_chf: -1 },
      // TTL split cannot exceed the total write.
      { cache_write_tokens: 10, cache_write_5m_tokens: 6, cache_write_1h_tokens: 5 }
    ];
    for (const extra of bad) {
      await expect(insertCall(extra), JSON.stringify(extra)).rejects.toMatchObject({ code: "23514" });
    }
    await insertCall({ cache_write_tokens: 11, cache_write_5m_tokens: 6, cache_write_1h_tokens: 5 });
  });

  it("keeps no SELECT/UPDATE/DELETE grant added: the runtime INSERT grant stays table-level", async () => {
    const provision = await readFile(
      path.join(DEFAULT_MIGRATIONS_DIR, "..", "security", "provision-runtime-role.sql"), "utf8"
    );
    const grant = provision.split("\n").find(line =>
      /^GRANT INSERT ON TABLE model_provider_calls, cost_events TO jev_runtime;/.test(line));
    // Table-level INSERT automatically covers columns added by 0029.
    expect(grant).toBeDefined();
    expect(provision).not.toMatch(/GRANT[^;]*(SELECT|UPDATE|DELETE)[^;]*model_provider_calls/);
    const migration = await readFile(
      path.join(DEFAULT_MIGRATIONS_DIR, "0029_model_gateway_prompt_cache.sql"), "utf8"
    );
    const code = migration.split("\n").filter(line => !line.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(GRANT|REVOKE)\b/);
  });

  it("gives a restricted role INSERT on the new columns and nothing else, using the real GRANT line", async () => {
    const role = "jev_cache_role_" + randomUUID().replaceAll("-", "");
    const client = await pool.connect();
    try {
      await client.query(`CREATE ROLE "${role}" NOLOGIN`);
      const provision = await readFile(
        path.join(DEFAULT_MIGRATIONS_DIR, "..", "security", "provision-runtime-role.sql"), "utf8"
      );
      const grant = provision.split("\n").find(line =>
        line.startsWith("GRANT INSERT ON TABLE model_provider_calls, cost_events TO jev_runtime"))!;
      await client.query(grant.replace("jev_runtime", `"${role}"`));
      const columns = ["cache_read_tokens", "cache_write_tokens", "cache_write_5m_tokens",
        "cache_write_1h_tokens", "cache_status", "cache_reason", "prefix_project_sha256",
        "prefix_task_sha256", "estimated_cost_without_cache_chf", "estimated_cache_savings_chf"];
      for (const column of columns) {
        const privileges = await client.query(
          `SELECT has_column_privilege($1, 'model_provider_calls', $2, 'INSERT') AS i,
                  has_column_privilege($1, 'model_provider_calls', $2, 'UPDATE') AS u,
                  has_column_privilege($1, 'model_provider_calls', $2, 'SELECT') AS s`,
          [role, column]
        );
        expect(privileges.rows[0], column).toEqual({ i: true, u: false, s: false });
      }
    } finally {
      await client.query(`REVOKE ALL ON TABLE model_provider_calls, cost_events FROM "${role}"`).catch(() => undefined);
      await client.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
      client.release();
    }
  });
});
