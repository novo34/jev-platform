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
    case "INVALID_COMMAND":
      return 400;
    case "INTERNAL_ERROR":
      return 500;
  }
}

function asFailure(error: unknown, commandId?: string): ControlFailure {
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

        return reply.code(200).send(result);
      } catch (error) {
        const failure = asFailure(error, commandId);
        return reply.code(errorStatus(failure.error.code)).send(failure);
      }
    }
  );
}
