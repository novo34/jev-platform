/**
 * CI-only production-profile smoke on disposable PostgreSQL 16.
 * Uses a disposable jev_test database; never point this at a live database.
 * Tests actual built API and Worker processes, not only SQL-role simulation.
 */
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { migrate, assertRestrictedRuntimeRole, createDatabasePool } from "../packages/db/dist/index.js";
import { verifyDatabaseTopology } from "./verify-db-topology.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const running = [];

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
function startProcess(relativePath, env) {
  const child = spawn(process.execPath, [path.join(root, relativePath)], {
    cwd: root, env: { ...process.env, ...env }, stdio: "ignore"
  });
  running.push(child);
  return child;
}
async function waitForHealth(child, port) {
  for (let attempt = 0; attempt < 80; attempt++) {
    ensure(child.exitCode === null, "restricted runtime process exited before health check");
    try {
      const result = await fetch("http://127.0.0.1:" + port + "/health", {
        signal: AbortSignal.timeout(750)
      });
      if (result.ok) return;
    } catch {}
    await sleep(150);
  }
  throw new Error("restricted runtime process did not become healthy");
}
async function expectStartRejected(child, port) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/health", {
        signal: AbortSignal.timeout(750)
      });
      if (response.ok) throw new Error("privileged runtime unexpectedly served HTTP");
    } catch (error) {
      if (error?.message === "privileged runtime unexpectedly served HTTP") throw error;
    }
    if (child.exitCode !== null) {
      ensure(child.exitCode !== 0, "privileged runtime must exit with failure");
      return;
    }
    await sleep(150);
  }
  throw new Error("privileged runtime did not reject startup");
}

const adminURL = new URL(process.env.DATABASE_URL ?? "postgresql://invalid@invalid/invalid");
ensure(process.env.CI === "true" && process.env.JEV_DB_SMOKE === "1"
  && ["localhost", "127.0.0.1"].includes(adminURL.hostname)
  && adminURL.pathname === "/jev_test",
  "refusing privileged CI role smoke outside a disposable local jev_test database");

const admin = new Pool({ connectionString: adminURL.toString() });
try {
  await migrate(admin);
  const provisioning = await readFile(
    path.join(root, "packages/db/security/provision-runtime-role.sql"), "utf8"
  );
  await admin.query(provisioning);
  const password = randomBytes(32).toString("hex");
  const literal = (await admin.query(
    "SELECT pg_catalog.quote_literal($1::text) AS escaped", [password]
  )).rows[0].escaped;
  await admin.query("ALTER ROLE jev_runtime PASSWORD " + literal);
  const runtimeURL = new URL(adminURL);
  runtimeURL.username = "jev_runtime";
  runtimeURL.password = password;

  const topology = await verifyDatabaseTopology({
    runtimeUrl: runtimeURL.toString(), migrationUrl: adminURL.toString()
  });
  ensure(topology.privilege_checks === "4/4 PASS", "privilege diagnostic failed");
  // PLT-010: the release gate accepts only the eight canonical GitHub CHECKs.
  // Test missing, weakened and NOT VALID constraints independently of the ledger.
  const githubChecks = (await admin.query(`
    SELECT rel.relname AS table_name, c.conname AS name,
           pg_catalog.pg_get_constraintdef(c.oid) AS definition
    FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class rel ON rel.oid=c.conrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid=rel.relnamespace
    WHERE ns.nspname='public' AND c.contype='c' AND starts_with(rel.relname, 'github_')
  `)).rows;
  ensure(githubChecks.length === 8, "PLT-010 CHECK regression inventory must contain eight constraints");
  for (const check of githubChecks) {
    ensure(/^[a-z_]+$/.test(check.table_name) && /^[a-z_]+$/.test(check.name), "invalid CHECK fixture identifier");
    const target = "public." + check.table_name;
    const drop = "ALTER TABLE " + target + " DROP CONSTRAINT " + check.name;
    const add = "ALTER TABLE " + target + " ADD CONSTRAINT " + check.name + " ";
    for (const variant of ["missing", "weakened", "unvalidated"]) {
      await admin.query(drop);
      try {
        if (variant === "weakened") await admin.query(add + "CHECK (true)");
        if (variant === "unvalidated") await admin.query(add + check.definition + " NOT VALID");
        await assert.rejects(verifyDatabaseTopology({ runtimeUrl: runtimeURL.toString(), migrationUrl: adminURL.toString() }),
          variant === "weakened" ? /GitHub CHECK constraint predicate drifted/ : /unapproved CHECK constraint inventory drifted/);
      } finally {
        await admin.query("ALTER TABLE " + target + " DROP CONSTRAINT IF EXISTS " + check.name);
        await admin.query(add + check.definition);
      }
    }
  }
  ensure((await verifyDatabaseTopology({ runtimeUrl: runtimeURL.toString(), migrationUrl: adminURL.toString() })).privilege_checks === "4/4 PASS",
    "GitHub CHECK restoration did not restore release gate");
  // A privileged URL can request a role switch at connection startup.
  // Neither the deployment verifier nor API/Worker startup may accept it.
  const spoofedURL = new URL(adminURL);
  spoofedURL.searchParams.set("options", "-c role=jev_runtime");
  await assert.rejects(
    verifyDatabaseTopology({
      runtimeUrl: spoofedURL.toString(), migrationUrl: adminURL.toString()
    }),
    /forbidden connection option/
  );

  // Bypass the URL parser and exercise a real PostgreSQL superuser session
  // switched into the restricted identity. current_user is misleading here:
  // the authenticated session_user still has migrator privileges.
  const ownerClient = await admin.connect();
  try {
    await ownerClient.query("BEGIN");
    await ownerClient.query("SET LOCAL ROLE jev_runtime");
    const identities = await ownerClient.query(
      "SELECT current_user AS effective, session_user AS authenticated"
    );
    ensure(identities.rows[0].effective === "jev_runtime" &&
      identities.rows[0].authenticated !== "jev_runtime",
      "role-switch spoof fixture did not impersonate the runtime role");
    await assert.rejects(
      assertRestrictedRuntimeRole({
        query: ownerClient.query.bind(ownerClient)
      }),
      /Unsafe JEV runtime database role/
    );
    await ownerClient.query("ROLLBACK");
  } finally {
    await ownerClient.query("ROLLBACK").catch(() => undefined);
    ownerClient.release();
  }
  // A URL with overridden host/port must not masquerade as the same database.
  const disguised = new URL(runtimeURL);
  disguised.searchParams.set("host", "127.0.0.2");
  await assert.rejects(
    verifyDatabaseTopology({
      runtimeUrl: disguised.toString(), migrationUrl: adminURL.toString()
    }),
    /forbidden connection endpoint override/
  );
  disguised.searchParams.delete("host");
  disguised.searchParams.set("port", "5433");
  await assert.rejects(
    verifyDatabaseTopology({
      runtimeUrl: disguised.toString(), migrationUrl: adminURL.toString()
    }),
    /forbidden connection endpoint override/
  );

  // Deployment verifier MUST fail closed when the migration credential can
  // CREATE objects but cannot ALTER/replace previously migrated objects.
  const fakeRole = "jev_gate_migrator_" + randomBytes(6).toString("hex");
  const fakeSecret = randomBytes(32).toString("hex");
  const fakeLiteral = (await admin.query(
    "SELECT pg_catalog.quote_literal($1::text) AS escaped", [fakeSecret]
  )).rows[0].escaped;
  await admin.query(`CREATE ROLE "${fakeRole}" LOGIN PASSWORD ${fakeLiteral} NOINHERIT`);
  try {
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${fakeRole}"`);
    const fakeURL = new URL(adminURL);
    fakeURL.username = fakeRole;
    fakeURL.password = fakeSecret;
    await assert.rejects(
      verifyDatabaseTopology({
        runtimeUrl: runtimeURL.toString(), migrationUrl: fakeURL.toString()
      }),
      /migration identity cannot manage all existing application schema objects/
    );
  } finally {
    await admin.query(`REVOKE USAGE, CREATE ON SCHEMA public FROM "${fakeRole}"`);
    await admin.query(`DROP ROLE "${fakeRole}"`);
  }

  // An unrelated login granted jev_runtime membership can inherit/use
  // its SECURITY DEFINER writers. Reject *inbound* membership too.
  const memberRole = "jev_gate_member_" + randomBytes(6).toString("hex");
  await admin.query(`CREATE ROLE "${memberRole}" NOLOGIN`);
  try {
    await admin.query(`GRANT jev_runtime TO "${memberRole}"`);
    await assert.rejects(
      verifyDatabaseTopology({
        runtimeUrl: runtimeURL.toString(), migrationUrl: adminURL.toString()
      }),
      /jev_runtime cannot be granted to any other database role/
    );
    await assert.rejects(
      admin.query(provisioning),
      /must have no inbound or outbound role memberships/
    );
  } finally {
    await admin.query(`REVOKE jev_runtime FROM "${memberRole}"`);
    await admin.query(`DROP ROLE "${memberRole}"`);
  }

  // Live security checks must notice PostgreSQL catalog drift even when the
  // schema_migrations checksum ledger and EXECUTE grants remain unchanged.
  const writer = "public.jev_lock_project_scope(uuid)";
  const verify = () => verifyDatabaseTopology({
    runtimeUrl: runtimeURL.toString(), migrationUrl: adminURL.toString()
  });

  // Codex P1: a legacy owner-privileged helper not in the seven audited
  // writers must make the live gate fail, even if all seven remain valid.
  const rogueDefiner = "public.jev_unreviewed_owner_writer()";
  await admin.query(`
    CREATE FUNCTION ${rogueDefiner} RETURNS integer
    LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
    AS 'SELECT 1'
  `);
  try {
    await assert.rejects(
      verify(),
      /unapproved SECURITY DEFINER routine exists outside the controlled writer allowlist/
    );
    // Even REVOKE alone cannot silently make an unapproved function pass
    // the reviewed allowlist: the function must be removed or reviewed.
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${rogueDefiner} FROM PUBLIC`);
    await assert.rejects(
      verify(),
      /unapproved SECURITY DEFINER routine exists outside the controlled writer allowlist/
    );
  } finally {
    await admin.query(`DROP FUNCTION ${rogueDefiner}`);
  }
  ensure((await verify()).controlled_writers === 7,
    "unapproved definer cleanup did not restore the topology");

  // P1: SQL procedures are prokind='p', not prokind='f'. PostgreSQL makes
  // their SECURITY DEFINER body callable with CALL and, by default, grants
  // EXECUTE to PUBLIC. They must be rejected by the same catalog allowlist.
  const rogueProcedure = "public.jev_unreviewed_owner_procedure()";
  await admin.query(`
    CREATE PROCEDURE ${rogueProcedure}
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
    AS 'BEGIN NULL; END;'
  `);
  try {
    const runtimeProc = new Pool({ connectionString: runtimeURL.toString() });
    try {
      await runtimeProc.query("CALL " + rogueProcedure);
    } finally {
      await runtimeProc.end();
    }
    await assert.rejects(
      verify(),
      /unapproved SECURITY DEFINER routine exists outside the controlled writer allowlist/
    );
  } finally {
    await admin.query("DROP PROCEDURE " + rogueProcedure);
  }
  ensure((await verify()).controlled_writers === 7,
    "unapproved procedure cleanup did not restore the topology");

  // P1: RETURN trigger cannot be invoked with SELECT/CALL, but PUBLIC TEMP
  // allows attaching a PUBLIC-executable SECURITY DEFINER trigger to a
  // runtime-owned temporary table. The inventory MUST reject this routine.
  const rogueTrigger = "public.jev_unreviewed_owner_trigger()";
  await admin.query(`
    CREATE FUNCTION ${rogueTrigger} RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
    AS 'BEGIN RETURN NEW; END;'
  `);
  try {
    const runtimeTrigger = new Pool({ connectionString: runtimeURL.toString(), max: 1 });
    const connection = await runtimeTrigger.connect();
    try {
      await connection.query("CREATE TEMP TABLE jev_runtime_temp_probe(id integer)");
      await connection.query(
        "CREATE TRIGGER jev_runtime_temp_proof BEFORE INSERT ON pg_temp.jev_runtime_temp_probe FOR EACH ROW EXECUTE FUNCTION " + rogueTrigger
      );
      await connection.query("INSERT INTO pg_temp.jev_runtime_temp_probe(id) VALUES (1)");
    } finally {
      connection.release();
      await runtimeTrigger.end();
    }
    await assert.rejects(
      verify(),
      /unapproved SECURITY DEFINER routine exists outside the controlled writer allowlist/
    );
  } finally {
    await admin.query("DROP FUNCTION " + rogueTrigger);
  }
  ensure((await verify()).controlled_writers === 7,
    "unapproved privileged trigger cleanup did not restore the topology");


  // P1: definer functions outside public are equally dangerous whenever
  // runtime can USE that schema (including PUBLIC USAGE).
  const foreignSchema = "jev_definer_extra_" + randomBytes(6).toString("hex");
  await admin.query(`CREATE SCHEMA "${foreignSchema}"`);
  try {
    await admin.query(`GRANT USAGE ON SCHEMA "${foreignSchema}" TO PUBLIC`);
    await admin.query(`
      CREATE FUNCTION "${foreignSchema}".unreviewed_writer() RETURNS integer
      LANGUAGE sql SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp
      AS 'SELECT 1'
    `);
    const runtimeClient = new Pool({ connectionString: runtimeURL.toString() });
    try {
      const called = await runtimeClient.query(
        `SELECT "${foreignSchema}".unreviewed_writer() AS value`
      );
      ensure(called.rows[0].value === 1,
        "runtime-accessible definer fixture was not callable");
    } finally {
      await runtimeClient.end();
    }
    await assert.rejects(
      verify(),
      /unapproved SECURITY DEFINER routine exists outside the controlled writer allowlist/
    );
  } finally {
    await admin.query(`REVOKE USAGE ON SCHEMA "${foreignSchema}" FROM PUBLIC`);
    await admin.query(`DROP SCHEMA "${foreignSchema}" CASCADE`);
  }
  ensure((await verify()).controlled_writers === 7,
    "foreign-schema definer cleanup did not restore the topology");



  // Codex P2: unqualified migration statements use current_schema().
  // A role-specific search_path that selects a decoy schema first must
  // fail the deployment gate, despite all canonical public grants passing.
  const shadowMigratorSchema = "jev_migrator_shadow_" + randomBytes(6).toString("hex");
  const migratorName = (await admin.query(
    "SELECT pg_catalog.quote_ident(current_user) AS role"
  )).rows[0].role;
  await admin.query(`CREATE SCHEMA "${shadowMigratorSchema}"`);
  try {
    await admin.query(`ALTER ROLE ${migratorName} SET search_path TO "${shadowMigratorSchema}", public`);
    await assert.rejects(
      verify(), /migration session must target public as its active schema/
    );
  } finally {
    await admin.query(`ALTER ROLE ${migratorName} RESET search_path`);
    await admin.query(`DROP SCHEMA "${shadowMigratorSchema}" CASCADE`);
  }
  ensure((await verify()).privilege_checks === "4/4 PASS",
    "migration search_path cleanup did not restore the production gate");


  // PostgreSQL foreign-key REFERENCES may expose elevated owner execution.
  // Grant first at table scope, then at column scope through PUBLIC, and
  // prove that both the runtime diagnostic and the actual provisioner
  // reject/remove the dangerous effective privilege.
  for (const grant of [
    "GRANT REFERENCES ON TABLE public.approvals TO PUBLIC",
    "GRANT REFERENCES (id) ON TABLE public.approvals TO PUBLIC"
  ]) {
    await admin.query(grant);
    try {
      const observer = new Pool({ connectionString: runtimeURL.toString() });
      try {
        const rights = await observer.query(
          "SELECT pg_catalog.has_table_privilege(current_user, 'public.approvals', 'REFERENCES') AS table_right, pg_catalog.has_column_privilege(current_user, 'public.approvals', 'id', 'REFERENCES') AS column_right"
        );
        ensure(rights.rows[0].table_right || rights.rows[0].column_right,
          "REFERENCES test fixture did not grant effective privilege");
        await assert.rejects(
          assertRestrictedRuntimeRole(observer),
          /Unsafe JEV runtime database role/
        );
      } finally { await observer.end(); }
      await assert.rejects(verify(), /guarded-table privilege diagnostic/);
      await admin.query(provisioning);
      ensure((await verify()).privilege_checks === "4/4 PASS",
        "provisioning failed to remove dangerous REFERENCES grants");
    } finally {
      await admin.query("REVOKE REFERENCES ON TABLE public.approvals FROM PUBLIC");
      await admin.query("REVOKE REFERENCES (id) ON TABLE public.approvals FROM PUBLIC");
    }
  }

  // P1: the audited seven writers can drift in-place without a migration
  // ledger update. Compare the actual pg_proc.prosrc body to the immutable
  // final CREATE OR REPLACE definition; grants/owner/search_path are unchanged.
  const originalDefinition = (await admin.query(
    "SELECT pg_catalog.pg_get_functiondef($1::pg_catalog.regprocedure) AS ddl",
    [writer]
  )).rows[0].ddl;
  await admin.query(`
    CREATE OR REPLACE FUNCTION public.jev_lock_project_scope(p_project_id uuid)
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
    AS 'BEGIN RETURN p_project_id; END;'
  `);
  try {
    await assert.rejects(
      verify(),
      /controlled writer implementation drifted from immutable audited migrations/
    );
  } finally {
    await admin.query(originalDefinition);
  }
  ensure((await verify()).controlled_writers === 7,
    "writer definition restoration failed");

  await admin.query(`ALTER FUNCTION ${writer} SECURITY INVOKER`);
  try {
    await assert.rejects(verify(), /controlled writer has unsafe owner/);
  } finally {
    await admin.query(`ALTER FUNCTION ${writer} SECURITY DEFINER`);
  }
  await admin.query(`ALTER FUNCTION ${writer} SET search_path = pg_catalog, pg_temp`);
  try {
    await assert.rejects(verify(), /controlled writer has unsafe owner/);
  } finally {
    await admin.query(`ALTER FUNCTION ${writer} SET search_path = pg_catalog, public, pg_temp`);
  }


  // P1: approval validity depends on database triggers. Verify that an
  // auditor detects both disabled bindings and a changed trigger body.
  const approvalTrigger = "trg_00_validate_approval_actor";
  await admin.query(
    "ALTER TABLE public.approvals DISABLE TRIGGER " + approvalTrigger
  );
  try {
    await assert.rejects(
      verify(), /application trigger binding, events or enabled state drifted/
    );
  } finally {
    await admin.query(
      "ALTER TABLE public.approvals ENABLE TRIGGER " + approvalTrigger
    );
  }

  const approvalFn = "public.validate_approval_actor()";
  const originalApprovalFn = (await admin.query(
    "SELECT pg_catalog.pg_get_functiondef($1::pg_catalog.regprocedure) AS ddl",
    [approvalFn]
  )).rows[0].ddl;
  await admin.query(`
    CREATE OR REPLACE FUNCTION public.validate_approval_actor()
    RETURNS trigger LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
    AS 'BEGIN RETURN NEW; END;'
  `);
  try {
    await assert.rejects(
      verify(), /application trigger function body drifted from audited migration/
    );
  } finally {
    await admin.query(originalApprovalFn);
  }
  ensure((await verify()).privilege_checks === "4/4 PASS",
    "approval trigger restoration did not restore the release gate");

  // A detached enforcement trigger must also fail even with its function intact.
  const originalTriggerDef = (await admin.query(
    "SELECT pg_catalog.pg_get_triggerdef(t.oid) AS ddl FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='approvals' AND t.tgname=$1",
    [approvalTrigger]
  )).rows[0].ddl;
  await admin.query("DROP TRIGGER " + approvalTrigger + " ON public.approvals");
  try {
    await assert.rejects(
      verify(), /application trigger set differs from the audited migration inventory/
    );
  } finally {
    await admin.query(originalTriggerDef);
  }
  ensure((await verify()).privilege_checks === "4/4 PASS",
    "approval trigger binding restoration did not restore the release gate");

  // P1 regression: a WHEN (false) predicate disables approval authorization
  // while preserving the trigger name, timing, function, event mask and state.
  const conditionalTrigger = originalTriggerDef.replace(
    /\s+EXECUTE FUNCTION\s+/i, " WHEN (false) EXECUTE FUNCTION "
  );
  ensure(conditionalTrigger !== originalTriggerDef,
    "could not construct conditional approval trigger regression fixture");
  await admin.query("DROP TRIGGER " + approvalTrigger + " ON public.approvals");
  try {
    await admin.query(conditionalTrigger);
    await assert.rejects(
      verify(), /application trigger binding, events or enabled state drifted/
    );
  } finally {
    await admin.query("DROP TRIGGER IF EXISTS " + approvalTrigger + " ON public.approvals");
    await admin.query(originalTriggerDef);
  }
  ensure((await verify()).privilege_checks === "4/4 PASS",
    "conditional trigger cleanup did not restore the release gate");

  // P1: a tampered function search_path permits untrusted temp-table shadowing.
  await admin.query(
    "ALTER FUNCTION public.validate_approval_actor() SET search_path = pg_catalog, pg_temp, public"
  );
  try {
    await assert.rejects(
      verify(), /application trigger binding, events or enabled state drifted/
    );
  } finally {
    await admin.query(
      "ALTER FUNCTION public.validate_approval_actor() SET search_path = pg_catalog, public, pg_temp"
    );
  }
  ensure((await verify()).privilege_checks === "4/4 PASS",
    "approval trigger search_path restoration did not restore the release gate");

  // P1: event triggers do not appear in pg_trigger. Reject enabled
  // database-wide DDL hooks even if the backing routine is SECURITY INVOKER.
  await admin.query(`
    CREATE FUNCTION public.jev_unreviewed_ddl_event()
    RETURNS event_trigger LANGUAGE plpgsql AS 'BEGIN END;'
  `);
  try {
    await admin.query(`
      CREATE EVENT TRIGGER jev_unreviewed_ddl_event_trigger
      ON ddl_command_start WHEN TAG IN ('CREATE TABLE')
      EXECUTE FUNCTION public.jev_unreviewed_ddl_event()
    `);
    try {
      await assert.rejects(
        verify(), /unapproved enabled database event trigger exists/
      );
    } finally {
      await admin.query("DROP EVENT TRIGGER IF EXISTS jev_unreviewed_ddl_event_trigger");
    }
  } finally {
    await admin.query("DROP FUNCTION public.jev_unreviewed_ddl_event()");
  }
  ensure((await verify()).privilege_checks === "4/4 PASS",
    "unapproved event trigger cleanup did not restore the release gate");

  // P1: a newly-created pg_catalog SECURITY DEFINER has an implicit PUBLIC
  // EXECUTE grant. It must not bypass the cross-schema inventory.
  await admin.query(`
    CREATE FUNCTION pg_catalog.jev_rogue_catalog_definer()
    RETURNS integer LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
    AS 'SELECT 1'
  `);
  try {
    const catalogRuntime = new Pool({ connectionString: runtimeURL.toString() });
    try {
      const invoked = await catalogRuntime.query(
        "SELECT pg_catalog.jev_rogue_catalog_definer() AS result"
      );
      ensure(invoked.rows[0].result === 1,
        "pg_catalog privileged routine was not callable by runtime");
    } finally {
      await catalogRuntime.end();
    }
    await assert.rejects(
      verify(), /unapproved SECURITY DEFINER routine exists outside the controlled writer allowlist/
    );
  } finally {
    await admin.query("DROP FUNCTION pg_catalog.jev_rogue_catalog_definer()");
  }
  ensure((await verify()).privilege_checks === "4/4 PASS",
    "pg_catalog privileged routine cleanup did not restore the release gate");

  // P1: PostgreSQL rewrite rules execute using relation-owner privileges,
  // including writes to protected tables from runtime-writable queue jobs.
  const maliciousRule = "jev_unapproved_jobs_insert_rule";
  await admin.query(`
    CREATE RULE ${maliciousRule} AS ON INSERT TO public.jobs
    DO ALSO UPDATE public.tasks SET status = status WHERE FALSE
  `);
  try {
    await assert.rejects(
      verify(), /unapproved rewrite rule exists on runtime-writable relation/
    );
  } finally {
    await admin.query("DROP RULE IF EXISTS " + maliciousRule + " ON public.jobs");
  }
  ensure((await verify()).privilege_checks === "4/4 PASS",
    "rewrite-rule cleanup did not restore the release gate");

  // Controlled writers update protected relations as table owner. A rewrite
  // rule on public.tasks must be rejected despite runtime lacking direct DML.
  const protectedRule = "jev_unapproved_tasks_update_rule";
  await admin.query(`
    CREATE RULE ${protectedRule} AS ON UPDATE TO public.tasks
    DO ALSO UPDATE public.approvals SET stale = stale WHERE FALSE
  `);
  try {
    await assert.rejects(verify(),
      /unapproved rewrite rule exists on runtime-writable relation/);
  } finally {
    await admin.query("DROP RULE IF EXISTS " + protectedRule + " ON public.tasks");
  }
  ensure((await verify()).privilege_checks === "4/4 PASS",
    "protected-table rewrite-rule cleanup did not restore release gate");

  // information_schema is accessible to runtime, like pg_catalog, and
  // must not be exempt from the SECURITY DEFINER inventory.
  await admin.query(`
    CREATE FUNCTION information_schema.jev_rogue_information_definer()
    RETURNS integer LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
    AS 'SELECT 1'
  `);
  try {
    await assert.rejects(verify(),
      /unapproved SECURITY DEFINER routine exists outside the controlled writer allowlist/);
  } finally {
    await admin.query("DROP FUNCTION information_schema.jev_rogue_information_definer()");
  }
  ensure((await verify()).privilege_checks === "4/4 PASS",
    "information_schema function cleanup did not restore release gate");

  const originalApprovalConstraint = (await admin.query(
    `SELECT pg_catalog.pg_get_constraintdef(c.oid) AS ddl
       FROM pg_catalog.pg_constraint c
       JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      WHERE t.oid = 'public.approvals'::regclass
        AND c.conname = 'approvals_approved_refs_nonblank'`
  )).rows[0].ddl;
  await admin.query("ALTER TABLE public.approvals DROP CONSTRAINT approvals_approved_refs_nonblank");
  try {
    await assert.rejects(verify(),
      /approval nonblank reference CHECK constraint drifted/);
    await admin.query(`
      ALTER TABLE public.approvals ADD CONSTRAINT approvals_approved_refs_nonblank
      CHECK (decision <> 'APPROVED' OR stale = TRUE OR revision IS NOT NULL)
    `);
    try {
      await assert.rejects(verify(),
        /approval nonblank reference CHECK constraint drifted/);
    } finally {
      await admin.query("ALTER TABLE public.approvals DROP CONSTRAINT approvals_approved_refs_nonblank");
    }
  } finally {
    await admin.query(
      "ALTER TABLE public.approvals ADD CONSTRAINT approvals_approved_refs_nonblank " +
      originalApprovalConstraint
    );
  }
  ensure((await verify()).privilege_checks === "4/4 PASS",
    "approval constraint restoration did not restore release gate");

  // Whitespace-only reference and READY URL values must be rejected by the
  // actual migrated database CHECK expressions, not just by application code.
  const whitespace = await admin.query(
    "SELECT E' \\t\\n' ~ '[^[:space:]]' AS has_usable_text"
  );
  ensure(whitespace.rows[0].has_usable_text === false,
    "PostgreSQL whitespace predicate accepted empty evidence");

  const readyUrlConstraint = (await admin.query(
    `SELECT pg_catalog.pg_get_constraintdef(c.oid) AS ddl
       FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = 'public.deployments'::regclass
         AND c.conname = 'deployments_ready_url_nonblank'`
  )).rows[0].ddl;
  await admin.query(
    "ALTER TABLE public.deployments DROP CONSTRAINT deployments_ready_url_nonblank"
  );
  try {
    await assert.rejects(verify(),
      /approval nonblank reference CHECK constraint drifted/);
    await admin.query(
      "ALTER TABLE public.deployments ADD CONSTRAINT deployments_ready_url_nonblank " +
      "CHECK (status <> 'READY' OR url IS NOT NULL)"
    );
    try {
      await assert.rejects(verify(),
        /approval nonblank reference CHECK constraint drifted/);
    } finally {
      await admin.query(
        "ALTER TABLE public.deployments DROP CONSTRAINT deployments_ready_url_nonblank"
      );
    }
  } finally {
    await admin.query(
      "ALTER TABLE public.deployments ADD CONSTRAINT deployments_ready_url_nonblank " +
      readyUrlConstraint
    );
  }
  ensure((await verify()).privilege_checks === "4/4 PASS",
    "READY URL constraint restoration did not restore release gate");

  // A constraint trigger may defer an audited AFTER ROW invariant until
  // commit, changing the security semantics without changing its function.
  const historyTrigger = "trg_record_order_state_history";
  const historyDefinition = (await admin.query(
    "SELECT pg_catalog.pg_get_triggerdef(t.oid) AS ddl FROM pg_catalog.pg_trigger t " +
    "WHERE t.tgrelid='public.orders'::regclass AND t.tgname=$1",
    [historyTrigger]
  )).rows[0].ddl;
  const deferredHistory = historyDefinition
    .replace("CREATE TRIGGER", "CREATE CONSTRAINT TRIGGER")
    .replace(/UPDATE OF status/i, "UPDATE")
    .replace(/ FOR EACH ROW /i, " DEFERRABLE INITIALLY DEFERRED FOR EACH ROW ");
  ensure(deferredHistory !== historyDefinition, "constraint trigger fixture unchanged");
  await admin.query("DROP TRIGGER " + historyTrigger + " ON public.orders");
  try {
    await admin.query(deferredHistory);
    const deferredFlags = (await admin.query(
      "SELECT tgconstraint <> 0 AS constrained, tgdeferrable AS deferrable, " +
      "tginitdeferred AS initially_deferred FROM pg_catalog.pg_trigger " +
      "WHERE tgrelid='public.orders'::regclass AND tgname=$1",
      [historyTrigger]
    )).rows[0];
    ensure(deferredFlags.constrained && deferredFlags.deferrable &&
      deferredFlags.initially_deferred,
      "deferred constraint trigger fixture was not installed");
    await assert.rejects(verify(),
      /application trigger binding, events or enabled state drifted/);
  } finally {
    await admin.query("DROP TRIGGER IF EXISTS " + historyTrigger + " ON public.orders");
    await admin.query(historyDefinition);
  }
  ensure((await verify()).privilege_checks === "4/4 PASS",
    "deferred trigger cleanup did not restore release gate");

  // Even NOT VALID checks run on new writes, including privileged writer
  // calls. A default SECURITY INVOKER function can acquire the writer's
  // owner identity, so new CHECKs cannot be silently added.
  await admin.query(`
    CREATE FUNCTION public.jev_unapproved_check(value text)
    RETURNS boolean LANGUAGE plpgsql AS $jev_check$
    BEGIN
      UPDATE public.approvals SET stale = stale WHERE FALSE;
      RETURN true;
    END;
    $jev_check$
  `);
  try {
    await admin.query(`
      ALTER TABLE public.tasks ADD CONSTRAINT jev_unapproved_check_rule
      CHECK (public.jev_unapproved_check(status)) NOT VALID
    `);
    try {
      await assert.rejects(
        verify(), /unapproved CHECK constraint inventory drifted/
      );
    } finally {
      await admin.query(
        "ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS jev_unapproved_check_rule"
      );
    }
  } finally {
    await admin.query("DROP FUNCTION public.jev_unapproved_check(text)");
  }
  ensure((await verify()).privilege_checks === "4/4 PASS",
    "unaudited executable CHECK cleanup did not restore release gate");

  // Runtime must not be able to delegate its EXECUTE rights to attackers.
  await admin.query(`GRANT EXECUTE ON FUNCTION ${writer} TO jev_runtime WITH GRANT OPTION`);
  try {
    await assert.rejects(verify(), /controlled writer has unsafe owner/);
    // The administrative provisioning script must strip the delegation
    // right while preserving legitimate EXECUTE.
    await admin.query(provisioning);
    ensure((await verify()).privilege_checks === "4/4 PASS",
      "provisioning did not remove runtime EXECUTE grant option");
  } finally {
    await admin.query(`REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION ${writer} FROM jev_runtime CASCADE`);
  }

  // SECURITY DEFINER functions must never be callable via PUBLIC.
  // The old verifier checked only that runtime could EXECUTE and missed
  // cross-role grants; privilege drift must fail even with intact checksums.
  await admin.query(`GRANT EXECUTE ON FUNCTION ${writer} TO PUBLIC`);
  try {
    await assert.rejects(verify(), /controlled writer has unsafe owner/);
  } finally {
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${writer} FROM PUBLIC`);
  }

  // A malicious function owner must not pass merely because a definer flag
  // and EXECUTE are present.
  const fakeOwner = "jev_gate_owner_" + randomBytes(6).toString("hex");
  const ownerQuoted = (await admin.query(
    "SELECT pg_catalog.quote_ident(current_user) AS role"
  )).rows[0].role;
  await admin.query(`CREATE ROLE "${fakeOwner}" NOLOGIN`);
  try {
    await admin.query(`GRANT CREATE ON SCHEMA public TO "${fakeOwner}"`);
    await admin.query(`GRANT EXECUTE ON FUNCTION ${writer} TO "${fakeOwner}"`);
    try {
      await assert.rejects(verify(), /controlled writer has unsafe owner/);
    } finally {
      await admin.query(`REVOKE EXECUTE ON FUNCTION ${writer} FROM "${fakeOwner}"`);
    }
    await admin.query(`ALTER FUNCTION ${writer} OWNER TO "${fakeOwner}"`);
    try {
      await assert.rejects(verify(), /controlled writer has unsafe owner/);
    } finally {
      await admin.query(`ALTER FUNCTION ${writer} OWNER TO ${ownerQuoted}`);
    }
  } finally {
    await admin.query(`REVOKE CREATE ON SCHEMA public FROM "${fakeOwner}"`);
    await admin.query(`DROP ROLE "${fakeOwner}"`);
  }
  ensure((await verify()).privilege_checks === "4/4 PASS",
    "restore of controlled writer attributes failed");

  const runtimePool = new Pool({ connectionString: runtimeURL.toString() });
  try {
    await assertRestrictedRuntimeRole(runtimePool);
    let privilegedRejected = false;
    try { await assertRestrictedRuntimeRole(admin); } catch { privilegedRejected = true; }
    ensure(privilegedRejected, "startup guard accepted migrator credentials");
  } finally {
    await runtimePool.end();
  }

  const restrictedEnv = {
    NODE_ENV: "production", DATABASE_URL: runtimeURL.toString(),
    MIGRATION_DATABASE_URL: "", JEV_ENFORCE_RUNTIME_ROLE: "1",
    API_HOST: "127.0.0.1", WORKER_HOST: "127.0.0.1",
    API_PORT: "34341", WORKER_HEALTH_PORT: "34342",
    WORKER_ID: "ci-restricted-worker"
  };
  // Real process regression: PostgreSQL options can set the session
  // authorization independently of current_user. Both API and Worker must
  // reject role-changing options in the shared pool constructor BEFORE
  // accepting connections, even when they authenticate as a superuser.
  const spoofedAdminURL = new URL(adminURL);
  spoofedAdminURL.searchParams.set("options", "-c session_authorization=jev_runtime");
  assert.throws(
    () => createDatabasePool({ connectionString: spoofedAdminURL.toString() }),
    /Forbidden PostgreSQL connection option: options/
  );
  assert.throws(
    () => createDatabasePool({ connectionString: runtimeURL.toString(), options: "-c role=jev_runtime" }),
    /PostgreSQL startup options are not permitted/
  );
  const maliciousAPI = startProcess("apps/api/dist/server.js", {
    ...restrictedEnv, API_PORT: "34344", DATABASE_URL: spoofedAdminURL.toString()
  });
  const maliciousWorker = startProcess("apps/worker/dist/server.js", {
    ...restrictedEnv, WORKER_HEALTH_PORT: "34345", DATABASE_URL: spoofedAdminURL.toString()
  });
  await Promise.all([
    expectStartRejected(maliciousAPI, 34344),
    expectStartRejected(maliciousWorker, 34345)
  ]);

  const api = startProcess("apps/api/dist/server.js", restrictedEnv);
  const worker = startProcess("apps/worker/dist/server.js", restrictedEnv);
  await Promise.all([waitForHealth(api, 34341), waitForHealth(worker, 34342)]);
  // Fail-closed gate: a production API with migrator credentials must exit.
  const unsafe = startProcess("apps/api/dist/server.js", {
    ...restrictedEnv, API_PORT: "34343", DATABASE_URL: adminURL.toString()
  });
  await expectStartRejected(unsafe, 34343);
  console.log("JEV restricted production-profile API/Worker smoke PASS:", JSON.stringify(topology));
} finally {
  for (const child of running) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await admin.end();
}

