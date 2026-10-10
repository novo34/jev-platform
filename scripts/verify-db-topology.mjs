/**
 * Read-only deployment gate for JEV's canonical PostgreSQL security boundary.
 * This script NEVER provisions, migrates, writes domain data, or logs secrets.
 * It must pass against the real runtime and migrator credentials before rollout.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { assertRestrictedRuntimeRole } from "../packages/db/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guarded = ["approvals", "deployments", "environments", "tasks"];
const controlled = [
  "jev_create_task(uuid,uuid,uuid,text,text,jsonb)",
  "jev_transition_task(uuid,text,text,text,text,jsonb)",
  "jev_create_environment(uuid,uuid,text,text,text,jsonb)",
  "jev_create_deployment(uuid,uuid,uuid,uuid,text,text,text,text,jsonb)",
  "jev_create_approval(uuid,uuid,uuid,text,text,text,text,text,jsonb)",
  "jev_set_deployment_status(uuid,uuid[],text)",
  "jev_lock_project_scope(uuid)"
];

function assert(value, message) {
  if (!value) throw new Error("Production database gate failed: " + message);
}

function parseConnection(value, label) {
  assert(value, label + " is required");
  const url = new URL(value);
  assert(url.protocol === "postgresql:" || url.protocol === "postgres:", label + " must be PostgreSQL");
  assert(url.hostname && url.username && url.pathname.length > 1, label + " needs host, username and database");
  return url;
}

async function validateMigrationHistory(pool) {
  const directory = path.join(root, "packages", "db", "migrations");
  const files = (await readdir(directory)).filter(x => /^\d+_.+\.sql$/.test(x)).sort();
  const query = await pool.query("SELECT version, checksum FROM public.schema_migrations");
  const applied = new Map(query.rows.map(row => [row.version, row.checksum]));
  assert(applied.size === files.length, "migration count differs from source-controlled schema");
  for (const file of files) {
    const sql = await readFile(path.join(directory, file), "utf8");
    const actual = createHash("sha256").update(sql).digest("hex");
    assert(applied.get(file) === actual, "missing or modified migration " + file);
  }
  return files.length;
}

/**
 * A CREATE-on-schema grant is not equivalent to ownership of existing schema
 * objects. Every forward-only migration must be able to ALTER managed tables,
 * sequences, function definitions and any enum/domain types.
 */
async function validateMigratorOwnership(pool) {
  const result = await pool.query(`
    WITH managed AS (
      SELECT c.relowner AS owner_oid
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m')
      UNION ALL
      SELECT p.proowner
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
      UNION ALL
      SELECT t.typowner
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype IN ('e','d')
    )
    SELECT COUNT(*)::integer AS objects_checked,
      COUNT(*) FILTER (WHERE NOT (
        r.rolsuper OR pg_catalog.pg_has_role(current_user, managed.owner_oid, 'USAGE')
      ))::integer AS objects_unmanageable
    FROM managed
    CROSS JOIN pg_catalog.pg_roles r
    WHERE r.rolname = current_user
  `);
  const row = result.rows[0];
  assert(row && row.objects_checked > 0 && row.objects_unmanageable === 0,
    "migration identity cannot manage all existing application schema objects");
  return row.objects_checked;
}

/**
 * A callable SECURITY INVOKER function or a definer with a changed search_path
 * is not a working secure writer, even if EXECUTE is still granted. All writers
 * must have the same trusted owner as the migration ledger.
 */
async function validateControlledWriters(pool) {
  const result = await pool.query(`
    SELECT signatures.signature,
      p.oid IS NOT NULL AS exists,
      p.prosecdef AS security_definer,
      p.proconfig AS config,
      p.proowner = ledger.relowner AS trusted_owner,
      (p.proowner = runtime.oid) AS runtime_owned,
      pg_catalog.has_function_privilege(current_user, p.oid, 'EXECUTE') AS can_execute
    FROM pg_catalog.unnest($1::text[]) AS signatures(signature)
    LEFT JOIN pg_catalog.pg_proc p
      ON p.oid = pg_catalog.to_regprocedure('public.' || signatures.signature)
    CROSS JOIN pg_catalog.pg_class ledger
    JOIN pg_catalog.pg_namespace schema
      ON schema.oid = ledger.relnamespace AND schema.nspname = 'public'
    JOIN pg_catalog.pg_roles runtime ON runtime.rolname = 'jev_runtime'
    WHERE ledger.relname = 'schema_migrations' AND ledger.relkind = 'r'
  `, [controlled]);
  assert(result.rows.length === controlled.length,
    "missing migration ledger or controlled PostgreSQL writers");
  for (const writer of result.rows) {
    const config = writer.config;
    const pinned = Array.isArray(config) && config.length === 1 &&
      config[0].replace(/\s+/g, "") === "search_path=pg_catalog,public,pg_temp";
    assert(writer.exists && writer.security_definer && writer.trusted_owner &&
      !writer.runtime_owned && writer.can_execute && pinned,
      "controlled writer has unsafe owner, execution grant, SECURITY DEFINER or search_path: " +
      writer.signature);
  }
  return result.rows.length;
}

/** Validate the actual DB endpoints supplied by the deployment secret manager. */
export async function verifyDatabaseTopology({ runtimeUrl, migrationUrl }) {
  const runtime = parseConnection(runtimeUrl, "DATABASE_URL");
  const migrator = parseConnection(migrationUrl, "MIGRATION_DATABASE_URL");
  assert(runtime.toString() !== migrator.toString(), "runtime and migrator URLs must differ");
  assert(decodeURIComponent(runtime.username) !== decodeURIComponent(migrator.username),
    "runtime and migrator PostgreSQL usernames must differ");
  assert(runtime.hostname === migrator.hostname && (runtime.port || "5432") === (migrator.port || "5432")
    && runtime.pathname === migrator.pathname,
    "runtime and migration URLs must target the same database endpoint");

  const runtimePool = new Pool({ connectionString: runtime.toString(), max: 2, connectionTimeoutMillis: 5000 });
  const migrationPool = new Pool({ connectionString: migrator.toString(), max: 1, connectionTimeoutMillis: 5000 });
  try {
    await assertRestrictedRuntimeRole(runtimePool);
    const [runtimeIdentity, migrationIdentity] = await Promise.all([
      runtimePool.query("SELECT current_user AS role, current_database() AS db"),
      migrationPool.query("SELECT current_user AS role, current_database() AS db, pg_catalog.has_schema_privilege(current_user,'public','CREATE') AS schema_create")
    ]);
    const app = runtimeIdentity.rows[0];
    const admin = migrationIdentity.rows[0];
    assert(app.role === "jev_runtime", "application must connect using jev_runtime");
    assert(app.role !== admin.role && app.db === admin.db && admin.schema_create,
      "migration connection must be a separate privileged identity on the same database");

    const sql = await readFile(path.join(root, "packages", "db", "security", "verify-runtime-privileges.sql"), "utf8");
    const rows = (await runtimePool.query(sql)).rows;
    assert(rows.length === 4, "expected exactly four guarded privilege rows");
    assert(rows.map(x => x.table_name).sort().join(",") === guarded.join(","),
      "unexpected guarded privilege tables");
    assert(rows.every(x => x.runtime_role === "jev_runtime" && x.direct_dml_boundary === "PASS"),
      "guarded-table privilege diagnostic did not return four PASS results");

    const writers = await validateControlledWriters(runtimePool);
    const managed = await validateMigratorOwnership(migrationPool);
    const counts = await validateMigrationHistory(runtimePool);
    return {
      runtime_role: app.role,
      migrator_is_separate: true,
      protected_tables: guarded.length,
      privilege_checks: "4/4 PASS",
      controlled_writers: writers,
      migrator_objects_checked: managed,
      verified_migrations: counts
    };
  } finally {
    await runtimePool.end();
    await migrationPool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyDatabaseTopology({
      runtimeUrl: process.env.DATABASE_URL,
      migrationUrl: process.env.MIGRATION_DATABASE_URL
    });
    console.log("JEV production database gate PASS:", JSON.stringify(result));
  } catch (error) {
    // Deliberately avoid printing connection URLs, passwords or full driver errors.
    const message = error instanceof Error && error.message.startsWith("Production database gate failed:")
      ? error.message : "Production database gate failed: check DB connectivity and credentials";
    console.error(message);
    process.exitCode = 1;
  }
}
