import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabasePool, DEFAULT_MIGRATIONS_DIR } from "./index.js";

const pool = createDatabasePool();
const MIGRATION = "0032_task_history_commit_order.sql";

afterAll(async () => {
  await pool.end();
});

describe("migration 0032 (task history ordered by write time)", () => {
  it("switches the created_at default to clock_timestamp() and keeps history immutable", async () => {
    const schema = "jev_mig32_" + randomUUID().replaceAll("-", "");
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
      const defaultOf = async () =>
        (await owner.query(
          `SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
             FROM pg_attrdef d
             JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
            WHERE d.adrelid = to_regclass($1) AND a.attname = 'created_at'`,
          [`"${schema}".task_state_history`])).rows[0].expr as string;
      expect(await defaultOf()).toMatch(/now\(\)/i);
      await owner.query(await readFile(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), "utf8"));
      expect(await defaultOf()).toMatch(/clock_timestamp\(\)/i);

      // Rows written by the trigger inside ONE transaction now differ in time, and
      // the history stays append-only.
      const org = randomUUID(); const project = randomUUID(); const order = randomUUID();
      await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'O')", [org]);
      await owner.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'P')", [project, org]);
      await owner.query("INSERT INTO orders (id, project_id, objective) VALUES ($1, $2, 'x')", [order, project]);
      const repo = randomUUID();
      await owner.query(
        `INSERT INTO repositories (id, project_id, full_name, role, primary_repository, default_branch, staging_branch)
         VALUES ($1, $2, 'novo34/mig32', 'backend', TRUE, 'main', 'staging')`, [repo, project]);
      await owner.query("BEGIN");
      const task = (await owner.query(
        "INSERT INTO tasks (order_id, project_id, repository_id, title, status) VALUES ($1, $2, $3, 't', 'PLANNED') RETURNING id",
        [order, project, repo])).rows[0].id;
      await owner.query("UPDATE tasks SET status = 'READY' WHERE id = $1", [task]);
      await owner.query("COMMIT");
      const rows = (await owner.query(
        "SELECT created_at FROM task_state_history WHERE task_id = $1 ORDER BY (from_status IS NOT NULL)", [task])).rows;
      expect(rows).toHaveLength(2);
      expect(rows[1].created_at.getTime()).toBeGreaterThanOrEqual(rows[0].created_at.getTime());
      await expect(owner.query("UPDATE task_state_history SET cause = 'x' WHERE task_id = $1", [task]))
        .rejects.toMatchObject({ code: "23514" });
    } finally {
      await owner.query("ROLLBACK").catch(() => undefined);
      await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      owner.release();
    }
  });
});
