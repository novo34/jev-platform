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
      /unapproved SECURITY DEFINER function exists outside the controlled writer allowlist/
    );
    // Even REVOKE alone cannot silently make an unapproved function pass
    // the reviewed allowlist: the function must be removed or reviewed.
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${rogueDefiner} FROM PUBLIC`);
    await assert.rejects(
      verify(),
      /unapproved SECURITY DEFINER function exists outside the controlled writer allowlist/
    );
  } finally {
    await admin.query(`DROP FUNCTION ${rogueDefiner}`);
  }
  ensure((await verify()).controlled_writers === 7,
    "unapproved definer cleanup did not restore the topology");

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
