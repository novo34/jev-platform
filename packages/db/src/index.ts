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
 * Enforced by default for production API/worker processes.
 * Migrations deliberately use a separate privileged connection and must not
 * call this runtime startup check. This is a startup guard, not a replacement for SQL GRANTs.
 */
export async function assertRestrictedRuntimeRole(pool: Pool): Promise<void> {
  const result = await pool.query<{
    role_name: string;
    elevated: boolean;
    owns_guarded: boolean;
    can_write_guarded: boolean;
    can_switch_roles: boolean;
    guarded_table_count: number;
  }>(`
    SELECT current_user AS role_name,
           (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls) AS elevated,
           (SELECT COUNT(*)::int FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema()
               AND c.relkind IN ('r','p')
               AND c.relname IN ('tasks','approvals','deployments','environments')
           ) AS guarded_table_count,
           EXISTS (
             SELECT 1 FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema()
               AND c.relname IN ('tasks', 'approvals', 'deployments', 'environments')
               AND pg_has_role(current_user, c.relowner, 'MEMBER')
           ) AS owns_guarded,
           EXISTS (
             SELECT 1 FROM pg_roles accessible
             WHERE accessible.rolname <> current_user
               AND pg_has_role(current_user, accessible.oid, 'SET')
           ) AS can_switch_roles,
           EXISTS (
             SELECT 1 FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema()
               AND c.relkind IN ('r', 'p')
               AND c.relname IN ('tasks', 'approvals', 'deployments', 'environments')
               AND (
                 has_table_privilege(c.oid, 'INSERT')
                 OR has_table_privilege(c.oid, 'UPDATE')
                 OR has_table_privilege(c.oid, 'DELETE')
                 OR EXISTS (
                   SELECT 1 FROM pg_attribute a
                   WHERE a.attrelid = c.oid
                     AND a.attnum > 0 AND NOT a.attisdropped
                     AND (
                       has_column_privilege(c.oid, a.attnum, 'INSERT')
                       OR has_column_privilege(c.oid, a.attnum, 'UPDATE')
                     )
                 )
               )
           ) AS can_write_guarded
    FROM pg_roles r WHERE r.rolname = current_user
  `);
  const role = result.rows[0];
  if (!role || role.guarded_table_count !== 4 || role.elevated || role.owns_guarded || role.can_switch_roles || role.can_write_guarded) {
    throw new Error(
      `Unsafe JEV runtime database role: ${role?.role_name ?? "unknown"}; ` +
      "use a restricted application credential, not the migration owner"
    );
  }
}

export async function checkDatabase(pool: Pool): Promise<void> {
  if (process.env.NODE_ENV === "production" || process.env.JEV_ENFORCE_RUNTIME_ROLE === "1") {
    await assertRestrictedRuntimeRole(pool);
  }
  await pool.query("SELECT 1");
}

export { migrate, DEFAULT_MIGRATIONS_DIR } from "./migrations.js";
export { withDeploymentWriteScopes, setDeploymentStatuses } from "./deployment-write.js";
