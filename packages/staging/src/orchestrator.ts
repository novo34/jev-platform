import { StagingPolicyError, type StagingDeploymentRequest, type StagingProviderAdapter, type StagingStepResult } from "./policy.js";
import { sanitizeText } from "./sanitize.js";

/** FND-026 order: deploy, database, migrations, seed, health, e2e. */
export const STAGING_STAGES = ["deploy", "verifyDatabase", "applyMigrations", "seedTestData", "healthCheck", "runOnlineE2E"] as const;
export type StagingStage = (typeof STAGING_STAGES)[number];

/** `passed` and `failed` are definitive; `unknown` and `degraded` never become READY; `not_run` follows a stop. */
export type StageStatus = "passed" | "failed" | "unknown" | "degraded" | "not_run";

export interface StageEvidence {
  stage: StagingStage;
  status: StageStatus;
  detail: string;
  metadata: Record<string, unknown>;
  durationMs: number;
}

/** Platform deployment statuses the orchestrator uses (see the mapping table of PLT-012). */
export type OrchestratorOutcome = "READY" | "FAILED" | "BLOCKED";
export type BlockedReason = "aborted" | "stage_error" | "unknown_result" | "degraded";

export interface StagingRunResult {
  outcome: OrchestratorOutcome;
  deploymentId: string;
  environmentId: string;
  revision: string;
  url: string;
  stages: StageEvidence[];
  failedStage?: StagingStage;
  blockedReason?: BlockedReason;
}

/** Controlled deployment writer (implemented over `createDeployment`/`setDeploymentStatuses`). */
export interface DeploymentRegistry {
  begin(input: { request: StagingDeploymentRequest; revision: string }): Promise<{ deploymentId: string; environmentId: string }>;
  finish(input: { projectId: string; deploymentId: string; status: OrchestratorOutcome }): Promise<void>;
}

export interface StagingRunInput {
  request: StagingDeploymentRequest;
  /** SHA deployed to staging (the head integrated into `staging_branch`). */
  revision: string;
  signal?: AbortSignal;
  /** Concrete secret values to redact from the evidence, in addition to the known credential shapes. */
  secrets?: readonly string[];
}

const MAX_DETAIL = 500;
const MAX_METADATA_JSON = 4000;

/** Deep-sanitizes evidence: strings are redacted, depth and size are bounded. */
export function sanitizeEvidence(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (typeof value === "string") return sanitizeText(value, secrets).slice(0, MAX_DETAIL);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 3) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeEvidence(item, secrets, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) out[sanitizeText(key, secrets)] = sanitizeEvidence(item, secrets, depth + 1);
    return out;
  }
  return undefined;
}

function boundedMetadata(metadata: unknown, secrets: readonly string[]): Record<string, unknown> {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const clean = sanitizeEvidence(metadata, secrets) as Record<string, unknown>;
  return JSON.stringify(clean).length > MAX_METADATA_JSON ? { truncated: true } : clean;
}

/**
 * Pure decision: READY only when every stage is `passed` (complete evidence).
 * A stop at a failed stage is FAILED; anything unknown, degraded, aborted or
 * missing is BLOCKED. Exported so the rule is tested on its own.
 */
export function decideOutcome(stages: readonly StageEvidence[], aborted = false): { outcome: OrchestratorOutcome; failedStage?: StagingStage; blockedReason?: BlockedReason } {
  if (aborted) return { outcome: "BLOCKED", blockedReason: "aborted" };
  const failed = stages.find((stage) => stage.status === "failed");
  if (failed) return { outcome: "FAILED", failedStage: failed.stage };
  const unknown = stages.find((stage) => stage.status === "unknown");
  if (unknown) return { outcome: "BLOCKED", failedStage: unknown.stage, blockedReason: unknown.detail.startsWith("exception:") ? "stage_error" : "unknown_result" };
  const degraded = stages.find((stage) => stage.status === "degraded");
  if (degraded) return { outcome: "BLOCKED", failedStage: degraded.stage, blockedReason: "degraded" };
  const complete = STAGING_STAGES.every((name) => stages.some((stage) => stage.stage === name && stage.status === "passed"));
  if (!complete) return { outcome: "BLOCKED", blockedReason: "unknown_result" };
  return { outcome: "READY" };
}

class AbortedError extends Error {}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new AbortedError("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

/**
 * Runs the FND-026 pipeline against a provider adapter, stops at the first
 * stage that does not pass, and records the deployment through the controlled
 * writers (never direct DML): RUNNING at start, then READY/FAILED/BLOCKED.
 *
 * Errors thrown by the registry (database) propagate: without a recorded
 * status nothing may be assumed. Stage exceptions do not propagate: they are
 * evidence of an unknown result and block the deployment.
 */
export class StagingOrchestrator {
  constructor(
    private readonly adapter: StagingProviderAdapter,
    private readonly registry: DeploymentRegistry
  ) {}

  async run(input: StagingRunInput): Promise<StagingRunResult> {
    const { request, revision, signal } = input;
    const secrets = input.secrets ?? [];
    const { deploymentId, environmentId } = await this.registry.begin({ request, revision });
    const stages: StageEvidence[] = STAGING_STAGES.map((stage) => ({ stage, status: "not_run", detail: "not_run", metadata: {}, durationMs: 0 }));
    let aborted = false;
    try {
      for (let index = 0; index < STAGING_STAGES.length; index += 1) {
        if (signal?.aborted) { aborted = true; break; }
        const stage = STAGING_STAGES[index];
        const started = Date.now();
        let evidence: StageEvidence;
        try {
          const result = await abortable(Promise.resolve(this.adapter[stage](request)), signal);
          evidence = this.evidenceFor(stage, result, Date.now() - started, secrets);
        } catch (error) {
          if (error instanceof AbortedError) { aborted = true; break; }
          const message = sanitizeText(error instanceof Error ? error.message : String(error), secrets).slice(0, 200);
          evidence = error instanceof StagingPolicyError
            ? { stage, status: "failed", detail: sanitizeText(error.code, secrets), metadata: {}, durationMs: Date.now() - started }
            : { stage, status: "unknown", detail: `exception:${message}`, metadata: {}, durationMs: Date.now() - started };
        }
        stages[index] = evidence;
        if (evidence.status !== "passed") break;
      }
    } catch (error) {
      await this.registry.finish({ projectId: request.projectId, deploymentId, status: "BLOCKED" }).catch(() => undefined);
      throw error;
    }

    const decision = decideOutcome(stages, aborted);
    await this.registry.finish({ projectId: request.projectId, deploymentId, status: decision.outcome });
    return { ...decision, deploymentId, environmentId, revision, url: request.stagingUrl, stages };
  }

  private evidenceFor(stage: StagingStage, result: StagingStepResult, durationMs: number, secrets: readonly string[]): StageEvidence {
    if (result === null || typeof result !== "object" || typeof result.ok !== "boolean") {
      return { stage, status: "unknown", detail: "invalid_stage_result", metadata: {}, durationMs };
    }
    const metadata = boundedMetadata(result.metadata, secrets);
    const detail = sanitizeText(typeof result.detail === "string" ? result.detail : "", secrets).slice(0, MAX_DETAIL);
    // Foundation DEGRADED: the stage answered but flagged the result as not fully healthy.
    const status: StageStatus = !result.ok ? "failed" : result.metadata?.degraded === true ? "degraded" : "passed";
    return { stage, status, detail, metadata, durationMs };
  }
}
