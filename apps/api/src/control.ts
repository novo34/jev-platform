import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  CONTROL_ACTIONS,
  ControlError,
  ControlService,
  type ControlAction,
  type ControlCommand,
  type ControlFailure
} from "@jev/control";
import { GitHubError } from "@jev/control";
import { AuthError } from "@jev/auth";
import { requireAuthenticatedUser } from "./auth.js";

interface ControlBody {
  commandId?: string;
  action: ControlAction;
  projectId: string;
  targetId?: string;
  payload?: Record<string, unknown>;
}

function errorStatus(code: ControlFailure["error"]["code"]): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "RATE_LIMITED":
      return 429;
    case "UPSTREAM_UNAVAILABLE":
      return 503;
    case "INVALID_COMMAND":
      return 400;
    case "INTERNAL_ERROR":
      return 500;
  }
}

function asFailure(error: unknown, commandId?: string): ControlFailure {
  if (error instanceof GitHubError) {
    return {
      ok: false, commandId,
      error: { code: error.code === "GITHUB_FORBIDDEN" ? "FORBIDDEN" :
        error.code === "GITHUB_INVALID_REQUEST" ? "INVALID_COMMAND" :
        error.code === "GITHUB_CONFLICT" ? "CONFLICT" :
        error.code === "GITHUB_RATE_LIMITED" ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
        message: error.code,
        ...(error.retryAfterSeconds ? { details: { retryAfterSeconds: error.retryAfterSeconds } } : {}) }
    };
  }
  if (error instanceof ControlError) {
    return {
      ok: false,
      commandId,
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    };
  }

  if (error instanceof AuthError) {
    const code =
      error.code === "FORBIDDEN" || error.code === "USER_INACTIVE"
        ? "FORBIDDEN"
        : "UNAUTHENTICATED";

    return {
      ok: false,
      commandId,
      error: {
        code,
        message: code === "FORBIDDEN" ? "access forbidden" : "authentication required"
      }
    };
  }

  return {
    ok: false,
    commandId,
    error: {
      code: "INTERNAL_ERROR",
      message: "internal control error"
    }
  };
}

export function registerControlRoutes(
  app: FastifyInstance,
  pool: Pool,
  control = new ControlService(pool)
): void {
  app.post<{ Body: ControlBody }>(
    "/control/commands",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["action", "projectId"],
          properties: {
            commandId: { type: "string", minLength: 1, maxLength: 128 },
            action: { type: "string", enum: [...CONTROL_ACTIONS] },
            projectId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
            targetId: { type: "string", maxLength: 128 },
            payload: { type: "object" }
          }
        }
      }
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const commandId = request.body.commandId ?? randomUUID();

      try {
        const actor = await requireAuthenticatedUser(pool, request);
        const command: ControlCommand = {
          commandId,
          action: request.body.action,
          projectId: request.body.projectId,
          targetId: request.body.targetId,
          payload: request.body.payload
        };

        const result = await control.execute(command, {
          actor,
          correlationId:
            typeof request.id === "string" ? request.id : String(request.id)
        });

        if (command.action === "START_GITHUB_INSTALLATION" || command.action === "CONNECT_GITHUB_IDENTITY") {
          const data = result.data as { installUrl: string; cookieState: string };
          reply.header("Set-Cookie", `__Host-jev_github_install=${data.cookieState}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
          return reply.code(200).send({ ...result, data: { installUrl: data.installUrl } });
        }

        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof GitHubError && error.retryAfterSeconds) reply.header("Retry-After", error.retryAfterSeconds);
        const failure = asFailure(error, commandId);
        return reply.code(errorStatus(failure.error.code)).send(failure);
      }
    }
  );

  app.get<{ Querystring: { state?: string; installation_id?: string; code?: string; setup_action?: string; error?: string } }>(
    "/integrations/github/callback",
    { schema: { querystring: {
      type: "object", additionalProperties: false,
      properties: {
        state: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
        installation_id: { type: "string", pattern: "^[1-9][0-9]{0,15}$" },
        code: { type: "string", minLength: 1, maxLength: 256 },
        setup_action: { type: "string", enum: ["install", "update"] },
        error: { type: "string", maxLength: 128 }
      }
    } } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Referrer-Policy", "no-referrer");
      const clearCookie = () => reply.header("Set-Cookie", "__Host-jev_github_install=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
      try {
        if (request.query.error) throw new GitHubError("GITHUB_FORBIDDEN");
        const cookies = request.headers.cookie?.split(";").map((item) => item.trim()).filter((item) => item.startsWith("__Host-jev_github_install=")) ?? [];
        const result = await control.completeGitHubInstallation({
          state: request.query.state,
          cookieState: cookies.length === 1 ? cookies[0].slice("__Host-jev_github_install=".length) : undefined,
          installationId: request.query.installation_id ? Number(request.query.installation_id) : undefined,
          code: request.query.code
        }, request.id);
        if ("authorizeUrl" in result) return reply.redirect(result.authorizeUrl);
        clearCookie();
        if (request.headers.accept?.includes("text/html")) {
          return reply.type("text/html; charset=utf-8").send(
            '<!doctype html><html lang="es"><meta charset="utf-8"><title>GitHub conectado</title><body><h1>Conexión GitHub completada</h1><p>La autorización se ha registrado. Vuelve a JEV e inicia sesión para continuar.</p><a href="/">Volver a JEV</a></body></html>'
          );
        }
        return reply.send({ ok: true, ...result });
      } catch (error) {
        clearCookie();
        const failure = asFailure(error);
        return reply.code(errorStatus(failure.error.code)).send(failure);
      }
    }
  );
}

