import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, DEFAULT_MIGRATIONS_DIR } from "./index.js";
import { migrate } from "./migrations.js";

const CONCURRENCY = 8;
const adminPool = createDatabasePool();
const created: string[] = [];

function urlFor(database: string): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = `/${database}`;
  return url.toString();
}

async function freshDatabase(): Promise<Pool> {
  const name = `jev_migrate_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await adminPool.query(`CREATE DATABASE ${name}`);
  created.push(name);
  return createDatabasePool({ connectionString: urlFor(name), max: CONCURRENCY + 2 });
}

beforeAll(() => {
  expect(process.env.DATABASE_URL).toBeTruthy();
});

afterAll(async () => {
  for (const name of created) {
    await adminPool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
  await adminPool.end();
});

describe("migrate under concurrency", () => {
  it("applies every migration exactly once with concurrent callers on an empty database", async () => {
    const pool = await freshDatabase();
    try {
      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => migrate(pool))
      );
      const expected = (await readdir(DEFAULT_MIGRATIONS_DIR))
        .filter((file) => /^\d+_.+\.sql$/.test(file))
        .sort();

      // Exactly one caller applied each migration; the rest saw them as done.
      expect(results.flat().sort()).toEqual(expected);

      const rows = await pool.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version"
      );
      expect(rows.rows.map((row) => row.version)).toEqual(expected);

      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'`
      );
      const names = tables.rows.map((row) => row.table_name);
      for (const table of ["organizations", "tasks", "model_provider_calls", "orders"]) {
        expect(names).toContain(table);
      }
      // Idempotent afterwards.
      expect(await migrate(pool)).toEqual([]);
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("releases the advisory lock after a failing migration", async () => {
    const pool = await freshDatabase();
    const dir = await mkdtemp(path.join(os.tmpdir(), "jev-migrations-"));
    try {
      await writeFile(path.join(dir, "0001_ok.sql"), "CREATE TABLE lock_probe (id INT);");
      await writeFile(path.join(dir, "0002_bad.sql"), "THIS IS NOT SQL;");

      await expect(migrate(pool, dir)).rejects.toThrow();

      // No session still holds the migration lock.
      const locks = await pool.query(
        `SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
           AND objid = (hashtextextended('jev:schema-migrations', 0) & 4294967295)::oid`
      );
      expect(locks.rowCount).toBe(0);

      await writeFile(path.join(dir, "0002_bad.sql"), "CREATE TABLE lock_probe_2 (id INT);");
      const next = await Promise.race([
        migrate(pool, dir),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("migrate blocked: lock leaked")), 10_000)
        )
      ]);
      // 0001 was committed before the failure; only 0002 remains.
      expect(next).toEqual(["0002_bad.sql"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await pool.end();
    }
  }, 60_000);
});
