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

/**
 * Session-level advisory lock key (bigint) that serializes `migrate` across
 * processes and pools sharing one database. Distinct from the staging
 * reservation locks (hashtextextended(..., 53)). pg_advisory_lock needs no
 * special privileges. No lock_timeout: another migrator may legitimately
 * take long, and waiting is the correct behaviour.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = "7406201735001";

export async function migrate(
  pool: Pool,
  migrationsDir = DEFAULT_MIGRATIONS_DIR
): Promise<string[]> {
  const client = await pool.connect();
  let lockHeld = false;
  let releaseError: Error | undefined;

  try {
    try {
      await client.query("SELECT pg_advisory_lock($1::bigint)", [
        MIGRATION_ADVISORY_LOCK_KEY
      ]);
    } catch (lockError) {
      // Unknown whether the lock was taken: destroy the connection.
      releaseError = lockError as Error;
      throw lockError;
    }
    lockHeld = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = (await readdir(migrationsDir))
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort();

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
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          // Connection is in doubt: destroy it so the session lock goes away.
          releaseError = rollbackError as Error;
        }
        throw error;
      }
    }

    return newlyApplied;
  } finally {
    if (lockHeld && !releaseError) {
      try {
        const unlocked = await client.query<{ ok: boolean }>(
          "SELECT pg_advisory_unlock($1::bigint) AS ok",
          [MIGRATION_ADVISORY_LOCK_KEY]
        );
        if (unlocked.rows[0]?.ok !== true) {
          releaseError = new Error("Migration advisory lock was not held");
        }
      } catch (unlockError) {
        releaseError = unlockError as Error;
      }
    }
    // Passing an error destroys the connection (ending the session lock)
    // instead of returning a possibly locked client to the pool.
    client.release(releaseError);
  }
}
