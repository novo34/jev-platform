import type { Pool, PoolClient } from "pg";

/**
 * Transaction boundary for deployment mutations. Scope locks are acquired
 * before any deployment rows are touched. All writers must use this protocol;
 * database privileges must ultimately prevent direct DML bypass.
 *
 * Callers must not perform other writes before entering this function.
 * The callback runs on the SAME PostgreSQL connection and transaction.
 */
export async function withDeploymentWriteScopes<T>(
  pool: Pool,
  projectIds: readonly string[],
  write: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (projectIds.length === 0) {
    throw new Error("At least one project scope is required");
  }
  const scopes = [...new Set(projectIds)].sort();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A project row is the stable parent of its repositories, environments,
    // tasks and deployments. NO KEY UPDATE avoids conflicting with FK
    // KEY SHARE checks on projects during child-row inserts.
    for (const projectId of scopes) {
      const result = await client.query(
        "SELECT id FROM projects WHERE id = $1 FOR NO KEY UPDATE", [projectId]
      );
      if (result.rowCount !== 1) {
        throw new Error(`Unknown project scope: ${projectId}`);
      }
    }
    const result = await write(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
