import { createDeployment, createEnvironment, setDeploymentStatuses } from "@jev/db";
import type { Pool } from "pg";
import type { DeploymentRegistry } from "./orchestrator.js";

export const STAGING_ENVIRONMENT_NAME = "staging";
export const STAGING_DEPLOYMENT_PROVIDER = "dokploy";

/**
 * Finds the repository's `kind='staging'` environment or creates it with
 * `jev_create_environment`. Reads rely on the runtime role's SELECT; every
 * write goes through the controlled SQL function.
 */
export async function ensureStagingEnvironment(
  pool: Pool,
  input: { projectId: string; repositoryId: string; stagingUrl: string }
): Promise<string> {
  const find = async (): Promise<string | null> => {
    const found = await pool.query<{ id: string }>(
      "SELECT id FROM environments WHERE project_id=$1::uuid AND repository_id=$2::uuid AND kind='staging' ORDER BY created_at, id LIMIT 1",
      [input.projectId, input.repositoryId]
    );
    return found.rows[0]?.id ?? null;
  };
  const existing = await find();
  if (existing) return existing;
  try {
    return await createEnvironment(pool, {
      projectId: input.projectId, repositoryId: input.repositoryId, kind: "staging",
      name: STAGING_ENVIRONMENT_NAME, url: input.stagingUrl, metadata: { managedBy: "STAGING_DEPLOY" }
    });
  } catch (error) {
    // Concurrent creation of the same (project, repository, kind, name).
    if ((error as { code?: string }).code === "23505") {
      const raced = await find();
      if (raced) return raced;
    }
    throw error;
  }
}

/**
 * Deployment registry over the controlled writers `jev_create_deployment` and
 * `jev_set_deployment_status`. The deployment is created RUNNING with its final
 * `url` and `revision` (status updates cannot change them), so a later READY
 * satisfies the AWAITING_HUMAN trigger of 0016.
 */
export class PgDeploymentRegistry implements DeploymentRegistry {
  constructor(private readonly pool: Pool) {}

  async begin({ request, revision }: Parameters<DeploymentRegistry["begin"]>[0]): Promise<{ deploymentId: string; environmentId: string }> {
    const environmentId = await ensureStagingEnvironment(this.pool, {
      projectId: request.projectId, repositoryId: request.repositoryId, stagingUrl: request.stagingUrl
    });
    const deploymentId = await createDeployment(this.pool, {
      projectId: request.projectId, repositoryId: request.repositoryId, environmentId, taskId: request.taskId,
      revision, status: "RUNNING", url: request.stagingUrl, provider: STAGING_DEPLOYMENT_PROVIDER,
      metadata: { pipeline: "STAGING_DEPLOY", stagingBranch: request.stagingBranch, sourceBranch: request.sourceBranch }
    });
    return { deploymentId, environmentId };
  }

  async finish(input: Parameters<DeploymentRegistry["finish"]>[0]): Promise<void> {
    const updated = await setDeploymentStatuses(this.pool, input.projectId, [input.deploymentId], input.status);
    if (updated !== 1) throw new Error("deployment status update did not apply");
  }
}
