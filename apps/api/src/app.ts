import Fastify from "fastify";
import { createHealthStatus } from "@jev/shared";

export function buildApi() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => createHealthStatus("api"));

  return app;
}
