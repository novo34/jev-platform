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
export async function assertRestrictedRuntimeRole(
  pool: Pool,
  applicationSchema = "public"
): Promise<void> {
  // The deployment role is provisioned for the canonical application schema.
  // Never infer the security boundary from search_path/pg_catalog.current_schema().
  // Passing another schema is reserved for isolated migration/test fixtures.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(applicationSchema)) {
    throw new Error("Invalid JEV application schema");
  }
  const result = await pool.query<{
    role_name: string;
    authenticated_role: string;
    active_schema: string | null;
    elevated: boolean;
    owns_guarded: boolean;
    can_write_guarded: boolean;
    has_role_memberships: boolean;
    can_create_in_schema: boolean;
    guarded_table_count: number;
  }>(`
    SELECT current_user AS role_name,
           session_user AS authenticated_role,
           pg_catalog.current_schema() AS active_schema,
           pg_catalog.has_schema_privilege(current_user, $1::text, 'CREATE') AS can_create_in_schema,
           (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication) AS elevated,
           (SELECT COUNT(*)::int FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1::text
               AND c.relkind IN ('r','p')
               AND c.relname IN ('tasks','approvals','deployments','environments')
           ) AS guarded_table_count,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1::text
               AND c.relname IN ('tasks', 'approvals', 'deployments', 'environments')
               AND pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER')
           ) AS owns_guarded,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_roles accessible
             WHERE accessible.rolname <> current_user
               AND pg_catalog.pg_has_role(current_user, accessible.oid, 'MEMBER')
           ) AS has_role_memberships,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1::text
               AND c.relkind IN ('r', 'p')
               AND c.relname IN ('tasks', 'approvals', 'deployments', 'environments')
               AND (
                 pg_catalog.has_table_privilege(c.oid, 'INSERT')
                 OR pg_catalog.has_table_privilege(c.oid, 'UPDATE')
                 OR pg_catalog.has_table_privilege(c.oid, 'DELETE')
                 OR pg_catalog.has_table_privilege(c.oid, 'TRUNCATE')
                 OR pg_catalog.has_table_privilege(c.oid, 'TRIGGER')
                 OR EXISTS (
                   SELECT 1 FROM pg_catalog.pg_attribute a
                   WHERE a.attrelid = c.oid
                     AND a.attnum > 0 AND NOT a.attisdropped
                     AND (
                       pg_catalog.has_column_privilege(c.oid, a.attnum, 'INSERT')
                       OR pg_catalog.has_column_privilege(c.oid, a.attnum, 'UPDATE')
                     )
                 )
               )
           ) AS can_write_guarded
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user
  `, [applicationSchema]);
  const role = result.rows[0];
  if (!role || (applicationSchema === "public" && (role.authenticated_role !== "jev_runtime" || role.role_name !== role.authenticated_role)) || role.active_schema !== applicationSchema || role.guarded_table_count !== 4 || role.elevated || role.owns_guarded || role.has_role_memberships || role.can_create_in_schema || role.can_write_guarded) {
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
export { createApproval, createDeployment } from "./review-write.js";
export type { CreateApprovalInput, CreateDeploymentInput } from "./review-write.js";
