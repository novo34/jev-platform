import { checkDatabase, createDatabasePool } from "@jev/db";
import { buildApi } from "./app.js";

const host = process.env.API_HOST ?? "0.0.0.0";
const port = Number(process.env.API_PORT ?? 3001);
const pool = createDatabasePool();
const app = buildApi({ pool });

app.addHook("onClose", async () => {
  await pool.end();
});

try {
  await checkDatabase(pool);
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exit(1);
}
