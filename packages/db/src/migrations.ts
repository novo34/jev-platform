import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

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

// Session-level advisory lock key shared by every migrate() caller so that
// concurrent processes/test files apply schema changes strictly one at a time.
const MIGRATION_LOCK_KEY_SQL = "hashtextextended('jev:schema-migrations', 0)";

export async function migrate(
  pool: Pool,
  migrationsDir = DEFAULT_MIGRATIONS_DIR
): Promise<string[]> {
  const files = (await readdir(migrationsDir))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();

  // A session lock lives on one connection: use a dedicated client for the
  // lock and every statement, never pool.query (which may switch connections).
  const client = await pool.connect();
  let releaseError: Error | undefined;

  try {
    await client.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY_SQL})`);

    try {
      return await applyPending(client, files, migrationsDir);
    } finally {
      try {
        await client.query(
          `SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY_SQL})`
        );
      } catch (unlockError) {
        // Destroy the connection so PostgreSQL drops the session lock.
        releaseError =
          unlockError instanceof Error
            ? unlockError
            : new Error(String(unlockError));
      }
    }
  } catch (error) {
    // Lock acquisition or connection failure: never return a suspect
    // connection to the pool.
    releaseError ??= error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    client.release(releaseError);
  }
}

async function applyPending(
  client: PoolClient,
  files: string[],
  migrationsDir: string
): Promise<string[]> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Read under the lock: another process may have applied migrations while
  // this one was waiting.
  const appliedResult = await client.query<AppliedMigration>(
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
    }
  }

  return newlyApplied;
}
