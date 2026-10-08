import { Pool, type PoolConfig } from "pg";

export function createDatabasePool(config?: PoolConfig): Pool {
  const connectionString = config?.connectionString ?? process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  return new Pool({
    ...config,
    connectionString
  });
}

export async function checkDatabase(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}

export { migrate, DEFAULT_MIGRATIONS_DIR } from "./migrations.js";
export { withDeploymentWriteScopes } from "./deployment-write.js";
