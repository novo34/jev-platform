import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { CACHE_METRICS_MAX_LIMIT, CacheMetricsReader, ModelGatewayError } from "@jev/model-gateway";
import { AuthError } from "@jev/auth";
import { requireAuthenticatedUser } from "./auth.js";

interface Params {
  level: "project" | "task" | "call";
}

interface Query {
  projectId?: string;
  taskId?: string;
  limit?: number;
}

// Read-only. Same RBAC as the provider routes (ADMIN only: it exposes spend).
// The organization always comes from the session, never from the request.
export function registerCacheMetricsRoutes(app: FastifyInstance, pool: Pool): void {
  const reader = new CacheMetricsReader(pool);

  app.get<{ Params: Params; Querystring: Query }>(
    "/model-gateway/cache-metrics/:level",
    {
      schema: {
        params: {
          type: "object",
          required: ["level"],
          properties: { level: { type: "string", enum: ["project", "task", "call"] } }
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectId: { type: "string", format: "uuid" },
            taskId: { type: "string", format: "uuid" },
            limit: { type: "integer", minimum: 1, maximum: CACHE_METRICS_MAX_LIMIT }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const actor = await requireAuthenticatedUser(pool, request);
        if (actor.role !== "ADMIN") return reply.code(403).send({ error: "FORBIDDEN" });
        const filter = request.query;
        const rows =
          request.params.level === "project"
            ? await reader.byProject(actor.organizationId, filter)
            : request.params.level === "task"
              ? await reader.byTask(actor.organizationId, filter)
              : await reader.byCall(actor.organizationId, filter);
        return reply.code(200).send({ level: request.params.level, metrics: rows });
      } catch (error) {
        if (error instanceof AuthError) {
          const status =
            error.code === "UNAUTHENTICATED" || error.code === "INVALID_CREDENTIALS" ? 401 : 403;
          return reply.code(status).send({ error: error.code });
        }
        if (error instanceof ModelGatewayError && error.code === "INVALID_REQUEST") {
          return reply.code(400).send({ error: error.code, message: error.message });
        }
        return reply.code(500).send({ error: "INTERNAL_ERROR" });
      }
    }
  );
}
