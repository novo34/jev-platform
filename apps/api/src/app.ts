import Fastify from "fastify";
import type { Pool } from "pg";
import { createHealthStatus } from "@jev/shared";
import { registerAuthRoutes } from "./auth.js";

interface BuildApiOptions {
  pool?: Pool;
}

export function buildApi(options: BuildApiOptions = {}) {
  const app = Fastify({ logger: true });

  app.get("/health", async () => createHealthStatus("api"));

  if (options.pool) {
    registerAuthRoutes(app, options.pool);
  }

  return app;
}
