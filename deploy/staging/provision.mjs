import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { migrate } from "../../packages/db/dist/index.js";
import { hashPassword } from "../../packages/auth/dist/index.js";
const owner = process.env.JEV_STAGING_DB_OWNER_PASSWORD;
const runtime = process.env.JEV_STAGING_RUNTIME_DB_PASSWORD;
const adminPassword = process.env.JEV_STAGING_ADMIN_PASSWORD;
if (!owner || !runtime || !adminPassword || adminPassword.length < 16) throw new Error("Staging database secrets and a strong admin password are required");
const ownerUrl = new URL("postgresql://jev_owner@postgres:5432/jev_staging");
ownerUrl.password = owner;
const pool = new Pool({ connectionString: ownerUrl.toString() });
try {
  await migrate(pool);
  const sql = await readFile(new URL("./provision-runtime-grants.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.query(
    "INSERT INTO organizations (id, name, status) VALUES ($1, $2, 'ACTIVE') ON CONFLICT (id) DO NOTHING",
    ["00000000-0000-4000-8000-000000000001", "JEV Staging"]
  );
  await pool.query(
    "INSERT INTO users (id, organization_id, email, display_name, role, status, password_hash) VALUES ($1,$2,$3,$4,'ADMIN','ACTIVE',$5) ON CONFLICT (id) DO NOTHING",
    ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001", "admin@jev.local", "JEV Staging Admin", hashPassword(adminPassword)]
  );
  console.log("Staging schema, runtime role, and initial admin provisioned");
} finally {
  await pool.end();
}
