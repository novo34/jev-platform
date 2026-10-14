import { checkDatabase, createDatabasePool } from "@jev/db";
import { buildApi } from "./app.js";

const host = process.env.API_HOST ?? "0.0.0.0";
const port = Number(process.env.API_PORT ?? 3001);
const encryptionKey = process.env.JEV_SECRET_ENCRYPTION_KEY;
if (process.env.JEV_REQUIRE_SECRET_KEY === "1" && (!encryptionKey || Buffer.from(encryptionKey, "base64").length !== 32)) {
  throw new Error("JEV_SECRET_ENCRYPTION_KEY must encode 32 bytes");
}
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
