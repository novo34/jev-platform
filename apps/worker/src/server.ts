import { randomUUID } from "node:crypto";
import { checkDatabase, createDatabasePool } from "@jev/db";
import { QueueService } from "@jev/queue";
import { buildWorkerHealthServer } from "./app.js";
import { WorkerRuntime } from "./runtime.js";

const host = process.env.WORKER_HOST ?? "0.0.0.0";
const port = Number(process.env.WORKER_HEALTH_PORT ?? 3002);
const workerId = process.env.WORKER_ID ?? `worker-${randomUUID()}`;

const pool = createDatabasePool();
const queue = new QueueService(pool);
const runtime = new WorkerRuntime(queue, { workerId });
const app = buildWorkerHealthServer();

app.addHook("onClose", async () => {
  await runtime.stop();
  await pool.end();
});

try {
  await checkDatabase(pool);
  await runtime.start();
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  await runtime.stop().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(1);
}
