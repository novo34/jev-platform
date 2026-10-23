import Fastify from "fastify";
import type { Pool } from "pg";
import { createHealthStatus } from "@jev/shared";
import { registerAuthRoutes } from "./auth.js";
import { registerControlRoutes } from "./control.js";
import type { ProviderRegistry } from "@jev/model-gateway";
import { registerProviderRoutes } from "./providers.js";
import { ControlService, type GitHubInstallationFlow, type GitHubOperations } from "@jev/control";

interface BuildApiOptions {
  pool?: Pool;
  providerEncryptionKey?: string;
  providerRegistry?: ProviderRegistry;
  githubInstallation?: GitHubInstallationFlow;
  githubOperations?: GitHubOperations;
}

export function buildApi(options: BuildApiOptions = {}) {
  const app = Fastify({ logger: {
    redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
    serializers: { req: (request) => ({ method: request.method, url: request.url?.split("?")[0] }) }
  } });

  app.get("/health", async () => createHealthStatus("api"));

  if (options.pool) {
    app.get("/ready", async (_request, reply) => {
      try {
        await options.pool!.query("SELECT 1");
        return reply.send({ status: "ready" });
      } catch {
        return reply.code(503).send({ status: "unavailable" });
      }
    });
  }

  if (options.pool) {
    registerAuthRoutes(app, options.pool);
    registerControlRoutes(app, options.pool, new ControlService(options.pool, options.githubInstallation, options.githubOperations));
    registerProviderRoutes(app, options.pool, {
      encryptionKey: options.providerEncryptionKey,
      registry: options.providerRegistry
    });
  }

  return app;
}

