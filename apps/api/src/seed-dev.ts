import { createDatabasePool, migrate } from "@jev/db";
import { hashPassword } from "@jev/auth";

if (process.env.NODE_ENV === "production") {
  throw new Error("development seed is disabled in production");
}

const organizationId =
  process.env.JEV_DEV_ORGANIZATION_ID ?? "00000000-0000-4000-8000-000000000001";
const userId =
  process.env.JEV_DEV_ADMIN_USER_ID ?? "00000000-0000-4000-8000-000000000002";
const email = process.env.JEV_DEV_ADMIN_EMAIL ?? "admin@jev.local";
const password = process.env.JEV_DEV_ADMIN_PASSWORD ?? "JevLocalAdmin!2026";
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
  console.log("Password: use JEV_DEV_ADMIN_PASSWORD or the documented local default.");
} finally {
  await pool.end();
}
