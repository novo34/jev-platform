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
      return 403;
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

export function registerAuthRoutes(app: FastifyInstance, pool: Pool): void {
  app.post<{ Body: LoginBody }>("/auth/login", async (request, reply) => {
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
  });

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
