import { createDeployment, createEnvironment, setDeploymentStatuses, type Queryable } from "@jev/db";
import type { Pool, PoolClient } from "pg";
import type { DeploymentRegistry } from "./orchestrator.js";

export const STAGING_ENVIRONMENT_NAME = "staging";
export const STAGING_DEPLOYMENT_PROVIDER = "dokploy";

/**
 * Finds the repository's `kind='staging'` environment or creates it with
 * `jev_create_environment`. Reads rely on the runtime role's SELECT; every
 * write goes through the controlled SQL function.
 */
export async function ensureStagingEnvironment(
  pool: Queryable,
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
 *
 * Reservation: `begin` takes a PostgreSQL session advisory lock keyed by the
 * (project, repository) staging on a dedicated connection that is held until
 * `finish`. If another run holds it, `begin` returns `busy` (no waiting: the
 * caller is BLOCKED `staging_busy` and the job retries later). The lock dies
 * with its connection, so a crashed process never leaves staging reserved.
 * `pg_try_advisory_lock` is a system function: no extra grant is needed.
 */
export class PgDeploymentRegistry implements DeploymentRegistry {
  private readonly held = new Map<string, PoolClient>();

  constructor(private readonly pool: Pool) {}

  async begin({ request, revision }: Parameters<DeploymentRegistry["begin"]>[0]): Promise<{ deploymentId: string; environmentId: string; busy?: boolean }> {
    const lock = await this.reserve(request.projectId, request.repositoryId);
    // The reserved connection serves every query of the pipeline (a pool with `max: 1` would otherwise
    // wait forever for a second connection). When busy there is no reservation and the pool is used.
    const db: Queryable = lock ?? this.pool;
    try {
      const environmentId = await ensureStagingEnvironment(db, {
        projectId: request.projectId, repositoryId: request.repositoryId, stagingUrl: request.stagingUrl
      });
      const deploymentId = await createDeployment(db, {
        projectId: request.projectId, repositoryId: request.repositoryId, environmentId, taskId: request.taskId,
        revision, status: "RUNNING", url: request.stagingUrl, provider: STAGING_DEPLOYMENT_PROVIDER,
        metadata: { pipeline: "STAGING_DEPLOY", stagingBranch: request.stagingBranch, sourceBranch: request.sourceBranch }
      });
      if (lock) this.held.set(deploymentId, lock);
      return lock ? { deploymentId, environmentId } : { deploymentId, environmentId, busy: true };
    } catch (error) {
      if (lock) await release(lock);
      throw error;
    }
  }

  async finish(input: Parameters<DeploymentRegistry["finish"]>[0]): Promise<void> {
    const lock = this.held.get(input.deploymentId);
    this.held.delete(input.deploymentId);
    try {
      const updated = await setDeploymentStatuses(lock ?? this.pool, input.projectId, [input.deploymentId], input.status);
      if (updated !== 1) throw new Error("deployment status update did not apply");
    } finally {
      if (lock) await release(lock);
    }
  }

  /** Dedicated connection holding the lock, or `null` when another run owns it. */
  private async reserve(projectId: string, repositoryId: string): Promise<PoolClient | null> {
    const client = await this.pool.connect();
    try {
      const got = await client.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1::text, 53)) AS ok", [`staging:${projectId}:${repositoryId}`]);
      if (got.rows[0]?.ok === true) return client;
      client.release();
      return null;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }
}

/** Unlocks and returns the connection; if unlocking fails the connection is destroyed (which frees the lock). */
async function release(client: PoolClient): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock_all()");
    client.release();
  } catch {
    client.release(true);
  }
}
