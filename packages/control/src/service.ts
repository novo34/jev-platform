import type { Pool, PoolClient } from "pg";
import { AuthError, authorizeProject } from "@jev/auth";
import { recordAudit } from "./audit.js";
import { GitHubError } from "./github-app.js";
import type { GitHubInstallationFlow } from "./github-installation.js";
import type { GitHubOperations } from "./github-operations.js";
import {
  CONTROL_ACTIONS,
  GITHUB_ACTIONS,
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
  RESUME_PROJECT: { permission: "project:admin", mutating: true },
  START_GITHUB_INSTALLATION: { permission: "project:admin", mutating: true },
  CONNECT_GITHUB_IDENTITY: { permission: "project:write", mutating: true },
  GITHUB_READ_REPOSITORY: { permission: "project:read", mutating: false },
  GITHUB_READ_PR: { permission: "project:read", mutating: false },
  GITHUB_READ_CHECKS: { permission: "project:read", mutating: false },
  GITHUB_READ_REVIEWS: { permission: "project:read", mutating: false },
  GITHUB_CREATE_BRANCH: { permission: "project:write", mutating: true },
  GITHUB_WRITE_FILE: { permission: "project:write", mutating: true },
  GITHUB_CREATE_PR: { permission: "project:write", mutating: true },
  GITHUB_MERGE_PR: { permission: "project:admin", mutating: true }
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
  constructor(private readonly pool: Pool, private readonly githubInstallation?: GitHubInstallationFlow,
    private readonly githubOperations?: GitHubOperations) {}

  async completeGitHubInstallation(input: Parameters<GitHubInstallationFlow["callback"]>[1], correlationId: string) {
    if (!this.githubInstallation) throw new GitHubError("GITHUB_INVALID_CONFIGURATION");
    return this.githubInstallation.callback(this.pool, input, correlationId);
  }

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

    if ((GITHUB_ACTIONS as readonly string[]).includes(command.action)) {
      try {
        if (!this.githubOperations) throw new GitHubError("GITHUB_INVALID_CONFIGURATION");
        const data = await this.githubOperations.execute(command, context, policy.permission);
        if (!policy.mutating) await recordAudit(this.pool, context, command, "SUCCESS");
        return { ok: true, commandId: command.commandId, action: command.action, data: data as T };
      } catch (error) {
        await recordAudit(this.pool, context, command, "FAILED", {
          code: error instanceof GitHubError ? error.code : "GITHUB_UNAVAILABLE"
        });
        throw error instanceof GitHubError ? error : new GitHubError("GITHUB_UNAVAILABLE");
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
      case "START_GITHUB_INSTALLATION":
      case "CONNECT_GITHUB_IDENTITY": {
        if (!this.githubInstallation) throw new GitHubError("GITHUB_INVALID_CONFIGURATION");
        return this.githubInstallation.start(client, context.actor, command.projectId, command.payload?.repositoryId,
          command.action === "CONNECT_GITHUB_IDENTITY" ? "IDENTITY" : "INSTALLATION");
      }
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

