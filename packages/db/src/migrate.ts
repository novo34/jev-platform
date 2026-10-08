import { createDatabasePool } from "./index.js";
import { migrate } from "./migrations.js";

// Schema changes must use an explicit migration credential when provided.
// Runtime DATABASE_URL must never be silently reused in managed deployments.
const migrationUrl = process.env.MIGRATION_DATABASE_URL;
if (process.env.JEV_ENFORCE_RUNTIME_ROLE === "1" && !migrationUrl) {
  throw new Error(
    "MIGRATION_DATABASE_URL is required when runtime role enforcement is enabled"
  );
}
const pool = createDatabasePool(
  migrationUrl ? { connectionString: migrationUrl } : undefined
);

try {
  const applied = await migrate(pool);

  if (applied.length === 0) {
    console.log("Database schema is already up to date.");
  } else {
    console.log(`Applied migrations: ${applied.join(", ")}`);
  }
} finally {
  await pool.end();
}
