import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  MODEL_PROVIDERS,
  ModelGatewayError,
  ProviderCredentialStore,
  createDefaultProviderRegistry,
  type ModelProvider,
  type ProviderRegistry
} from "@jev/model-gateway";
import { AuthError } from "@jev/auth";
import { requireAuthenticatedUser } from "./auth.js";

interface ProviderParams {
  provider: ModelProvider;
}

interface CredentialBody {
  apiKey: string;
}

function ensureAdmin(role: string): void {
  if (role !== "ADMIN") {
    throw Object.assign(new Error("FORBIDDEN"), { statusCode: 403 });
  }
}

function mapError(error: unknown): { status: number; body: object } {
  if (error instanceof AuthError) {
    const status =
      error.code === "UNAUTHENTICATED" || error.code === "INVALID_CREDENTIALS"
        ? 401
        : 403;
    return { status, body: { error: error.code } };
  }

  if (
    error instanceof Error &&
    "statusCode" in error &&
    (error as { statusCode?: number }).statusCode === 403
  ) {
    return { status: 403, body: { error: "FORBIDDEN" } };
  }

  if (error instanceof ModelGatewayError) {
    const status =
      error.code === "INVALID_REQUEST"
        ? 400
        : error.code === "PROVIDER_CREDENTIAL_MISSING"
          ? 404
          : error.code === "SECRET_STORE_UNAVAILABLE"
            ? 503
            : 502;
    return { status, body: { error: error.code, message: error.message } };
  }

  return { status: 500, body: { error: "INTERNAL_ERROR" } };
}

export function registerProviderRoutes(
  app: FastifyInstance,
  pool: Pool,
  options: {
    encryptionKey?: string;
    registry?: ProviderRegistry;
  } = {}
): void {
  const store = new ProviderCredentialStore(
    pool,
    options.encryptionKey ?? process.env.JEV_SECRET_ENCRYPTION_KEY
  );
  const registry = options.registry ?? createDefaultProviderRegistry();

  app.get("/providers", async (request, reply) => {
    try {
      const actor = await requireAuthenticatedUser(pool, request);
      ensureAdmin(actor.role);
      const configured = await store.list(actor.organizationId);
      const byProvider = new Map(configured.map((item) => [item.provider, item]));

      return reply.code(200).send({
        providers: MODEL_PROVIDERS.map((provider) => {
          const metadata = byProvider.get(provider);
          return metadata ?? { provider, configured: false };
        })
      });
    } catch (error) {
      const mapped = mapError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.put<{ Params: ProviderParams; Body: CredentialBody }>(
    "/providers/:provider/credential",
    {
      schema: {
        params: {
          type: "object",
          required: ["provider"],
          properties: {
            provider: { type: "string", enum: [...MODEL_PROVIDERS] }
          }
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["apiKey"],
          properties: {
            apiKey: { type: "string", minLength: 8, maxLength: 4096 }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const actor = await requireAuthenticatedUser(pool, request);
        ensureAdmin(actor.role);
        const metadata = await store.configure(
          actor.organizationId,
          request.params.provider,
          request.body.apiKey,
          actor.id
        );
        return reply.code(200).send(metadata);
      } catch (error) {
        const mapped = mapError(error);
        return reply.code(mapped.status).send(mapped.body);
      }
    }
  );

  app.delete<{ Params: ProviderParams }>(
    "/providers/:provider/credential",
    {
      schema: {
        params: {
          type: "object",
          required: ["provider"],
          properties: {
            provider: { type: "string", enum: [...MODEL_PROVIDERS] }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const actor = await requireAuthenticatedUser(pool, request);
        ensureAdmin(actor.role);
        await store.remove(actor.organizationId, request.params.provider, actor.id);
        return reply.code(204).send();
      } catch (error) {
        const mapped = mapError(error);
        return reply.code(mapped.status).send(mapped.body);
      }
    }
  );

  app.post<{ Params: ProviderParams }>(
    "/providers/:provider/test",
    {
      schema: {
        params: {
          type: "object",
          required: ["provider"],
          properties: {
            provider: { type: "string", enum: [...MODEL_PROVIDERS] }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const actor = await requireAuthenticatedUser(pool, request);
        ensureAdmin(actor.role);
        const apiKey = await store.getSecret(
          actor.organizationId,
          request.params.provider
        );
        const health = await registry.get(request.params.provider).health(apiKey);
        return reply.code(health.ok ? 200 : 502).send({
          provider: request.params.provider,
          ...health
        });
      } catch (error) {
        const mapped = mapError(error);
        return reply.code(mapped.status).send(mapped.body);
      }
    }
  );
}
