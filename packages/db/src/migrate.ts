import { createDatabasePool } from "./index.js";
import { migrate } from "./migrations.js";

const pool = createDatabasePool();

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
