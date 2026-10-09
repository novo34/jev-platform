import type { Pool } from "pg";

export interface CreateDeploymentInput {
  projectId: string;
  repositoryId: string;
  environmentId: string;
  taskId?: string;
  revision: string;
  status: "READY" | "RUNNING" | "VERIFYING" | "VERIFIED" | "BLOCKED" | "FAILED" | "REJECTED";
  url?: string;
  provider?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Restricted-runtime staging deployment writer. The SQL function acquires
 * project scope first, checks Task/Environment scope and applies all triggers.
 * Callers must authenticate and authorize the user/job before invoking it.
 */
export async function createDeployment(
  pool: Pool,
  input: CreateDeploymentInput
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "SELECT jev_create_deployment($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,$7::text,$8::text,$9::jsonb) AS id",
    [
      input.projectId, input.repositoryId, input.environmentId,
      input.taskId ?? null, input.revision, input.status, input.url ?? null,
      input.provider ?? null, JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0].id;
}

export interface CreateApprovalInput {
  projectId: string;
  taskId: string;
  actorUserId: string;
  decision: "APPROVED" | "CHANGES_REQUESTED" | "REJECTED";
  revision?: string;
  commitSha?: string;
  pullRequestUrl?: string;
  stagingUrl?: string;
  evidence?: Record<string, unknown>;
}

/**
 * Restricted-runtime human decision writer. The database validates actor
 * membership, legal review state and immutable approval lifecycle.
 * Upstream HTTP/service authorization must bind actorUserId to the
 * authenticated principal; never accept an arbitrary client actor ID.
 */
export async function createApproval(
  pool: Pool,
  input: CreateApprovalInput
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "SELECT jev_create_approval($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::text,$7::text,$8::text,$9::jsonb) AS id",
    [
      input.projectId, input.taskId, input.actorUserId, input.decision,
      input.revision ?? null, input.commitSha ?? null,
      input.pullRequestUrl ?? null, input.stagingUrl ?? null,
      JSON.stringify(input.evidence ?? {})
    ]
  );
  return result.rows[0].id;
}
