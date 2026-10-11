import { createDatabasePool, migrate } from "@jev/db";
import { hashPassword } from "@jev/auth";

// Seeding can overwrite an active ADMIN. Require explicit development
// intent AND a local database URL before opening any connection or migrating.
if (process.env.NODE_ENV !== "development" ||
    process.env.JEV_ALLOW_DEV_SEED !== "1") {
  throw new Error("development seed requires NODE_ENV=development and JEV_ALLOW_DEV_SEED=1");
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("development seed requires an explicit local DATABASE_URL");
}
let databaseHost: string;
try {
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("unsupported protocol");
  }
  // node-postgres accepts query parameters that override hostname, port,
  // database and credentials from the URL authority. No overrides are safe
  // when this command can migrate or replace an ADMIN account.
  if (parsed.search || parsed.hash) {
    throw new Error("connection overrides are not allowed");
  }
  databaseHost = parsed.hostname;
} catch {
  throw new Error("development seed requires a valid PostgreSQL DATABASE_URL");
}
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(databaseHost)) {
  throw new Error("development seed refuses non-local database endpoints");
}

const organizationId =
  process.env.JEV_DEV_ORGANIZATION_ID ?? "00000000-0000-4000-8000-000000000001";
const userId =
  process.env.JEV_DEV_ADMIN_USER_ID ?? "00000000-0000-4000-8000-000000000002";
const email = process.env.JEV_DEV_ADMIN_EMAIL ?? "admin@jev.local";
const password = process.env.JEV_DEV_ADMIN_PASSWORD;
if (!password) {
  throw new Error(
    "JEV_DEV_ADMIN_PASSWORD is required; choose a local development password"
  );
}
const displayName = process.env.JEV_DEV_ADMIN_NAME ?? "JEV Local Admin";

const pool = createDatabasePool();

try {
  await migrate(pool);

  await pool.query(
    `INSERT INTO organizations (id, name, status)
     VALUES ($1, 'JEV Local Development', 'ACTIVE')
     ON CONFLICT (id)
     DO UPDATE SET name = EXCLUDED.name, status = 'ACTIVE', updated_at = NOW()`,
    [organizationId]
  );

  await pool.query(
    `INSERT INTO users (
       id, organization_id, email, display_name, role, status, password_hash
     ) VALUES ($1, $2, $3, $4, 'ADMIN', 'ACTIVE', $5)
     ON CONFLICT (id)
     DO UPDATE SET
       organization_id = EXCLUDED.organization_id,
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       role = 'ADMIN',
       status = 'ACTIVE',
       password_hash = EXCLUDED.password_hash,
       updated_at = NOW()`,
    [
      userId,
      organizationId,
      email,
      displayName,
      hashPassword(password)
    ]
  );

  console.log("JEV local development admin is ready.");
  console.log(`Organization ID: ${organizationId}`);
  console.log(`Email: ${email}`);
  console.log("Password: the local JEV_DEV_ADMIN_PASSWORD value you supplied.");
} finally {
  await pool.end();
}
