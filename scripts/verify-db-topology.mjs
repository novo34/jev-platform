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

/**
 * Audited source of truth for the final PL/pgSQL body of each approved writer.
 * Old numbered migrations are immutable. Later CREATE OR REPLACE definitions
 * supersede earlier ones; compare the live pg_proc.prosrc, not just its ACLs.
 */
const auditedWriterFiles = new Map([
  ["jev_create_task(uuid,uuid,uuid,text,text,jsonb)", "0013_controlled_task_environment_writers.sql"],
  ["jev_transition_task(uuid,text,text,text,text,jsonb)", "0013_controlled_task_environment_writers.sql"],
  ["jev_create_environment(uuid,uuid,text,text,text,jsonb)", "0013_controlled_task_environment_writers.sql"],
  ["jev_create_deployment(uuid,uuid,uuid,uuid,text,text,text,text,jsonb)", "0015_controlled_approval_deployment_creation.sql"],
  ["jev_create_approval(uuid,uuid,uuid,text,text,text,text,text,jsonb)", "0017_atomic_approved_task_rework.sql"],
  ["jev_set_deployment_status(uuid,uuid[],text)", "0011_scope_controlled_writer_to_schema.sql"],
  ["jev_lock_project_scope(uuid)", "0014_controlled_project_scope_lock.sql"]
]);

function extractAuditedWriterBody(sql, signature) {
  const name = signature.slice(0, signature.indexOf("("));
  const start = sql.search(new RegExp(
    "CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+" + name + "\\s*\\(", "i"
  ));
  assert(start >= 0, "audited function definition not found for " + name);
  const tail = sql.slice(start);
  const opening = /\bAS\s+(\$[a-zA-Z_0-9]*\$)/.exec(tail);
  assert(opening, "audited PL/pgSQL function delimiter not found for " + name);
  const bodyStart = start + opening.index + opening[0].length;
  const bodyEnd = sql.indexOf(opening[1], bodyStart);
  assert(bodyEnd >= 0, "audited PL/pgSQL function body is unterminated for " + name);
  return sql.slice(bodyStart, bodyEnd);
}


function assert(value, message) {
  if (!value) throw new Error("Production database gate failed: " + message);
}

function parseConnection(value, label) {
  assert(value, label + " is required");
  const url = new URL(value);
  assert(url.protocol === "postgresql:" || url.protocol === "postgres:", label + " must be PostgreSQL");
  assert(url.hostname && url.username && url.pathname.length > 1, label + " needs host, username and database");
  // libpq-compatible parsers can treat these query parameters as connection
  // endpoint overrides even when the URL authority looks identical.
  // Connection options such as options=-c role=jev_runtime can make a
  // superuser login appear restricted via current_user while session_user
  // stays privileged and RESET ROLE remains available. Admit only the
  // explicitly supported, non-role-changing query parameters.
  const allowed = new Set(["sslmode", "application_name", "connect_timeout"]);
  const forbidden = new Set(["host", "hostaddr", "port", "dbname", "database", "user", "password", "service"]);
  for (const [key] of url.searchParams) {
    assert(!forbidden.has(key), label + " has forbidden connection endpoint override: " + key);
    assert(allowed.has(key), label + " has forbidden connection option: " + key);
  }
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
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend dependency
          WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
            AND dependency.objid = c.oid
            AND dependency.deptype = 'e'
        )
      UNION ALL
      SELECT p.proowner
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend dependency
          WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            AND dependency.objid = p.oid
            AND dependency.deptype = 'e'
        )
      UNION ALL
      SELECT t.typowner
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype IN ('e','d')
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend dependency
          WHERE dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
            AND dependency.objid = t.oid
            AND dependency.deptype = 'e'
        )
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
      p.prosrc AS function_body,
      language.lanname AS function_language,
      p.proowner = ledger.relowner AS trusted_owner,
      (p.proowner = runtime.oid) AS runtime_owned,
      pg_catalog.has_function_privilege(current_user, p.oid, 'EXECUTE') AS can_execute,
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
        ) AS acl
        WHERE acl.privilege_type = 'EXECUTE'
          AND (
            acl.grantee NOT IN (p.proowner, runtime.oid)
            OR (acl.grantee = runtime.oid AND acl.is_grantable)
          )
      ) AS safe_execute_acl
    FROM pg_catalog.unnest($1::text[]) AS signatures(signature)
    LEFT JOIN pg_catalog.pg_proc p
      ON p.oid = pg_catalog.to_regprocedure('public.' || signatures.signature)
    LEFT JOIN pg_catalog.pg_language language ON language.oid = p.prolang
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
      !writer.runtime_owned && writer.can_execute && writer.safe_execute_acl && pinned,
      "controlled writer has unsafe owner, EXECUTE ACL, SECURITY DEFINER or search_path: " +
      writer.signature);
    const auditedFile = auditedWriterFiles.get(writer.signature);
    assert(auditedFile && writer.function_language === "plpgsql",
      "controlled writer has unsupported SQL language or missing audited source");
    const auditedSql = await readFile(path.join(
      root, "packages", "db", "migrations", auditedFile
    ), "utf8");
    assert(writer.function_body === extractAuditedWriterBody(auditedSql, writer.signature),
      "controlled writer implementation drifted from immutable audited migrations: " +
      writer.signature);
  }
  return result.rows.length;
}

/**
 * Database-wide allowlist: a SECURITY DEFINER in ANY non-system schema
 * usable by jev_runtime can perform owner-privileged DML, not only those in
 * public. A trigger function may be invoked through an attacker-owned TEMP
 * table, so trigger routines are included; extension members are excluded.
 *
 * Fail closed even if the extra function currently has EXECUTE revoked:
 * making an unknown owner-privileged entry point callable must require a new
 * explicit review/allowlist update, not a silent ACL change.
 */
async function validateDefinerSurface(pool) {
  const results = await pool.query(`
    SELECT p.oid::pg_catalog.regprocedure::text AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND ns.nspname NOT LIKE 'pg_temp_%'
      AND ns.nspname NOT LIKE 'pg_toast_temp_%'
      AND pg_catalog.has_schema_privilege(current_user, ns.oid, 'USAGE')
      AND p.prosecdef
      -- Do not limit to prokind='f': SECURITY DEFINER procedures (prokind='p')
      -- are CALL-able with PUBLIC EXECUTE and are equally privileged.
      -- Trigger functions are also dangerous: PUBLIC TEMP allows runtime to
      -- attach PUBLIC-executable SECURITY DEFINER triggers to temp tables.
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend dependency
        WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND dependency.objid = p.oid
          AND dependency.deptype = 'e'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest($1::text[]) AS allowed(signature)
        WHERE p.oid = pg_catalog.to_regprocedure('public.' || allowed.signature)
      )
    ORDER BY p.oid::pg_catalog.regprocedure::text
  `, [controlled]);
  assert(results.rows.length === 0,
    "unapproved SECURITY DEFINER routine exists outside the controlled writer allowlist");
}


/**
 * Verify all application trigger bindings and their final audited bodies.
 * A writer that calls an approval trigger is not safe if that trigger is
 * disabled, replaced, detached or rebound. Only schema-migration definitions
 * are trusted; an unchanged schema_migrations ledger is not sufficient.
 */
async function validateTriggerInvariants(pool) {
  const directory = path.join(root, "packages", "db", "migrations");
  const files = (await readdir(directory)).filter(x => /^\d+_.+\.sql$/.test(x)).sort();
  const sources = await Promise.all(files.map(async file => ({
    file, sql: await readFile(path.join(directory, file), "utf8")
  })));
  const expected = new Map();
  const triggerPattern = /CREATE\s+TRIGGER\s+([a-z_][\w]*)\s+([\s\S]*?)\s+ON\s+([a-z_][\w]*)\s+([\s\S]*?)\s+EXECUTE\s+FUNCTION\s+([a-z_][\w]*)\s*\(\s*\)\s*;/gi;
  for (const source of sources) {
    for (const found of source.sql.matchAll(triggerPattern)) {
      const [, name, eventClause, table, rowClause, functionName] = found;
      const cols = /\bUPDATE\s+OF\s+([\s\S]*)$/i.exec(eventClause);
      const updateColumns = cols
        ? cols[1].split(",").map(x => x.trim()).filter(Boolean).sort() : [];
      const type = (/\bROW\b/i.test(rowClause) ? 1 : 0)
        | (/\bBEFORE\b/i.test(eventClause) ? 2 : 0)
        | (/\bINSERT\b/i.test(eventClause) ? 4 : 0)
        | (/\bDELETE\b/i.test(eventClause) ? 8 : 0)
        | (/\bUPDATE\b/i.test(eventClause) ? 16 : 0)
        | (/\bTRUNCATE\b/i.test(eventClause) ? 32 : 0);
      expected.set(name, { table, functionName, type, updateColumns });
    }
  }
  assert(expected.size === 15,
    "expected trigger inventory changed; review every migration binding");

  const query = [
    "SELECT t.tgname AS trigger_name, c.relname AS table_name,",
    "  p.proname AS function_name, p.pronargs AS nargs,",
    "  t.tgtype::integer AS type, t.tgenabled AS enabled,",
    "  l.lanname AS language, p.prosecdef AS security_definer,",
    "  p.prosrc AS function_body, p.proowner = ledger.relowner AS trusted_owner,",
    "  ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a",
    "    WHERE a.attrelid = t.tgrelid AND a.attnum = ANY(t.tgattr::smallint[])",
    "    ORDER BY a.attname) AS update_columns",
    "FROM pg_catalog.pg_trigger t",
    "JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid",
    "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace",
    "JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid",
    "JOIN pg_catalog.pg_language l ON l.oid = p.prolang",
    "CROSS JOIN pg_catalog.pg_class ledger",
    "JOIN pg_catalog.pg_namespace ledger_ns ON ledger_ns.oid = ledger.relnamespace",
    "WHERE n.nspname = 'public' AND NOT t.tgisinternal",
    "  AND ledger_ns.nspname = 'public' AND ledger.relname = 'schema_migrations'",
    "ORDER BY t.tgname"
  ].join("\n");
  const result = await pool.query(query);
  assert(result.rows.length === expected.size,
    "application trigger set differs from the audited migration inventory");
  for (const trigger of result.rows) {
    const audited = expected.get(trigger.trigger_name);
    assert(audited && trigger.table_name === audited.table &&
      trigger.function_name === audited.functionName &&
      trigger.nargs === 0 && trigger.type === audited.type &&
      trigger.enabled === "O" && trigger.language === "plpgsql" &&
      trigger.security_definer === false && trigger.trusted_owner &&
      JSON.stringify(trigger.update_columns) === JSON.stringify(audited.updateColumns),
      "application trigger binding, events or enabled state drifted: " +
      trigger.trigger_name);
    let auditedBody;
    for (let i = sources.length - 1; i >= 0; i--) {
      const namePattern = new RegExp(
        "CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+" +
        audited.functionName + "\\s*\\(", "i"
      );
      if (namePattern.test(sources[i].sql)) {
        auditedBody = extractAuditedWriterBody(sources[i].sql, audited.functionName + "()");
        break;
      }
    }
    assert(auditedBody !== undefined && trigger.function_body === auditedBody,
      "application trigger function body drifted from audited migration: " +
      trigger.trigger_name);
  }
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
    // The read-only SQL diagnostic independently verifies all runtime ACLs.
    const [runtimeIdentity, migrationIdentity] = await Promise.all([
      runtimePool.query(`SELECT current_user AS role, session_user AS authenticated_role, pg_catalog.current_database() AS db,
        pg_catalog.inet_server_addr()::text AS server_addr,
        pg_catalog.inet_server_port() AS server_port,
        pg_catalog.pg_postmaster_start_time() AS server_started`),
      migrationPool.query(`SELECT current_user AS role, session_user AS authenticated_role, pg_catalog.current_database() AS db,
        pg_catalog.has_schema_privilege(current_user,'public','CREATE') AS schema_create,
        pg_catalog.current_schema() AS active_schema,
        pg_catalog.inet_server_addr()::text AS server_addr,
        pg_catalog.inet_server_port() AS server_port,
        pg_catalog.pg_postmaster_start_time() AS server_started`)
    ]);
    const app = runtimeIdentity.rows[0];
    const admin = migrationIdentity.rows[0];
    assert(app.role === "jev_runtime", "application must connect using jev_runtime");
    assert(app.authenticated_role === "jev_runtime" &&
      app.authenticated_role === app.role,
      "application session must authenticate directly as jev_runtime; role switching is forbidden");
    assert(admin.authenticated_role === admin.role,
      "migration connection must not impersonate a different role");
    assert(admin.active_schema === "public",
      "migration session must target public as its active schema");
    assert(app.role !== admin.role && app.db === admin.db && admin.schema_create,
      "migration connection must be a separate privileged identity on the same database");
    assert(app.server_addr === admin.server_addr &&
      app.server_port === admin.server_port &&
      new Date(app.server_started).getTime() === new Date(admin.server_started).getTime(),
      "runtime and migrator connections must reach the same live PostgreSQL server");

    // Runtime's own membership check only sees roles it can inherit/SET.
    // Reverse memberships are equally dangerous: an attacker can inherit
    // the runtime's SECURITY DEFINER EXECUTE grants.
    const inboundMemberships = await runtimePool.query(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members members
        JOIN pg_catalog.pg_roles parent ON parent.oid = members.roleid
        WHERE parent.rolname = 'jev_runtime'
      ) AS any_inbound
    `);
    assert(inboundMemberships.rows.length === 1 &&
      inboundMemberships.rows[0].any_inbound === false,
      "jev_runtime cannot be granted to any other database role");

    const sql = await readFile(path.join(root, "packages", "db", "security", "verify-runtime-privileges.sql"), "utf8");
    const rows = (await runtimePool.query(sql)).rows;
    assert(rows.length === 4, "expected exactly four guarded privilege rows");
    assert(rows.map(x => x.table_name).sort().join(",") === guarded.join(","),
      "unexpected guarded privilege tables");
    assert(rows.every(x => x.runtime_role === "jev_runtime" && x.direct_dml_boundary === "PASS"),
      "guarded-table privilege diagnostic did not return four PASS results");

    const writers = await validateControlledWriters(runtimePool);
    await validateDefinerSurface(runtimePool);
    await validateTriggerInvariants(runtimePool);
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

