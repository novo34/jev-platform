import { randomUUID } from "node:crypto";
import {
  PricingCatalog,
  observedCacheStatus,
  type ModelGatewayRequest,
  type ModelGatewayResult,
  type NormalizedUsage,
  type PriceRate,
  type PromptSegment
} from "@jev/model-gateway";

// PLT-052 PR 6/6: cache acceptance harness (core, no I/O of its own).
//
// Everything that can spend money is injected (`CacheAcceptanceDeps`), so CI runs
// the whole flow with simulated adapters and no network or keys. The default mode
// is a dry run: it prints the plan and the estimate and touches neither the
// network nor the database. A paid run needs the exact consent variable, a valid
// cap (<= CHF 0.10) and an upfront worst-case estimate within that cap.
// The harness never prints keys, authorization headers or prompt content.

export const CACHE_ACCEPTANCE_CONSENT = "I_AUTHORIZE_CACHE_PAID_CALLS";
export const CACHE_ACCEPTANCE_MAX_CAP_CHF = 0.1;
// Reference rate noted in docs/architecture/PLT-052-PROMPT-CACHING.md (2026-11-17).
export const USD_TO_CHF_REFERENCE = 0.8402;
export const ACCEPTANCE_PROVIDERS = ["anthropic", "openai", "deepseek"] as const;
export type AcceptanceProvider = (typeof ACCEPTANCE_PROVIDERS)[number];

export const DEFAULT_MODELS: Record<AcceptanceProvider, string> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-6.1-terra",
  deepseek: "deepseek-flash"
};

export const DEFAULT_MAX_OUTPUT_TOKENS = 16;
export const DEFAULT_PAUSE_MS = 5_000;
// Minimum estimated size of the cacheable prefix (covers OpenAI's 1024 and every
// Anthropic minimum of the chosen models).
export const MIN_PREFIX_TOKENS_ESTIMATE = 1_100;

export type CacheAcceptanceErrorCode =
  | "CONFIG_INVALID"
  | "CAP_REQUIRED"
  | "CAP_INVALID"
  | "CAP_ABOVE_LIMIT"
  | "PRICING_REQUIRED"
  | "ESTIMATE_EXCEEDS_CAP"
  | "NO_RUNNABLE_PROVIDERS"
  | "NOT_DEVELOPMENT"
  | "DB_NOT_LOCAL";

export class CacheAcceptanceError extends Error {
  constructor(readonly code: CacheAcceptanceErrorCode, message: string = code) {
    super(message);
    this.name = "CacheAcceptanceError";
  }
}

// ---------------------------------------------------------------------------
// Synthetic prompt (no real data, no dates, no digits, no UUIDs)
// ---------------------------------------------------------------------------

const WORDS = [
  "amber", "basalt", "cedar", "delta", "ember", "fjord", "garnet", "harbor", "indigo",
  "juniper", "kelp", "lagoon", "marble", "nectar", "onyx", "pebble", "quartz", "ripple",
  "sable", "thistle", "umber", "velvet", "willow", "xenon", "yarrow", "zephyr", "anchor",
  "bridge", "candle", "dune", "engine", "forest", "glacier", "hollow", "island", "jungle",
  "kernel", "ladder", "meadow", "needle", "orchard", "prairie", "quiver", "river",
  "summit", "tundra", "valley", "window", "yonder", "zenith", "arch", "beacon", "canyon",
  "dawn", "echo", "flint", "grove", "haven", "iris", "jade", "knoll", "lantern"
];

// Deterministic filler: the same seed always yields the same bytes.
export function syntheticText(seed: number, targetBytes: number): string {
  let state = seed >>> 0 || 1;
  const parts: string[] = [];
  let bytes = 0;
  while (bytes < targetBytes) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const word = WORDS[(state >>> 8) % WORDS.length]!;
    parts.push(word);
    bytes += word.length + 1;
  }
  return parts.join(" ") + ".";
}

export function buildAcceptanceSegments(): PromptSegment[] {
  return [
    { kind: "system", content: "Synthetic cache acceptance fixture. Reply with OK." },
    { kind: "rules", id: "acceptance-rules", version: "1", content: syntheticText(11, 3_600) },
    { kind: "project_context", content: syntheticText(23, 1_800) },
    { kind: "task_context", content: syntheticText(37, 700) },
    { kind: "input", content: "Reply with OK." }
  ];
}

export interface PromptStats {
  bytes: number;
  // Lower bound (4 bytes per token) used to prove the cache minimum is covered.
  tokensLowerBound: number;
  // Upper bound (2 bytes per token, like the gateway) used for the cost estimate.
  tokensUpperBound: number;
}

// Header of the tenant namespace line added by the builder, plus margin.
const BUILDER_OVERHEAD_BYTES = 400;

export function promptStats(segments: PromptSegment[]): PromptStats {
  const bytes = segments.reduce((sum, s) => sum + Buffer.byteLength(s.content, "utf8"), 0) +
    BUILDER_OVERHEAD_BYTES;
  return {
    bytes,
    tokensLowerBound: Math.floor((bytes - BUILDER_OVERHEAD_BYTES) / 4),
    tokensUpperBound: Math.ceil(bytes / 2)
  };
}

// ---------------------------------------------------------------------------
// Cap parsing
// ---------------------------------------------------------------------------

// Strict decimal (no exponent, sign, spaces or hex). Required, > 0 and <= 0.10.
export function parseCapChf(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    throw new CacheAcceptanceError("CAP_REQUIRED", "JEV_LIVE_CACHE_MAX_CHF is required");
  }
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) {
    throw new CacheAcceptanceError("CAP_INVALID", "JEV_LIVE_CACHE_MAX_CHF must be a plain decimal number such as 0.10");
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CacheAcceptanceError("CAP_INVALID", "JEV_LIVE_CACHE_MAX_CHF must be greater than 0");
  }
  if (value > CACHE_ACCEPTANCE_MAX_CAP_CHF) {
    throw new CacheAcceptanceError(
      "CAP_ABOVE_LIMIT", `JEV_LIVE_CACHE_MAX_CHF cannot exceed ${CACHE_ACCEPTANCE_MAX_CAP_CHF}`
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type CallLabel = "A-1" | "A-2" | "B-1";
const CALL_SEQUENCE: ReadonlyArray<{ label: CallLabel; tenant: "A" | "B" }> = [
  { label: "A-1", tenant: "A" },
  { label: "A-2", tenant: "A" },
  { label: "B-1", tenant: "B" }
];

export interface PlannedCall {
  label: CallLabel;
  tenant: "A" | "B";
  worstCaseChf: number;
}

export interface ProviderPlan {
  provider: AcceptanceProvider;
  model: string;
  runnable: boolean;
  skipReason?: string;
  missingRates: string[];
  calls: PlannedCall[];
  worstCaseChf: number;
}

export interface LiveConfig {
  databaseUrlPresent: true;
  organizationId: string;
  projectId: string;
  taskId: string;
  otherOrganizationId: string;
  otherProjectId: string;
  otherTaskId: string;
  encryptionKeyPresent: true;
  tenantSecret: string;
}

export interface PlanProblem {
  code: CacheAcceptanceErrorCode | "MISSING_VARIABLE";
  message: string;
}

export interface CacheAcceptancePlan {
  mode: "dry-run" | "live";
  capChf: number | undefined;
  maxOutputTokens: number;
  pauseMs: number;
  prompt: PromptStats;
  providers: ProviderPlan[];
  worstCaseChf: number;
  worstCaseUsd: number;
  missingVariables: string[];
  problems: PlanProblem[];
  live?: LiveConfig;
}

type Env = Record<string, string | undefined>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

// Pricing requirements that mirror what the gateway needs for these calls: Anthropic
// marks the cache (1h project block, 5m task block); OpenAI and DeepSeek cache
// automatically (read rate always; OpenAI also needs its write rate for reported writes).
function missingRatesFor(catalog: PricingCatalog, provider: AcceptanceProvider, model: string): string[] {
  if (provider === "anthropic") {
    return catalog.missingRates(provider, model, { cacheEnabled: true, cacheWriteTtls: ["1h", "5m"] });
  }
  if (provider === "openai") {
    return catalog.missingRates(provider, model, { cacheEnabled: true, cacheWriteTtls: ["30m"] });
  }
  return catalog.missingRates(provider, model);
}

// Worst case of ONE call: the whole prompt billed at the highest applicable input
// rate (for Anthropic, the 1h write rate) plus the full output allowance.
function worstCaseCallChf(rate: PriceRate, prompt: PromptStats, maxOutputTokens: number): number {
  const inputRates = [
    rate.inputPerMillionChf, rate.cacheReadPerMillionChf, rate.cacheWrite5mPerMillionChf,
    rate.cacheWrite1hPerMillionChf, rate.cacheWrite30mPerMillionChf, rate.cacheWrite12hPerMillionChf
  ].filter((value): value is number => value !== undefined);
  const worstInput = Math.max(...inputRates);
  return (prompt.tokensUpperBound * worstInput + maxOutputTokens * rate.outputPerMillionChf) / 1_000_000;
}

function readInt(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new CacheAcceptanceError("CONFIG_INVALID", `${name} must be an integer between ${min} and ${max}`);
  }
  return Number(raw);
}

// Never throws and never touches the network or the database: a plan with a list
// of problems is what the dry run prints and what a live run refuses to start from.
export function buildCacheAcceptancePlan(env: Env): CacheAcceptancePlan {
  const problems: PlanProblem[] = [];
  const missingVariables: string[] = [];
  const guard = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof CacheAcceptanceError) problems.push({ code: error.code, message: error.message });
      else problems.push({ code: "CONFIG_INVALID", message: "invalid configuration" });
      return fallback;
    }
  };

  const consent = env.JEV_LIVE_CACHE_ACCEPTANCE === CACHE_ACCEPTANCE_CONSENT;
  let capChf: number | undefined;
  if (env.JEV_LIVE_CACHE_MAX_CHF === undefined || env.JEV_LIVE_CACHE_MAX_CHF === "") {
    missingVariables.push("JEV_LIVE_CACHE_MAX_CHF");
    problems.push({ code: "CAP_REQUIRED", message: "JEV_LIVE_CACHE_MAX_CHF is required (numeric, > 0, at most 0.10)" });
  } else {
    capChf = guard<number | undefined>(() => parseCapChf(env.JEV_LIVE_CACHE_MAX_CHF), undefined);
  }
  if (!consent) missingVariables.push("JEV_LIVE_CACHE_ACCEPTANCE=" + CACHE_ACCEPTANCE_CONSENT + " (required for a paid run)");

  const maxOutputTokens = guard(
    () => readInt(env.JEV_ACCEPT_CACHE_MAX_OUTPUT_TOKENS, "JEV_ACCEPT_CACHE_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS, 1, 256),
    DEFAULT_MAX_OUTPUT_TOKENS
  );
  const pauseMs = guard(
    () => readInt(env.JEV_ACCEPT_CACHE_PAUSE_MS, "JEV_ACCEPT_CACHE_PAUSE_MS", DEFAULT_PAUSE_MS, 0, 60_000),
    DEFAULT_PAUSE_MS
  );

  const requested = (env.JEV_ACCEPT_CACHE_PROVIDERS ?? ACCEPTANCE_PROVIDERS.join(",")).split(",");
  const selected = guard(() => {
    if (requested.some(name => !(ACCEPTANCE_PROVIDERS as readonly string[]).includes(name)) ||
        new Set(requested).size !== requested.length) {
      throw new CacheAcceptanceError("CONFIG_INVALID", "JEV_ACCEPT_CACHE_PROVIDERS must be a list of distinct providers among anthropic, openai, deepseek");
    }
    return requested as AcceptanceProvider[];
  }, [] as AcceptanceProvider[]);

  let catalog: PricingCatalog | undefined;
  const pricingJson = env.JEV_MODEL_PRICING_JSON;
  if (!pricingJson) {
    missingVariables.push("JEV_MODEL_PRICING_JSON");
  } else {
    catalog = guard<PricingCatalog | undefined>(() => PricingCatalog.fromJson(pricingJson), undefined);
  }
  let rates: Record<string, PriceRate> = {};
  if (pricingJson && catalog) {
    try {
      rates = JSON.parse(pricingJson) as Record<string, PriceRate>;
    } catch {
      rates = {};
    }
  }

  const prompt = promptStats(buildAcceptanceSegments());
  if (prompt.tokensLowerBound < MIN_PREFIX_TOKENS_ESTIMATE) {
    problems.push({ code: "CONFIG_INVALID", message: "synthetic prompt is below the cache minimum" });
  }

  const providers: ProviderPlan[] = selected.map(provider => {
    const modelRaw = env[`JEV_ACCEPT_CACHE_${provider.toUpperCase()}_MODEL`] ?? DEFAULT_MODELS[provider];
    const model = guard(() => {
      if (!MODEL_ID.test(modelRaw)) {
        throw new CacheAcceptanceError("CONFIG_INVALID", `invalid model id for ${provider}`);
      }
      return modelRaw;
    }, DEFAULT_MODELS[provider]);
    const missing = catalog ? missingRatesFor(catalog, provider, model) : ["inputPerMillionChf", "outputPerMillionChf", "cacheReadPerMillionChf"];
    const rate = rates[`${provider}:${model}`] ?? rates[`${provider}:*`];
    const runnable = catalog !== undefined && missing.length === 0 && rate !== undefined;
    const perCall = runnable ? worstCaseCallChf(rate!, prompt, maxOutputTokens) : 0;
    return {
      provider,
      model,
      runnable,
      ...(runnable ? {} : {
        skipReason: `PRICING_REQUIRED: missing ${missing.join(", ") || "pricing"}`
      }),
      missingRates: missing,
      calls: CALL_SEQUENCE.map(call => ({ ...call, worstCaseChf: perCall })),
      worstCaseChf: perCall * CALL_SEQUENCE.length
    };
  });

  const worstCaseChf = providers.reduce((sum, p) => sum + p.worstCaseChf, 0);
  const plan: CacheAcceptancePlan = {
    mode: consent ? "live" : "dry-run",
    capChf,
    maxOutputTokens,
    pauseMs,
    prompt,
    providers,
    worstCaseChf,
    worstCaseUsd: worstCaseChf / USD_TO_CHF_REFERENCE,
    missingVariables,
    problems
  };

  if (capChf !== undefined && worstCaseChf > capChf) {
    problems.push({
      code: "ESTIMATE_EXCEEDS_CAP",
      message: `worst-case estimate CHF ${worstCaseChf.toFixed(6)} exceeds the cap CHF ${capChf}`
    });
  }

  // Live-only variables. Reported as missing in dry-run too, so the operator sees
  // everything needed before authorizing; only a live run turns them into errors.
  const need = (name: string): string | undefined => {
    const value = env[name];
    if (!value) missingVariables.push(name);
    return value;
  };
  const liveMissingBefore = missingVariables.length;
  if (env.NODE_ENV !== "development") {
    missingVariables.push("NODE_ENV=development");
    problems.push({ code: "NOT_DEVELOPMENT", message: "NODE_ENV must be development" });
  }
  const databaseUrl = need("DATABASE_URL");
  if (databaseUrl) {
    guard<void>(() => {
      let parsed: URL;
      try {
        parsed = new URL(databaseUrl);
      } catch {
        throw new CacheAcceptanceError("DB_NOT_LOCAL", "DATABASE_URL must be an isolated local PostgreSQL database");
      }
      if (!["postgres:", "postgresql:"].includes(parsed.protocol) ||
          !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
          parsed.search || parsed.hash) {
        throw new CacheAcceptanceError("DB_NOT_LOCAL", "Only an isolated local PostgreSQL database is allowed");
      }
    }, undefined);
  }
  const encryptionKey = need("JEV_SECRET_ENCRYPTION_KEY");
  const tenantSecret = need("JEV_TENANT_NAMESPACE_SECRET");
  const ids = ["JEV_ACCEPT_ORGANIZATION_ID", "JEV_ACCEPT_PROJECT_ID", "JEV_ACCEPT_TASK_ID",
    "JEV_ACCEPT_OTHER_PROJECT_ID", "JEV_ACCEPT_OTHER_TASK_ID"].map(name => {
    const value = need(name)?.toLowerCase();
    if (value && !UUID.test(value)) {
      problems.push({ code: "CONFIG_INVALID", message: `${name} must be a UUID` });
    }
    return value;
  });
  const otherOrgRaw = env.JEV_ACCEPT_OTHER_ORGANIZATION_ID?.toLowerCase();
  if (otherOrgRaw && !UUID.test(otherOrgRaw)) {
    problems.push({ code: "CONFIG_INVALID", message: "JEV_ACCEPT_OTHER_ORGANIZATION_ID must be a UUID" });
  }
  // Tenant namespace = HMAC(organization, project) (deriveTenantNamespace): if B
  // matches A in that pair, both calls share the cache prefix and the isolation
  // check would report a false cross-tenant read. A task belongs to one project,
  // so equal task ids are rejected as well.
  const [orgA, projA, taskA, projB, taskB] = ids;
  const orgB = otherOrgRaw ?? orgA;
  if (orgA && projA && projB && orgB === orgA && projB === projA) {
    problems.push({
      code: "CONFIG_INVALID",
      message: "tenant B must differ from tenant A in organization or project (same organization and project share the cache namespace)"
    });
  }
  if (taskA && taskB && taskA === taskB) {
    problems.push({ code: "CONFIG_INVALID", message: "JEV_ACCEPT_OTHER_TASK_ID must differ from JEV_ACCEPT_TASK_ID" });
  }
  const liveMissing = missingVariables.length > liveMissingBefore;
  if (liveMissing) {
    problems.push({ code: "MISSING_VARIABLE", message: "live variables are missing: " + missingVariables.slice(liveMissingBefore).join(", ") });
  }
  if (!liveMissing && encryptionKey && tenantSecret && ids.every(Boolean) &&
      !problems.some(p => p.code === "CONFIG_INVALID" || p.code === "DB_NOT_LOCAL" || p.code === "NOT_DEVELOPMENT")) {
    plan.live = {
      databaseUrlPresent: true,
      encryptionKeyPresent: true,
      tenantSecret,
      organizationId: ids[0]!,
      projectId: ids[1]!,
      taskId: ids[2]!,
      otherOrganizationId: otherOrgRaw ?? ids[0]!,
      otherProjectId: ids[3]!,
      otherTaskId: ids[4]!
    };
  }
  return plan;
}

// Fatal problems of a live run (anything that must stop before the first call).
// Missing pricing of one provider is NOT fatal: that provider is skipped.
export function assertLiveReady(plan: CacheAcceptancePlan): void {
  if (plan.mode !== "live") {
    throw new CacheAcceptanceError("CONFIG_INVALID", "paid run requires JEV_LIVE_CACHE_ACCEPTANCE=" + CACHE_ACCEPTANCE_CONSENT);
  }
  const fatal = plan.problems.find(p => p.code !== "ESTIMATE_EXCEEDS_CAP") ?? undefined;
  if (fatal) {
    throw new CacheAcceptanceError(fatal.code === "MISSING_VARIABLE" ? "CONFIG_INVALID" : fatal.code, fatal.message);
  }
  if (plan.capChf === undefined || !plan.live) {
    throw new CacheAcceptanceError("CONFIG_INVALID", "incomplete live configuration");
  }
  if (!plan.providers.some(p => p.runnable)) {
    throw new CacheAcceptanceError(
      plan.providers.length === 0 ? "NO_RUNNABLE_PROVIDERS" : "PRICING_REQUIRED",
      "no provider has all the required rates; nothing was called"
    );
  }
  if (plan.providers.filter(p => p.runnable).reduce((sum, p) => sum + p.worstCaseChf, 0) > plan.capChf) {
    throw new CacheAcceptanceError("ESTIMATE_EXCEEDS_CAP", "worst-case estimate exceeds the cap; nothing was called");
  }
}

// ---------------------------------------------------------------------------
// Observation of the real HTTP traffic (shape only, never content)
// ---------------------------------------------------------------------------

export type ShapeTree = string | { [key: string]: ShapeTree };

// Types of the fields, never their values. Depth-limited.
export function describeShape(value: unknown, depth = 3): ShapeTree {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value !== "object") return typeof value;
  if (depth <= 0) return "object";
  const out: { [key: string]: ShapeTree } = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = describeShape(inner, depth - 1);
  }
  return out;
}

export interface HttpErrorObservation {
  status: number;
  // Anthropic only: the documented {type:"error", error:{type,message}} envelope.
  envelope?: { wellFormed: boolean; type?: string; errorType?: string; message?: string };
}

export interface CallObservation {
  networkAttempts: number;
  blockedRetries: number;
  usageShape?: ShapeTree;
  httpError?: HttpErrorObservation;
}

// Keys and long opaque tokens never survive.
export function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/\b(sk|key|pk|rk)[-_][A-Za-z0-9*_-]{4,}/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .slice(0, 300);
}

export class CallObserver {
  active = false;
  provider: string | undefined;
  private attempts = 0;
  private blocked = 0;
  private usageShape?: ShapeTree;
  private httpError?: HttpErrorObservation;

  begin(provider: string): void {
    this.active = true;
    this.provider = provider;
    this.attempts = 0;
    this.blocked = 0;
    this.usageShape = undefined;
    this.httpError = undefined;
  }

  claimNetworkAttempt(): boolean {
    if (!this.active || this.attempts >= 1) {
      this.blocked += 1;
      return false;
    }
    this.attempts += 1;
    return true;
  }

  recordResponse(status: number, ok: boolean, body: unknown): void {
    if (ok) {
      const usage = (body as { usage?: unknown } | null)?.usage;
      this.usageShape = usage === undefined ? "missing" : describeShape(usage);
      return;
    }
    const error: HttpErrorObservation = { status };
    if (this.provider === "anthropic") {
      const b = body as { type?: unknown; error?: { type?: unknown; message?: unknown } } | null;
      const wellFormed = b?.type === "error" && typeof b.error?.type === "string" && typeof b.error?.message === "string";
      error.envelope = {
        wellFormed,
        ...(typeof b?.type === "string" ? { type: b.type } : {}),
        ...(typeof b?.error?.type === "string" ? { errorType: b.error.type } : {}),
        ...(typeof b?.error?.message === "string" ? { message: sanitizeProviderMessage(b.error.message) } : {})
      };
    }
    this.httpError = error;
  }

  finish(): CallObservation {
    const observation: CallObservation = {
      networkAttempts: this.attempts,
      blockedRetries: this.blocked,
      ...(this.usageShape !== undefined ? { usageShape: this.usageShape } : {}),
      ...(this.httpError ? { httpError: this.httpError } : {})
    };
    this.active = false;
    return observation;
  }
}

// Hard guarantee of "no paid retry": at most ONE network request per logical call,
// whatever the gateway or the adapter decide (including the policy's retry without
// cache). A second request, or any request outside a call, is refused BEFORE the
// network and counted.
export function createGuardedFetch(base: typeof fetch, observer: CallObserver): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!observer.claimNetworkAttempt()) {
      throw new Error("PAID_RETRY_BLOCKED");
    }
    const response = await base(input, init);
    try {
      observer.recordResponse(response.status, response.ok, await response.clone().json());
    } catch {
      observer.recordResponse(response.status, response.ok, null);
    }
    return response;
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface AcceptanceDeps {
  execute(request: ModelGatewayRequest): Promise<ModelGatewayResult>;
  // Providers with a stored credential for the organization (names only).
  listCredentialProviders(organizationId: string): Promise<string[]>;
  // cache_status persisted for the request: the value, or null when the row exists
  // with a NULL status. It must throw when the row cannot be read or is missing.
  lookupCacheStatus?(organizationId: string, requestId: string): Promise<string | null>;
  observer: CallObserver;
  pricing: PricingCatalog;
  sleep(ms: number): Promise<void>;
  newRequestId?(): string;
}

export type CheckStatus = "PASS" | "FAIL" | "INCONCLUSIVE" | "NOT_RUN";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
}

export interface CallReport {
  label: CallLabel;
  tenant: "A" | "B";
  provider: AcceptanceProvider;
  model: string;
  requestId: string;
  outcome: "SUCCESS" | "FAILED" | "NOT_RUN";
  errorCode?: string;
  attempts?: number;
  networkAttempts?: number;
  blockedRetries?: number;
  tokens?: {
    ordinary: number; cacheRead: number; cacheWrite: number; cacheWrite5m: number;
    cacheWrite1h: number; cacheWrite30m: number; cacheWrite12h: number;
    output: number; totalInput: number;
  };
  cacheStatus?: string | null;
  // Where cacheStatus comes from: the row read from PostgreSQL, inferred from the
  // response tokens (no lookup configured), or unavailable (the lookup failed or
  // found no row; the value is then null and never inferred). A row whose status
  // is NULL (e.g. DeepSeek) is still a database read.
  cacheStatusSource?: "database" | "derived" | "unavailable";
  costChf?: number | null;
  costWithoutCacheChf?: number | null;
  savingsChf?: number | null;
  // Failed call after a network request: the cost is unknown, the worst case is counted.
  assumedWorstCaseChf?: number;
  usageShape?: ShapeTree;
  httpError?: HttpErrorObservation;
}

export interface ProviderReport {
  provider: AcceptanceProvider;
  model: string;
  status: "RAN" | "SKIPPED";
  skipReason?: string;
  calls: CallReport[];
  checks: CheckResult[];
}

export interface CacheAcceptanceReport {
  kind: "plt-052-cache-acceptance";
  mode: "live";
  capChf: number;
  worstCaseEstimateChf: number;
  worstCaseEstimateUsd: number;
  fxUsdToChf: number;
  accumulatedChf: number;
  stoppedReason?: string;
  providers: ProviderReport[];
  overall: "PASS" | "FAIL" | "INCOMPLETE";
}

function tokensOf(usage: NormalizedUsage): NonNullable<CallReport["tokens"]> {
  return {
    ordinary: usage.inputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    cacheWrite5m: usage.cacheWrite5mTokens,
    cacheWrite1h: usage.cacheWrite1hTokens,
    cacheWrite30m: usage.cacheWrite30mTokens,
    cacheWrite12h: usage.cacheWrite12hTokens,
    output: usage.outputTokens,
    totalInput: usage.totalInputTokens
  };
}

const isCount = (n: unknown): boolean => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function usageMappingCheck(provider: AcceptanceProvider, calls: CallReport[]): CheckResult {
  const done = calls.filter(c => c.outcome === "SUCCESS" && c.tokens);
  if (done.length === 0) return { name: "usage_mapping", status: "NOT_RUN" };
  for (const call of done) {
    const t = call.tokens!;
    const values = Object.values(t);
    if (!values.every(isCount)) return { name: "usage_mapping", status: "FAIL", detail: `${call.label}: non-integer or negative counter` };
    if (t.totalInput !== t.ordinary + t.cacheWrite + t.cacheRead) {
      return { name: "usage_mapping", status: "FAIL", detail: `${call.label}: totalInput != ordinary + write + read` };
    }
    if (provider === "anthropic" && t.cacheWrite5m + t.cacheWrite1h !== t.cacheWrite) {
      return { name: "usage_mapping", status: "FAIL", detail: `${call.label}: write TTL breakdown does not add up` };
    }
    if (provider === "openai" && t.cacheWrite30m + t.cacheWrite12h > t.cacheWrite) {
      return { name: "usage_mapping", status: "FAIL", detail: `${call.label}: write TTL breakdown exceeds writes` };
    }
    if (t.output < 1) return { name: "usage_mapping", status: "FAIL", detail: `${call.label}: no output tokens` };
  }
  return { name: "usage_mapping", status: "PASS" };
}

function evaluateChecks(provider: AcceptanceProvider, calls: CallReport[]): CheckResult[] {
  const byLabel = new Map(calls.map(c => [c.label, c]));
  const a1 = byLabel.get("A-1");
  const a2 = byLabel.get("A-2");
  const b1 = byLabel.get("B-1");
  const ok = (c: CallReport | undefined): c is CallReport & { tokens: NonNullable<CallReport["tokens"]> } =>
    c?.outcome === "SUCCESS" && c.tokens !== undefined;
  const checks: CheckResult[] = [];
  // A PASS that depends on the persisted cache_status cannot stand when that
  // status could not be read: it becomes INCONCLUSIVE (a FAIL from tokens stays).
  const pending = (c: CallReport | undefined): boolean => c?.cacheStatusSource === "unavailable";
  const PENDING_DETAIL = "persisted cache_status could not be read from PostgreSQL";

  // 1. Write on the first call. Only Anthropic (explicit marks) is required to
  // report it; DeepSeek has no separately billed write, so it has no such check.
  if (provider === "deepseek") {
    // intentionally no write check
  } else if (!ok(a1)) checks.push({ name: "write_first_call", status: "NOT_RUN" });
  else if (a1.tokens.cacheWrite > 0) {
    checks.push(pending(a1)
      ? { name: "write_first_call", status: "INCONCLUSIVE", detail: PENDING_DETAIL }
      : { name: "write_first_call", status: "PASS" });
  }
  else if (provider === "anthropic") {
    checks.push({ name: "write_first_call", status: "FAIL", detail: "no cache_creation tokens on the first call" });
  } else {
    checks.push({ name: "write_first_call", status: "INCONCLUSIVE", detail: "this provider caches automatically and may not report writes" });
  }

  // 2. Read on the second call. DeepSeek is best-effort: no hit is not a failure
  // and, with no paid retries allowed, it is reported as inconclusive.
  if (!ok(a2)) checks.push({ name: "read_second_call", status: "NOT_RUN" });
  else if (a2.tokens.cacheRead > 0) {
    checks.push(pending(a2)
      ? { name: "read_second_call", status: "INCONCLUSIVE", detail: PENDING_DETAIL }
      : { name: "read_second_call", status: "PASS" });
  }
  else if (provider === "deepseek") {
    checks.push({ name: "read_second_call", status: "INCONCLUSIVE", detail: "DeepSeek cache is best effort; no paid retry is allowed" });
  } else {
    checks.push({ name: "read_second_call", status: "FAIL", detail: "no cache read on the second call" });
  }

  // 3. Tenant isolation: the other tenant must never read the first tenant's cache.
  if (!ok(b1)) checks.push({ name: "tenant_isolation", status: "NOT_RUN" });
  else if (b1.tokens.cacheRead === 0) {
    checks.push(pending(b1)
      ? { name: "tenant_isolation", status: "INCONCLUSIVE", detail: PENDING_DETAIL }
      : { name: "tenant_isolation", status: "PASS" });
  }
  else checks.push({ name: "tenant_isolation", status: "FAIL", detail: `cross-tenant cache read of ${b1.tokens.cacheRead} tokens` });

  // 4. Usage mapping invariants.
  checks.push(usageMappingCheck(provider, calls));

  // 5. Anthropic: creation attributed per TTL (1h project block, 5m task block).
  if (provider === "anthropic") {
    if (!ok(a1)) checks.push({ name: "ttl_attribution", status: "NOT_RUN" });
    else if (a1.tokens.cacheWrite1h > 0 && a1.tokens.cacheWrite5m > 0 &&
             a1.tokens.cacheWrite1h + a1.tokens.cacheWrite5m === a1.tokens.cacheWrite) {
      checks.push({ name: "ttl_attribution", status: "PASS" });
    } else {
      checks.push({ name: "ttl_attribution", status: "FAIL", detail: "expected cache creation in both the 1h and the 5m TTL" });
    }
  }

  // 6. OpenAI: shape and nullability of the usage details as really received.
  if (provider === "openai") {
    const shaped = calls.find(c => c.usageShape !== undefined);
    if (!shaped || typeof shaped.usageShape === "string") {
      checks.push({ name: "openai_usage_details_shape", status: "NOT_RUN" });
    } else {
      const details = (shaped.usageShape as Record<string, ShapeTree>)["input_tokens_details"];
      const kind = details === undefined ? "missing" : typeof details === "string" ? details : "object";
      checks.push({
        name: "openai_usage_details_shape",
        status: shaped.outcome === "SUCCESS" ? "PASS" : "FAIL",
        detail: `input_tokens_details is ${kind}; mapped without error`
      });
    }
  }

  // 7. Anthropic: real error envelope, only if an HTTP error actually happened.
  if (provider === "anthropic") {
    const failed = calls.find(c => c.httpError?.envelope !== undefined);
    if (!failed) checks.push({ name: "anthropic_error_format", status: "NOT_RUN", detail: "no HTTP error occurred" });
    else {
      const e = failed.httpError!.envelope!;
      checks.push({
        name: "anthropic_error_format",
        status: e.wellFormed ? "PASS" : "FAIL",
        detail: `HTTP ${failed.httpError!.status} type=${e.type ?? "?"} error.type=${e.errorType ?? "?"} message=${e.message ?? "?"}`
      });
    }
  }

  // 8. Savings: a read call must cost less than the same call without cache.
  if (!ok(a2) || a2.tokens.cacheRead === 0) checks.push({ name: "read_saves_cost", status: "NOT_RUN" });
  else if (typeof a2.savingsChf === "number" && a2.savingsChf > 0) checks.push({ name: "read_saves_cost", status: "PASS" });
  else checks.push({ name: "read_saves_cost", status: "FAIL", detail: "no positive savings on the read call" });

  // 9. No paid retry.
  const executed = calls.filter(c => c.outcome !== "NOT_RUN");
  const violated = executed.find(c => (c.networkAttempts ?? 0) > 1 || (c.attempts ?? 1) > 1);
  const blocked = executed.some(c => (c.blockedRetries ?? 0) > 0);
  checks.push({
    name: "no_paid_retry",
    status: executed.length === 0 ? "NOT_RUN" : violated ? "FAIL" : "PASS",
    ...(blocked ? { detail: "a retry was attempted and blocked before the network" } : {})
  });
  return checks;
}

const AGENT_ROLE = "operator-cache-acceptance";

export async function runCacheAcceptance(
  plan: CacheAcceptancePlan,
  deps: AcceptanceDeps
): Promise<CacheAcceptanceReport> {
  assertLiveReady(plan);
  const live = plan.live!;
  const capChf = plan.capChf!;

  // Credentials: names only. A provider without credential (in either tenant's
  // organization) is skipped with a warning; the rest still run.
  const [orgCredentials, otherCredentials] = await Promise.all([
    deps.listCredentialProviders(live.organizationId),
    live.otherOrganizationId === live.organizationId
      ? Promise.resolve(undefined)
      : deps.listCredentialProviders(live.otherOrganizationId)
  ]);
  const providers: ProviderPlan[] = plan.providers.map(p => {
    if (!p.runnable) return p;
    const hasCredential = orgCredentials.includes(p.provider) &&
      (otherCredentials === undefined || otherCredentials.includes(p.provider));
    return hasCredential
      ? p
      : { ...p, runnable: false, skipReason: "CREDENTIAL_MISSING: no stored credential for this provider" };
  });
  const runnable = providers.filter(p => p.runnable);
  if (runnable.length === 0) {
    throw new CacheAcceptanceError("NO_RUNNABLE_PROVIDERS", "every provider was skipped (no credential or no rates); nothing was called");
  }
  // Estimate AFTER the skips: only what will really run counts against the cap.
  const worstCaseChf = runnable.reduce((sum, p) => sum + p.worstCaseChf, 0);
  if (worstCaseChf > capChf) {
    throw new CacheAcceptanceError("ESTIMATE_EXCEEDS_CAP", "worst-case estimate exceeds the cap; nothing was called");
  }

  const segments = buildAcceptanceSegments();
  const reports: ProviderReport[] = [];
  let accumulatedChf = 0;
  let stoppedReason: string | undefined;
  let firstCall = true;

  for (const provider of providers) {
    if (!provider.runnable) {
      reports.push({
        provider: provider.provider, model: provider.model, status: "SKIPPED",
        skipReason: provider.skipReason, calls: [], checks: []
      });
      continue;
    }
    const calls: CallReport[] = [];
    let scenarioStopped = false;
    for (const planned of provider.calls) {
      const requestId = (deps.newRequestId ?? randomUUID)();
      const base: CallReport = {
        label: planned.label, tenant: planned.tenant, provider: provider.provider,
        model: provider.model, requestId, outcome: "NOT_RUN"
      };
      if (scenarioStopped || stoppedReason) {
        calls.push(base);
        continue;
      }
      // Hard stop BEFORE the call: the worst case of this call must still fit.
      if (accumulatedChf + planned.worstCaseChf > capChf) {
        stoppedReason = "CAP_WOULD_BE_EXCEEDED";
        calls.push(base);
        continue;
      }
      if (!firstCall && plan.pauseMs > 0) await deps.sleep(plan.pauseMs);
      firstCall = false;

      const tenantA = planned.tenant === "A";
      deps.observer.begin(provider.provider);
      let result: ModelGatewayResult | undefined;
      let failure: unknown;
      try {
        result = await deps.execute({
          requestId,
          organizationId: tenantA ? live.organizationId : live.otherOrganizationId,
          projectId: tenantA ? live.projectId : live.otherProjectId,
          taskId: tenantA ? live.taskId : live.otherTaskId,
          agentRole: AGENT_ROLE,
          segments,
          targets: [{ provider: provider.provider, model: provider.model }],
          maxOutputTokens: plan.maxOutputTokens,
          timeoutMs: 30_000,
          // No paid retry, ever.
          maxRetries: 0
        });
      } catch (error) {
        failure = error;
      }
      const observation = deps.observer.finish();
      const common = {
        networkAttempts: observation.networkAttempts,
        blockedRetries: observation.blockedRetries,
        ...(observation.usageShape !== undefined ? { usageShape: observation.usageShape } : {}),
        ...(observation.httpError ? { httpError: observation.httpError } : {})
      };

      if (!result) {
        // A failed call is a failed scenario: stop this provider, never retry.
        const code = (failure as { code?: unknown } | undefined)?.code;
        // The call may have been billed without a usable response: count the worst case.
        const assumed = observation.networkAttempts > 0 ? planned.worstCaseChf : 0;
        accumulatedChf += assumed;
        calls.push({
          ...base, ...common, outcome: "FAILED",
          errorCode: typeof code === "string" ? code : "UNKNOWN",
          assumedWorstCaseChf: assumed
        });
        scenarioStopped = true;
        if (accumulatedChf >= capChf) stoppedReason = "CAP_REACHED";
        continue;
      }

      let costWithoutCache: number | null = null;
      let savings: number | null = null;
      try {
        const estimate = deps.pricing.estimate(provider.provider, provider.model, result.usage);
        costWithoutCache = estimate.estimatedCostWithoutCacheChf;
        savings = estimate.estimatedCacheSavingsChf;
      } catch {
        // NOT_ESTIMABLE: reported as null below, the worst case is counted.
      }
      const cost = result.estimatedCostChf;
      const counted = cost ?? planned.worstCaseChf;
      accumulatedChf += counted;
      // Never repeats the paid call: only the database read can fail here.
      let cacheStatus: string | null;
      let cacheStatusSource: NonNullable<CallReport["cacheStatusSource"]>;
      if (!deps.lookupCacheStatus) {
        cacheStatus = observedCacheStatus(result.usage) ?? null;
        cacheStatusSource = "derived";
      } else {
        let read: string | null | undefined;
        try {
          read = await deps.lookupCacheStatus(tenantA ? live.organizationId : live.otherOrganizationId, requestId);
        } catch {
          read = undefined;
        }
        cacheStatus = read ?? null;
        cacheStatusSource = read === undefined ? "unavailable" : "database";
      }
      calls.push({
        ...base, ...common,
        outcome: "SUCCESS",
        attempts: result.attempts,
        tokens: tokensOf(result.usage),
        cacheStatus,
        cacheStatusSource,
        costChf: cost,
        costWithoutCacheChf: costWithoutCache,
        savingsChf: savings,
        ...(cost === null ? { assumedWorstCaseChf: planned.worstCaseChf } : {})
      });
      if (accumulatedChf >= capChf) stoppedReason = "CAP_REACHED";
    }
    reports.push({
      provider: provider.provider, model: provider.model, status: "RAN",
      calls, checks: evaluateChecks(provider.provider, calls)
    });
  }

  const ran = reports.filter(r => r.status === "RAN");
  const anyFail = ran.some(r => r.checks.some(c => c.status === "FAIL") || r.calls.some(c => c.outcome === "FAILED"));
  const incomplete = reports.some(r => r.status === "SKIPPED") ||
    ran.some(r => r.calls.some(c => c.outcome === "NOT_RUN")) ||
    ran.some(r => r.checks.some(c =>
      c.status === "INCONCLUSIVE" || (c.status === "NOT_RUN" && c.name !== "anthropic_error_format")));
  return {
    kind: "plt-052-cache-acceptance",
    mode: "live",
    capChf,
    worstCaseEstimateChf: worstCaseChf,
    worstCaseEstimateUsd: worstCaseChf / USD_TO_CHF_REFERENCE,
    fxUsdToChf: USD_TO_CHF_REFERENCE,
    accumulatedChf,
    ...(stoppedReason ? { stoppedReason } : {}),
    providers: reports,
    overall: anyFail ? "FAIL" : incomplete ? "INCOMPLETE" : "PASS"
  };
}

// ---------------------------------------------------------------------------
// Text output (never includes prompt content, keys or headers)
// ---------------------------------------------------------------------------

const chf = (n: number | null | undefined, digits = 6): string =>
  typeof n === "number" ? n.toFixed(digits) : "n/a";

export function formatPlanText(plan: CacheAcceptancePlan): string {
  const lines: string[] = [];
  lines.push("PLT-052 cache acceptance - DRY RUN (no network, no database, no spend)");
  lines.push(`Mode: ${plan.mode === "live" ? "consent variable present (a paid run would start with the live command)" : "dry-run (consent variable absent)"}`);
  lines.push(`Cap: ${plan.capChf === undefined ? "NOT SET / INVALID" : "CHF " + plan.capChf} (hard limit CHF ${CACHE_ACCEPTANCE_MAX_CAP_CHF})`);
  lines.push(`Synthetic prompt: ${plan.prompt.bytes} bytes, about ${plan.prompt.tokensLowerBound}-${plan.prompt.tokensUpperBound} tokens (minimum required ${MIN_PREFIX_TOKENS_ESTIMATE}); max output ${plan.maxOutputTokens} tokens; pause ${plan.pauseMs} ms between calls; maxRetries 0; no paid retry.`);
  lines.push("Scenario per provider: A-1 (expects cache write), A-2 (same prefix, expects read), B-1 (other tenant, expects NO read).");
  lines.push("Anthropic TTL: 1h project block, 5m task block (hybrid).");
  lines.push("");
  lines.push("Planned calls:");
  for (const p of plan.providers) {
    if (!p.runnable) {
      lines.push(`  - ${p.provider} (${p.model}): WOULD BE SKIPPED - ${p.skipReason}`);
      continue;
    }
    lines.push(`  - ${p.provider} (${p.model}): 3 calls, worst case CHF ${chf(p.worstCaseChf)}`);
    for (const c of p.calls) lines.push(`      ${c.label} tenant ${c.tenant}: worst case CHF ${chf(c.worstCaseChf)}`);
  }
  lines.push("");
  lines.push(`Worst-case estimate: CHF ${chf(plan.worstCaseChf)} = USD ${chf(plan.worstCaseUsd)} (reference rate 1 USD = ${USD_TO_CHF_REFERENCE} CHF; all prompt tokens billed at the highest write rate)`);
  if (plan.capChf !== undefined) {
    lines.push(`Estimate within cap: ${plan.worstCaseChf <= plan.capChf ? "yes" : "NO"}`);
  }
  lines.push("");
  if (plan.missingVariables.length > 0) {
    lines.push("Missing variables:");
    for (const name of plan.missingVariables) lines.push(`  - ${name}`);
  } else {
    lines.push("Missing variables: none");
  }
  if (plan.problems.length > 0) {
    lines.push("Problems:");
    for (const p of plan.problems) lines.push(`  - [${p.code}] ${p.message}`);
  }
  lines.push("Provider credentials are checked only in the paid run (names only, never printed).");
  return lines.join("\n");
}

export function formatReportText(report: CacheAcceptanceReport): string {
  const lines: string[] = [];
  lines.push(`PLT-052 cache acceptance - result: ${report.overall}`);
  lines.push(`Cap CHF ${report.capChf}; accumulated CHF ${chf(report.accumulatedChf)}; pre-call worst case CHF ${chf(report.worstCaseEstimateChf)} (USD ${chf(report.worstCaseEstimateUsd)} at ${report.fxUsdToChf})`);
  if (report.stoppedReason) lines.push(`Stopped: ${report.stoppedReason}`);
  for (const p of report.providers) {
    lines.push("");
    if (p.status === "SKIPPED") {
      lines.push(`${p.provider} (${p.model}): SKIPPED - ${p.skipReason}`);
      continue;
    }
    lines.push(`${p.provider} (${p.model})`);
    for (const c of p.calls) {
      if (c.outcome === "NOT_RUN") {
        lines.push(`  ${c.label}: not run`);
      } else if (c.outcome === "FAILED") {
        lines.push(`  ${c.label}: FAILED ${c.errorCode}${c.httpError ? ` (HTTP ${c.httpError.status})` : ""}; worst case counted CHF ${chf(c.assumedWorstCaseChf)}`);
      } else {
        const t = c.tokens!;
        lines.push(`  ${c.label}: ordinary ${t.ordinary} read ${t.cacheRead} write5m ${t.cacheWrite5m} write1h ${t.cacheWrite1h} write30m ${t.cacheWrite30m} write12h ${t.cacheWrite12h} out ${t.output} | cache_status ${c.cacheStatus ?? "n/a"} (source ${c.cacheStatusSource ?? "n/a"}) | cost CHF ${chf(c.costChf)} | saving CHF ${chf(c.savingsChf)}`);
      }
    }
    for (const check of p.checks) {
      lines.push(`  [${check.status}] ${check.name}${check.detail ? " - " + check.detail : ""}`);
    }
  }
  return lines.join("\n");
}
