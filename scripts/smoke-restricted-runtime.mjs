/**
 * CI-only production-profile smoke on disposable PostgreSQL 16.
 * Uses a disposable jev_test database; never point this at a live database.
 * Tests actual built API and Worker processes, not only SQL-role simulation.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { migrate, assertRestrictedRuntimeRole } from "../packages/db/dist/index.js";
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
