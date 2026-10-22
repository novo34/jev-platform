import type { Pool, PoolClient } from "pg";

export async function recordAudit(
  client: Pool | PoolClient,
  context: { actor: { id: string; organizationId: string }; correlationId: string },
  command: { action: string; commandId: string; projectId: string; targetId?: string },
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

