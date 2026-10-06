import type { Pool, PoolClient } from "pg";
import { AuthError, authorizeProject } from "@jev/auth";
import {
  CONTROL_ACTIONS,
  ControlError,
  type ActionPolicy,
  type ControlAction,
  type ControlCommand,
  type ControlContext,
  type ControlSuccess
} from "./types.js";

const ACTION_POLICY: Record<ControlAction, ActionPolicy> = {
  GET_PROJECT_STATUS: { permission: "project:read", mutating: false },
  CREATE_ORDER: { permission: "project:write", mutating: true },
  PAUSE_PROJECT: { permission: "project:admin", mutating: true },
  RESUME_PROJECT: { permission: "project:admin", mutating: true }
};

function validateCommand(command: ControlCommand): void {
  if (!command.commandId?.trim()) {
    throw new ControlError("INVALID_COMMAND", "commandId is required");
  }
  if (!command.projectId?.trim()) {
    throw new ControlError("INVALID_COMMAND", "projectId is required");
  }
  if (!CONTROL_ACTIONS.includes(command.action)) {
    throw new ControlError("INVALID_COMMAND", "unsupported action");
  }
}

async function recordAudit(
  client: Pool | PoolClient,
  context: ControlContext,
  command: ControlCommand,
  result: "SUCCESS" | "BLOCKED" | "FAILED",
  details?: Record<string, unknown>,
  projectId: string | null = command.projectId
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (
       organization_id,
       project_id,
       actor_type,
       actor_id,
       action,
       target_type,
       target_id,
       result,
       evidence
     ) VALUES ($1, $2, 'USER', $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      context.actor.organizationId,
      projectId,
      context.actor.id,
      command.action,
      command.targetId ? "TARGET" : "PROJECT",
      command.targetId ?? command.projectId,
      result,
      JSON.stringify({
        commandId: command.commandId,
        correlationId: context.correlationId,
        ...details
      })
    ]
  );
}

function mapAuthorizationError(error: unknown): never {
  if (error instanceof AuthError) {
    if (error.code === "FORBIDDEN") {
      throw new ControlError("FORBIDDEN", "project action is not permitted");
    }
    throw new ControlError("UNAUTHENTICATED", "authentication required");
  }
  throw error;
}

export class ControlService {
  constructor(private readonly pool: Pool) {}

  async execute<T = unknown>(
    command: ControlCommand,
    context: ControlContext
  ): Promise<ControlSuccess<T>> {
    validateCommand(command);
    const policy = ACTION_POLICY[command.action];

    try {
      await authorizeProject(
        this.pool,
        context.actor,
        command.projectId,
        policy.permission
      );
    } catch (error) {
      try {
        await recordAudit(
          this.pool,
          context,
          command,
          "BLOCKED",
          {
            reason: error instanceof Error ? error.message : "authorization_failed",
            requestedProjectId: command.projectId
          },
          null
        );
      } finally {
        mapAuthorizationError(error);
      }
    }

    if (!policy.mutating) {
      try {
        const data = await this.executeRead(command);
        await recordAudit(this.pool, context, command, "SUCCESS");
        return {
          ok: true,
          commandId: command.commandId,
          action: command.action,
          data: data as T
        };
      } catch (error) {
        await recordAudit(this.pool, context, command, "FAILED", {
          reason: error instanceof Error ? error.message : "read_failed"
        });
        throw error;
      }
    }

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const data = await this.executeMutation(client, command, context);
      await recordAudit(client, context, command, "SUCCESS");
      await client.query("COMMIT");

      return {
        ok: true,
        commandId: command.commandId,
        action: command.action,
        data: data as T
      };
    } catch (error) {
      await client.query("ROLLBACK");
      await recordAudit(this.pool, context, command, "FAILED", {
        reason: error instanceof Error ? error.message : "mutation_failed"
      });
      throw error;
    } finally {
      client.release();
    }
  }

  private async executeRead(command: ControlCommand): Promise<unknown> {
    switch (command.action) {
      case "GET_PROJECT_STATUS": {
        const result = await this.pool.query(
          `SELECT id, name, status, priority, client_id
             FROM projects
            WHERE id = $1
            LIMIT 1`,
          [command.projectId]
        );

        const project = result.rows[0];

        if (!project) {
          throw new ControlError("NOT_FOUND", "project not found");
        }

        return { project };
      }
      default:
        throw new ControlError("INVALID_COMMAND", "action is not read-only");
    }
  }

  private async executeMutation(
    client: PoolClient,
    command: ControlCommand,
    context: ControlContext
  ): Promise<unknown> {
    switch (command.action) {
      case "CREATE_ORDER": {
        const payload = command.payload ?? {};
        const objective =
          typeof payload.objective === "string" ? payload.objective.trim() : "";

        if (!objective) {
          throw new ControlError(
            "INVALID_COMMAND",
            "CREATE_ORDER requires payload.objective"
          );
        }

        const result = await client.query(
          `INSERT INTO orders (
             project_id,
             author_user_id,
             objective,
             priority,
             status,
             work_type,
             constraints,
             acceptance_criteria,
             attachments
           ) VALUES ($1, $2, $3, $4, 'PLANNED', $5, $6::jsonb, $7::jsonb, $8::jsonb)
           RETURNING id, project_id, author_user_id, objective, priority, status, work_type, created_at`,
          [
            command.projectId,
            context.actor.id,
            objective,
            typeof payload.priority === "string" ? payload.priority : "NORMAL",
            typeof payload.workType === "string" ? payload.workType : "GENERAL",
            JSON.stringify(payload.constraints ?? []),
            JSON.stringify(payload.acceptanceCriteria ?? []),
            JSON.stringify(payload.attachments ?? [])
          ]
        );
        return { order: result.rows[0] };
      }
      case "PAUSE_PROJECT":
      case "RESUME_PROJECT": {
        const nextStatus = command.action === "PAUSE_PROJECT" ? "PAUSED" : "ACTIVE";
        const result = await client.query(
          `UPDATE projects
              SET status = $2, updated_at = NOW()
            WHERE id = $1
            RETURNING id, name, status, priority`,
          [command.projectId, nextStatus]
        );

        const project = result.rows[0];
        if (!project) {
          throw new ControlError("NOT_FOUND", "project not found");
        }
        return { project };
      }
      default:
        throw new ControlError("INVALID_COMMAND", "action is not mutating");
    }
  }
}
