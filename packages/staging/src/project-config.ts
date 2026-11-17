import type { Pool } from "pg";
import { DokployStagingAdapter, type DokployStagingConfig, type E2ERoute } from "./adapter.js";
import { DokployClient } from "./client.js";
import { slugFromStagingUrl, type StagingDeploymentRequest, type StagingProviderAdapter } from "./policy.js";

/**
 * Deployment-level settings that are NOT in the database. They belong to the
 * job activation (worker environment or a future per-project store, decided at
 * activation; the Dokploy API key is never stored in the database in PLT-012
 * step 4). Per project, the activation supplies these from its own source.
 */
export interface StagingDeploymentSettings {
  /** Base domain: `staging_url` must be `https://<slug>.staging.<stagingBaseDomain>`. */
  stagingBaseDomain: string;
  /** Dokploy environment that hosts the staging composes. */
  dokployEnvironmentId: string;
  dokployServerId?: string;
  /** Names allowed as secret references and their values (values never leave the worker). */
  secretRefs?: readonly string[];
  secretValues?: Readonly<Record<string, string>>;
  migrationCommand?: string;
  seedCommand?: string;
  healthPath?: string;
  e2eRoutes?: readonly E2ERoute[];
  appPort?: number;
  appImage?: string;
  extraEnv?: Readonly<Record<string, string>>;
  productionMarkers?: readonly string[];
}

/** Everything the job needs for one project/repository/task. */
export interface ProjectStagingConfig {
  request: StagingDeploymentRequest;
  settings: StagingDeploymentSettings;
  /** Repository default branch (protected in the staging policy). */
  defaultBranch: string;
}

export class StagingConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StagingConfigError";
  }
}

/** Database reference derived from the slug (`<slug>_staging`), allowed by the policy built from it. */
export function databaseRefFor(stagingUrl: string, stagingBaseDomain: string): string {
  return `${slugFromStagingUrl(stagingUrl, stagingBaseDomain).replace(/-/g, "_")}_staging`;
}

interface RepositoryRow {
  full_name: string;
  default_branch: string;
  staging_branch: string | null;
  staging_url: string | null;
  staging_database_enabled: boolean;
  branch_name: string | null;
}

/**
 * Default config provider: reads `repositories` (`staging_url`, `staging_branch`,
 * `staging_database_enabled`) and the task branch, and merges the injected
 * deployment settings. Read-only; requires the staging database to be enabled.
 */
export async function loadProjectStagingConfig(
  pool: Pool,
  ids: { projectId: string; repositoryId: string; taskId: string },
  settings: StagingDeploymentSettings
): Promise<ProjectStagingConfig> {
  const result = await pool.query<RepositoryRow>(
    `SELECT r.full_name, r.default_branch, r.staging_branch, r.staging_url, r.staging_database_enabled, t.branch_name
       FROM repositories r JOIN tasks t ON t.repository_id = r.id AND t.project_id = r.project_id
      WHERE r.id = $1::uuid AND r.project_id = $2::uuid AND t.id = $3::uuid`,
    [ids.repositoryId, ids.projectId, ids.taskId]
  );
  const row = result.rows[0];
  if (!row) throw new StagingConfigError("repository_or_task_not_found");
  if (!row.staging_database_enabled) throw new StagingConfigError("staging_database_not_enabled");
  if (!row.staging_branch?.trim()) throw new StagingConfigError("staging_branch_missing");
  if (!row.staging_url?.trim()) throw new StagingConfigError("staging_url_missing");
  return {
    defaultBranch: row.default_branch,
    settings,
    request: {
      projectId: ids.projectId, repositoryId: ids.repositoryId, taskId: ids.taskId,
      repository: row.full_name,
      sourceBranch: row.branch_name ?? `feat/jev-${ids.taskId}`,
      stagingBranch: row.staging_branch.trim(),
      stagingUrl: row.staging_url.trim(),
      databaseRef: databaseRefFor(row.staging_url.trim(), settings.stagingBaseDomain),
      environmentKind: "PERMANENT_STAGING",
      secretRefs: [...(settings.secretRefs ?? [])]
    }
  };
}

/** Builds the Dokploy adapter for one project config with an injected (already authenticated) client. */
export function createDokployAdapterFactory(client: DokployClient): (config: ProjectStagingConfig) => StagingProviderAdapter {
  return (config) => {
    const { settings, request } = config;
    const options: DokployStagingConfig = {
      client,
      environmentId: settings.dokployEnvironmentId,
      serverId: settings.dokployServerId,
      policy: {
        databaseRefs: new Set([request.databaseRef]),
        secretRefs: new Set(settings.secretRefs ?? []),
        stagingBaseDomain: settings.stagingBaseDomain,
        protectedBranches: new Set([config.defaultBranch])
      },
      secretValues: settings.secretValues,
      extraEnv: settings.extraEnv,
      productionMarkers: settings.productionMarkers,
      appPort: settings.appPort,
      appImage: settings.appImage,
      migrationCommand: settings.migrationCommand,
      seedCommand: settings.seedCommand,
      healthPath: settings.healthPath,
      e2eRoutes: settings.e2eRoutes
    };
    return new DokployStagingAdapter(options);
  };
}

/**
 * SHA integrated into `staging_branch` for the task, from the `github_operations` ledger
 * (`GITHUB_INTEGRATE_STAGING`, `status='SUCCESS'`, `result.sha`). Latest successful operation wins.
 * Read-only SELECT (`jev_runtime` has SELECT). `null` when the task was never integrated.
 */
export async function loadIntegratedRevision(
  pool: Pool,
  ids: { projectId: string; repositoryId: string; taskId: string }
): Promise<string | null> {
  const result = await pool.query<{ sha: string | null }>(
    `SELECT result->>'sha' AS sha FROM github_operations
      WHERE project_id=$1::uuid AND repository_id=$2::uuid AND task_id=$3::uuid
        AND action='GITHUB_INTEGRATE_STAGING' AND status='SUCCESS'
      ORDER BY created_at DESC, command_id DESC LIMIT 1`,
    [ids.projectId, ids.repositoryId, ids.taskId]
  );
  const sha = result.rows[0]?.sha;
  return typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
}
