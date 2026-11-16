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

const browserSessionCookie = "__Host-jev_session";

function browserSessionRequest(request: FastifyRequest): boolean {
  const site = request.headers["sec-fetch-site"];
  // A cross-origin form cannot set this header. Cross-origin fetch cannot
  // send it because the API does not enable CORS.
  return request.headers["x-jev-browser-session"] === "1" &&
    site === "same-origin";
}

function sessionCookie(value: string): string {
  const attributes = "Path=/; HttpOnly; Secure; SameSite=Lax";
  return `${browserSessionCookie}=${value}; ${attributes}${value ? "" : "; Max-Age=0"}`;
}

function requestSessionToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) return bearerToken(authorization);

  const prefix = `${browserSessionCookie}=`;
  const matches = request.headers.cookie?.split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(prefix)) ?? [];
  const token = matches.length === 1 ? matches[0].slice(prefix.length) : undefined;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD" &&
      !browserSessionRequest(request)) throw new AuthError("FORBIDDEN");
  return token;
}

export async function requireAuthenticatedUser(
  pool: Pool,
  request: FastifyRequest
) {
  return authenticateToken(pool, requestSessionToken(request));
}

const loginBuckets = new Map<string, { count: number; resetAt: number }>();
function checkLoginLimit(email: string, organizationId: string): boolean {
  const key = organizationId.replace(/-/g, "").toLowerCase() + ":" + email.trim().toLowerCase();
  const now = Date.now();
  if (loginBuckets.size > 10000) {
    for (const [k, v] of loginBuckets) if (v.resetAt < now) loginBuckets.delete(k);
    while (loginBuckets.size > 10000) {
      const oldest = loginBuckets.keys().next().value;
      if (oldest === undefined) break;
      loginBuckets.delete(oldest);
    }
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
            organizationId: { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" },
            email: { type: "string", minLength: 3, maxLength: 320 },
            password: { type: "string", minLength: 1, maxLength: 1024 }
          }
        }
      }
    },
    async (request, reply) => {
      if (request.headers["x-jev-browser-session"] !== undefined && !browserSessionRequest(request)) {
        return reply.code(403).send({ error: "FORBIDDEN" });
      }
      if (!checkLoginLimit(request.body.email, request.body.organizationId)) {
        return reply.code(429).send({ error: "RATE_LIMITED" });
      }
      try {
        const result = await login(pool, request.body);
        reply.header("Cache-Control", "no-store");
        if (browserSessionRequest(request)) {
          return reply.header("Set-Cookie", sessionCookie(result.token)).code(200).send({ user: result.user });
        }
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
    reply.header("Cache-Control", "no-store");
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
      if (request.headers.authorization === undefined) {
        reply.header("Set-Cookie", sessionCookie(""));
      }
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
