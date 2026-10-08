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

/**
 * Fail closed when an application starts with schema-owner credentials.
 * Set JEV_ENFORCE_RUNTIME_ROLE=1 in deployed API/worker processes.
 * Migrations deliberately use a separate privileged connection and must not
 * set this flag. This is a startup guard, not a replacement for SQL GRANTs.
 */
export async function assertRestrictedRuntimeRole(pool: Pool): Promise<void> {
  const result = await pool.query<{
    role_name: string;
    elevated: boolean;
    owns_guarded: boolean;
    can_write_guarded: boolean;
  }>(`
    SELECT current_user AS role_name,
           (r.rolsuper OR r.rolcreaterole OR r.rolbypassrls) AS elevated,
           EXISTS (
             SELECT 1 FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema()
               AND c.relname IN ('tasks', 'approvals', 'deployments', 'environments')
               AND pg_has_role(current_user, c.relowner, 'MEMBER')
           ) AS owns_guarded,
           EXISTS (
             SELECT 1 FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema()
               AND c.relname IN ('tasks', 'approvals', 'deployments', 'environments')
               AND (has_table_privilege(c.oid, 'INSERT')
                 OR has_table_privilege(c.oid, 'UPDATE')
                 OR has_table_privilege(c.oid, 'DELETE'))
           ) AS can_write_guarded
    FROM pg_roles r WHERE r.rolname = current_user
  `);
  const role = result.rows[0];
  if (!role || role.elevated || role.owns_guarded || role.can_write_guarded) {
    throw new Error(
      `Unsafe JEV runtime database role: ${role?.role_name ?? "unknown"}; ` +
      "use a restricted application credential, not the migration owner"
    );
  }
}

export async function checkDatabase(pool: Pool): Promise<void> {
  if (process.env.JEV_ENFORCE_RUNTIME_ROLE === "1") {
    await assertRestrictedRuntimeRole(pool);
  }
  await pool.query("SELECT 1");
}

export { migrate, DEFAULT_MIGRATIONS_DIR } from "./migrations.js";
export { withDeploymentWriteScopes } from "./deployment-write.js";
