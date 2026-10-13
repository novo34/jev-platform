import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  AuthError,
  authenticateToken,
  bearerToken,
  login,
  logout
} from "@jev/auth";

interface LoginBody {
  organizationId: string;
  email: string;
  password: string;
}

function authErrorStatus(error: AuthError): number {
  switch (error.code) {
    case "INVALID_CREDENTIALS":
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
    case "USER_INACTIVE":
      return 403;
  }
}

export async function requireAuthenticatedUser(
  pool: Pool,
  request: FastifyRequest
) {
  return authenticateToken(pool, bearerToken(request.headers.authorization));
}

const loginBuckets = new Map<string, { count: number; resetAt: number }>();
function checkLoginLimit(email: string, organizationId: string): boolean {
  const key = organizationId + ":" + email.trim().toLowerCase();
  const now = Date.now();
  if (loginBuckets.size > 10000) {
    for (const [k, v] of loginBuckets) if (v.resetAt < now) loginBuckets.delete(k);
    if (loginBuckets.size > 10000) return false;
  }
  const old = loginBuckets.get(key);
  const bucket = old && old.resetAt > now ? old : { count: 0, resetAt: now + 60000 };
  bucket.count++;
  loginBuckets.set(key, bucket);
  return bucket.count <= 5;
}
export function registerAuthRoutes(app: FastifyInstance, pool: Pool): void {
  app.post<{ Body: LoginBody }>(
    "/auth/login",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["organizationId", "email", "password"],
          properties: {
            organizationId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
            email: { type: "string", minLength: 3, maxLength: 320 },
            password: { type: "string", minLength: 1, maxLength: 1024 }
          }
        }
      }
    },
    async (request, reply) => {
      if (!checkLoginLimit(request.body.email, request.body.organizationId)) {
        return reply.code(429).send({ error: "RATE_LIMITED" });
      }
      try {
        const result = await login(pool, request.body);
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof AuthError) {
          return reply.code(authErrorStatus(error)).send({
            error: error.code
          });
        }
        throw error;
      }
    }
  );

  app.get("/auth/me", async (request, reply) => {
    try {
      const user = await requireAuthenticatedUser(pool, request);
      return reply.code(200).send({ user });
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(authErrorStatus(error)).send({
          error: error.code
        });
      }
      throw error;
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    try {
      const user = await requireAuthenticatedUser(pool, request);
      await logout(pool, user.sessionId);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(authErrorStatus(error)).send({
          error: error.code
        });
      }
      throw error;
    }
  });
}
