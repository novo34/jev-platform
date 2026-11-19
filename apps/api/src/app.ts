import Fastify from "fastify";
import type { Pool } from "pg";
import { createHealthStatus } from "@jev/shared";
import { registerAuthRoutes } from "./auth.js";
import { registerPasswordRecovery, type PasswordRecoveryOptions } from "./password-recovery.js";
import { registerControlRoutes } from "./control.js";
import type { ProviderRegistry } from "@jev/model-gateway";
import { registerProviderRoutes } from "./providers.js";
import { registerCacheMetricsRoutes } from "./cache-metrics.js";
import { registerWorkOrderRoutes, type WorkOrderRoutesOptions } from "./work-orders.js";
import { ControlService, type GitHubInstallationFlow, type GitHubOperations } from "@jev/control";

interface BuildApiOptions {
  pool?: Pool;
  providerEncryptionKey?: string;
  providerRegistry?: ProviderRegistry;
  githubInstallation?: GitHubInstallationFlow;
  githubOperations?: GitHubOperations;
  passwordRecovery?: PasswordRecoveryOptions;
  /** PLT-040 PR 6: injectable intent gateway/targets (tests); default builds the real gateway lazily from env. */
  workOrders?: WorkOrderRoutesOptions;
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
    registerPasswordRecovery(app, options.pool, options.passwordRecovery);
    registerControlRoutes(app, options.pool, new ControlService(options.pool, options.githubInstallation, options.githubOperations));
    registerProviderRoutes(app, options.pool, {
      encryptionKey: options.providerEncryptionKey,
      registry: options.providerRegistry
    });
    registerCacheMetricsRoutes(app, options.pool);
    registerWorkOrderRoutes(app, options.pool, { encryptionKey: options.providerEncryptionKey, ...options.workOrders });
  }

  return app;
}

