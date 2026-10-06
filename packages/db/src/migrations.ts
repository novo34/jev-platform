import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = path.resolve(
  CURRENT_DIR,
  "../migrations"
);

interface AppliedMigration {
  version: string;
  checksum: string;
}

function checksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function migrate(
  pool: Pool,
  migrationsDir = DEFAULT_MIGRATIONS_DIR
): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();

  const appliedResult = await pool.query<AppliedMigration>(
    "SELECT version, checksum FROM schema_migrations"
  );
  const applied = new Map(
    appliedResult.rows.map((row) => [row.version, row.checksum])
  );

  const newlyApplied: string[] = [];

  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    const sql = await readFile(fullPath, "utf8");
    const digest = checksum(sql);
    const existingChecksum = applied.get(file);

    if (existingChecksum) {
      if (existingChecksum !== digest) {
        throw new Error(`Applied migration checksum mismatch: ${file}`);
      }
      continue;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
        [file, digest]
      );
      await client.query("COMMIT");
      newlyApplied.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return newlyApplied;
}
