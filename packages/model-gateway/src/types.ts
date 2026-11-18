import type { BuiltPrompt, PromptSegment, ToolDefinition } from "./prompt-builder.js";

// Every entry must be admitted by the provider CHECKs of the database
// (migrations 0020 and 0029); a test enforces it.
export const MODEL_PROVIDERS = ["openai", "deepseek", "qwen", "glm", "anthropic"] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface ProviderTarget {
  provider: ModelProvider;
  model: string;
}

export interface ModelGatewayRequest {
  requestId: string;
  organizationId: string;
  projectId: string;
  orderId?: string;
  taskId: string;
  agentRole: string;
  // Exactly one of `prompt` (plain text, never cached) or `segments` (canonical
  // segmented prompt built by buildPrompt, cacheable). `tools` only with `segments`.
  prompt?: string;
  segments?: PromptSegment[];
  tools?: ToolDefinition[];
  targets: ProviderTarget[];
  maxOutputTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

// Common usage model (PLT-052 design, point 2). `inputTokens` is always the
// ORDINARY input billed at the input rate; cache tokens are reported apart.
// totalInputTokens = inputTokens + cacheWriteTokens + cacheReadTokens and
// totalTokens = totalInputTokens + outputTokens. Cache fields are 0 when the
// provider does not report them. cacheWriteTokens is the provider total; the
// per-TTL fields (5m/1h Anthropic, 30m/12h OpenAI 5.6+) may add up to less
// than it when the provider does not attribute a TTL (then the cost is not
// estimable instead of guessed).
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheWrite30mTokens: number;
  cacheWrite12hTokens: number;
  totalInputTokens: number;
}

// Written: HIT/PARTIAL/WRITE (observed), DISABLED (switch off), ERROR
// (cache-attributable rejection retried without cache), UNSUPPORTED (switch on
// but the adapter or the input cannot carry cache marks) and, for explicit-mark
// adapters, MISS / BELOW_MINIMUM (marks sent, both cache counters 0).
export type CacheStatus =
  | "HIT" | "PARTIAL" | "MISS" | "WRITE" | "DISABLED"
  | "BELOW_MINIMUM" | "ERROR" | "UNSUPPORTED";

export interface AdapterResult {
  content: string;
  usage: NormalizedUsage;
  // Number of cache breakpoints actually sent (explicit-mark adapters only).
  // undefined = the adapter does not report it.
  cacheMarks?: number;
  finishReason?: string;
  rawMetadata?: Record<string, unknown>;
}

export interface ProviderHealth {
  ok: boolean;
  detail?: string;
  latencyMs?: number;
}

// Capability declared by each adapter (PLT-052 design point 2). Optional so
// adapters that do not declare it keep working: they are treated as "none".
export interface CacheSupport {
  mode: "explicit" | "automatic" | "none";
  ttls: string[];
  minPrefixTokens: (model: string) => number | undefined;
  billsWrite: boolean;
}

// Cache marking requested by the gateway for one provider call. Adapters that
// support explicit marks send them only when enabled is true.
export type CacheTtl = "5m" | "1h";

export interface AdapterCacheOptions {
  enabled: boolean;
  // Anthropic TTLs: 1h project block, 5m task/history (JEV_PROMPT_CACHE_*_TTL).
  projectTtl?: CacheTtl;
  taskTtl?: CacheTtl;
}

export interface AdapterExecuteInput {
  model: string;
  // Always the full prompt text (for a segmented request: the canonical bytes).
  prompt: string;
  // Present only for a segmented request; explicit-mark adapters build their
  // blocks from it.
  built?: BuiltPrompt;
  maxOutputTokens?: number;
  timeoutMs: number;
  cache?: AdapterCacheOptions;
}

export interface ProviderAdapter {
  readonly provider: ModelProvider;
  readonly cacheSupport?: CacheSupport;
  // Write TTLs the adapter would use for this prompt with marks on (pre-call pricing).
  plannedCacheTtls?(built: BuiltPrompt | undefined, cache: AdapterCacheOptions): CacheTtl[];
  execute(apiKey: string, input: AdapterExecuteInput): Promise<AdapterResult>;
  health(apiKey: string, timeoutMs?: number): Promise<ProviderHealth>;
}

export interface ModelGatewayResult extends AdapterResult {
  requestId: string;
  provider: ModelProvider;
  model: string;
  attempts: number;
  latencyMs: number;
  fallbackFrom?: ModelProvider;
  // null only when the response was unexpected and the cost is NOT_ESTIMABLE.
  estimatedCostChf: number | null;
  costNotEstimableReason?: string;
}

// All rates are CHF per million tokens. Cache fields are optional: a missing
// applicable rate blocks the call (PRICING_REQUIRED) or, for an unexpected
// response, makes the cost NOT_ESTIMABLE. They are never replaced by the input
// rate unless cacheWriteBilledAs is explicitly "input" (writes only).
export interface PriceRate {
  inputPerMillionChf: number;
  outputPerMillionChf: number;
  cacheReadPerMillionChf?: number;
  cacheWrite5mPerMillionChf?: number;
  cacheWrite1hPerMillionChf?: number;
  cacheWrite30mPerMillionChf?: number;
  cacheWrite12hPerMillionChf?: number;
  cacheWriteBilledAs?: "input";
  // Pricing tier ceiling (e.g. Haiku 5.5 rate for prompts <= 100000 tokens).
  maxPromptTokens?: number;
}

export interface ProviderCredentialMetadata {
  provider: ModelProvider;
  configured: true;
  lastFour: string;
  updatedAt: string;
}

export class ModelGatewayError extends Error {
  constructor(
    public readonly code:
      | "INVALID_REQUEST"
      | "PROVIDER_NOT_REGISTERED"
      | "PROVIDER_CREDENTIAL_MISSING"
      | "SECRET_STORE_UNAVAILABLE"
      | "PROVIDER_HTTP_ERROR"
      | "PROVIDER_TIMEOUT"
      | "PROVIDER_RESPONSE_INVALID"
      | "PRICING_REQUIRED"
      | "PROMPT_TOO_LARGE_FOR_TIER"
      | "CACHE_CONFIG_INVALID"
      | "NOT_ESTIMABLE"
      | "ALL_PROVIDERS_FAILED"
      | "PROVIDER_CIRCUIT_OPEN",
    message: string = code,
    public readonly retryable: boolean = false,
    public readonly status?: number
  ) {
    super(message);
    this.name = "ModelGatewayError";
  }
}
