import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { migrate } from "../../packages/db/dist/index.js";
const owner = process.env.JEV_STAGING_DB_OWNER_PASSWORD;
const runtime = process.env.JEV_STAGING_RUNTIME_DB_PASSWORD;
if (!owner || !runtime) throw new Error("Staging database secrets are required");
const ownerUrl = new URL("postgresql://jev_owner@postgres:5432/jev_staging");
ownerUrl.password = owner;
const pool = new Pool({ connectionString: ownerUrl.toString() });
try {
  await migrate(pool);
  const sql = await readFile(new URL("../../packages/db/security/provision-runtime-role.sql", import.meta.url), "utf8");
  await pool.query(sql);
  const quoted = (await pool.query("SELECT pg_catalog.quote_literal($1::text) AS literal", [runtime])).rows[0].literal;
  await pool.query("ALTER ROLE jev_runtime PASSWORD " + quoted);
  console.log("Staging schema migrated and runtime role provisioned");
} finally {
  await pool.end();
}
