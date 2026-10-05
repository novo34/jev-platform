import Fastify from "fastify";
import { createHealthStatus } from "@jev/shared";

export function buildWorkerHealthServer() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => createHealthStatus("worker"));

  return app;
}
