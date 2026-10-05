import { buildWorkerHealthServer } from "./app.js";

const host = process.env.WORKER_HOST ?? "0.0.0.0";
const port = Number(process.env.WORKER_HEALTH_PORT ?? 3002);

const app = buildWorkerHealthServer();

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
