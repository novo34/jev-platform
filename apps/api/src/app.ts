import Fastify from "fastify";
import type { Pool } from "pg";
import { createHealthStatus } from "@jev/shared";
import { registerAuthRoutes } from "./auth.js";
import { registerControlRoutes } from "./control.js";
import type { ProviderRegistry } from "@jev/model-gateway";
import { registerProviderRoutes } from "./providers.js";

interface BuildApiOptions {
  pool?: Pool;
  providerEncryptionKey?: string;
  providerRegistry?: ProviderRegistry;
}

export function buildApi(options: BuildApiOptions = {}) {
  const app = Fastify({ logger: true });

  app.get("/health", async () => createHealthStatus("api"));

  if (options.pool) {
    registerAuthRoutes(app, options.pool);
    registerControlRoutes(app, options.pool);
    registerProviderRoutes(app, options.pool, {
      encryptionKey: options.providerEncryptionKey,
      registry: options.providerRegistry
    });
  }

  return app;
}
