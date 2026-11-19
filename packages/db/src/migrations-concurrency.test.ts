import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "./index.js";
import { MIGRATION_ADVISORY_LOCK_KEY } from "./migrations.js";


const baseUrl = new URL(process.env.DATABASE_URL ?? "");
const dbName = "jev_migconc_" + randomUUID().replaceAll("-", "").slice(0, 16);
const testUrl = new URL(baseUrl);
testUrl.pathname = "/" + dbName;

const admin = new pg.Pool({ connectionString: baseUrl.toString(), max: 1 });
const pools: pg.Pool[] = [];
const tmpDirs: string[] = [];

function newPool(max = 2): pg.Pool {
  const pool = new pg.Pool({ connectionString: testUrl.toString(), max });
  pool.on("error", () => {});
  pools.push(pool);
  return pool;
}

async function freshDatabase(): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
}

async function advisoryLockCount(pool: pg.Pool): Promise<number> {
  const result = await pool.query(
    "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())"
  );
  return result.rows[0].n;
}

const sqlFiles = async () =>
  (await readdir(DEFAULT_MIGRATIONS_DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

beforeAll(async () => {
  await freshDatabase();
});

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.end();
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("migrate concurrency", () => {
  it("serializes concurrent migrators on an empty database", async () => {
    const concurrent = 8;
    const results = await Promise.all(
      Array.from({ length: concurrent }, () => migrate(newPool()))
    );
    const files = await sqlFiles();

    // Exactly one caller applied each file.
    expect(results.flat().sort()).toEqual(files);

    const verifier = newPool(1);
    const rows = (
      await verifier.query("SELECT version, checksum FROM schema_migrations ORDER BY version")
    ).rows;
    expect(rows.map((r) => r.version)).toEqual(files);
    for (const row of rows) {
      const sql = await readFile(path.join(DEFAULT_MIGRATIONS_DIR, row.version), "utf8");
      expect(row.checksum).toBe(createHash("sha256").update(sql).digest("hex"));
    }

    // A second concurrent round applies nothing.
    const second = await Promise.all(
      Array.from({ length: concurrent }, () => migrate(newPool()))
    );
    expect(second.every((r) => r.length === 0)).toBe(true);
    expect(await advisoryLockCount(verifier)).toBe(0);
  }, 120_000);

  it("releases the lock after a failing migration and after checksum mismatch", async () => {
    await freshDatabase();
    const dir = await mkdtemp(path.join(os.tmpdir(), "jev-mig-"));
    tmpDirs.push(dir);
    await writeFile(path.join(dir, "0001_ok.sql"), "CREATE TABLE t_ok (id int);");
    await writeFile(path.join(dir, "0002_bad.sql"), "THIS IS NOT SQL;");

    // Single-connection pool: if the lock/connection leaked, the next call hangs.
    const pool = newPool(1);
    await expect(migrate(pool, dir)).rejects.toThrow();
    expect(await advisoryLockCount(pool)).toBe(0);

    await writeFile(path.join(dir, "0002_bad.sql"), "CREATE TABLE t_good (id int);");
    expect(await migrate(pool, dir)).toEqual(["0002_bad.sql"]);

    await writeFile(path.join(dir, "0001_ok.sql"), "CREATE TABLE t_ok (id int); -- changed");
    await expect(migrate(pool, dir)).rejects.toThrow(/checksum mismatch: 0001_ok.sql/);
    expect(await advisoryLockCount(pool)).toBe(0);

    // A different pool can still acquire the lock immediately.
    const other = newPool(1);
    const got = await other.query("SELECT pg_try_advisory_lock($1::bigint) AS ok", [
      MIGRATION_ADVISORY_LOCK_KEY
    ]);
    expect(got.rows[0].ok).toBe(true);
    await other.query("SELECT pg_advisory_unlock_all()");
  }, 60_000);
});
