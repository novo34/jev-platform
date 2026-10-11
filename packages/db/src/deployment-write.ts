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
        "SELECT jev_lock_project_scope($1::uuid) AS id", [projectId]
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

/**
 * Runtime-safe deployment status mutation. The database function owns locking,
 * scope validation and the atomic update. Unlike withDeploymentWriteScopes,
 * this entry point requires no direct UPDATE privilege on deployments.
 */
export async function setDeploymentStatuses(
  pool: Pool,
  projectId: string,
  deploymentIds: readonly string[],
  status: "READY" | "RUNNING" | "VERIFYING" | "VERIFIED" | "BLOCKED" | "FAILED" | "REJECTED"
): Promise<number> {
  if (!projectId || deploymentIds.length === 0) {
    throw new Error("Project ID and at least one deployment ID are required");
  }
  const result = await pool.query<{ updated_count: number }>(
    "SELECT jev_set_deployment_status($1::uuid, $2::uuid[], $3::text) AS updated_count",
    [projectId, [...new Set(deploymentIds)].sort(), status]
  );
  return result.rows[0].updated_count;
}
