/**
 * TypeScript equivalent of Foundation `staging/provider_policy.py` (FND-026),
 * plus the stricter branch set of PLT-010 (`production`, `prod`, default branch).
 */

export interface StagingDeploymentRequest {
  projectId: string;
  taskId: string;
  repositoryId: string;
  /** `owner/name`. */
  repository: string;
  sourceBranch: string;
  stagingBranch: string;
  stagingUrl: string;
  databaseRef: string;
  environmentKind: string;
  secretRefs: readonly string[];
  metadata?: Record<string, unknown>;
}

export interface StagingStepResult {
  ok: boolean;
  detail?: string;
  metadata?: Record<string, unknown>;
}

/** Neutral provider contract (Foundation `StagingProviderAdapter`). */
export interface StagingProviderAdapter {
  deploy(request: StagingDeploymentRequest): Promise<StagingStepResult>;
  verifyDatabase(request: StagingDeploymentRequest): Promise<StagingStepResult>;
  applyMigrations(request: StagingDeploymentRequest): Promise<StagingStepResult>;
  seedTestData(request: StagingDeploymentRequest): Promise<StagingStepResult>;
  healthCheck(request: StagingDeploymentRequest): Promise<StagingStepResult>;
  runOnlineE2E(request: StagingDeploymentRequest): Promise<StagingStepResult>;
}

export interface StagingReferencePolicy {
  databaseRefs: ReadonlySet<string>;
  secretRefs: ReadonlySet<string>;
  /** Base domain: `staging_url` must be `https://<slug>.staging.<stagingBaseDomain>`. */
  stagingBaseDomain: string;
  /** Extra protected branches (for example the repository default branch). */
  protectedBranches?: ReadonlySet<string>;
}

export class StagingPolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StagingPolicyError";
  }
}

const PRODUCTION_BRANCHES = new Set(["main", "master", "production", "prod"]);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function isProductionBranch(branch: string, policy: StagingReferencePolicy): boolean {
  const normalized = branch.trim().toLowerCase();
  return PRODUCTION_BRANCHES.has(normalized) || (policy.protectedBranches?.has(branch) ?? false);
}

/** Extracts the project slug from `https://<slug>.staging.<base>`; throws a policy error otherwise. */
export function slugFromStagingUrl(stagingUrl: string, baseDomain: string): string {
  let url: URL;
  try {
    url = new URL(stagingUrl);
  } catch {
    throw new StagingPolicyError("staging_url_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new StagingPolicyError("staging_url_must_be_plain_https");
  const suffix = `.staging.${baseDomain.toLowerCase()}`;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(suffix)) throw new StagingPolicyError("staging_url_host_not_allowed");
  const slug = host.slice(0, -suffix.length);
  if (!SLUG.test(slug)) throw new StagingPolicyError("staging_url_slug_invalid");
  return slug;
}

export function validateStagingRequest(request: StagingDeploymentRequest, policy: StagingReferencePolicy): void {
  if (request.environmentKind !== "PERMANENT_STAGING") throw new StagingPolicyError("environment_must_be_permanent_staging");
  if (isProductionBranch(request.sourceBranch, policy)) throw new StagingPolicyError("task_source_branch_must_not_be_production");
  if (isProductionBranch(request.stagingBranch, policy)) throw new StagingPolicyError("staging_branch_must_not_be_production");
  if (request.sourceBranch === request.stagingBranch) throw new StagingPolicyError("source_and_staging_branch_must_differ");
  if (!request.stagingUrl) throw new StagingPolicyError("staging_url_required");
  if (!request.databaseRef) throw new StagingPolicyError("staging_database_ref_required");
  if (!policyHas(policy.databaseRefs, request.databaseRef)) throw new StagingPolicyError("staging_database_reference_not_allowed");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository)) throw new StagingPolicyError("repository_invalid");
  const unknown = request.secretRefs.filter((ref) => !policyHas(policy.secretRefs, ref));
  if (unknown.length > 0) throw new StagingPolicyError(`staging_secret_reference_not_allowed:${[...new Set(unknown)].sort().join(",")}`);
  slugFromStagingUrl(request.stagingUrl, policy.stagingBaseDomain);
}

function policyHas(set: ReadonlySet<string>, value: string): boolean {
  return set.has(value);
}
