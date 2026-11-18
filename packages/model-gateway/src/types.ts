export const MODEL_PROVIDERS = ["openai", "deepseek", "qwen", "glm"] as const;

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
  prompt: string;
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

// Only the cache state that can be observed from a response. DISABLED, MISS,
// BELOW_MINIMUM and ERROR need the cache switch and the Anthropic adapter
// (later PRs of PLT-052) and are never produced here.
export type CacheStatus =
  | "HIT" | "PARTIAL" | "MISS" | "WRITE" | "DISABLED"
  | "BELOW_MINIMUM" | "ERROR" | "UNSUPPORTED";

export interface AdapterResult {
  content: string;
  usage: NormalizedUsage;
  finishReason?: string;
  rawMetadata?: Record<string, unknown>;
}

export interface ProviderHealth {
  ok: boolean;
  detail?: string;
  latencyMs?: number;
}

export interface ProviderAdapter {
  readonly provider: ModelProvider;
  execute(apiKey: string, input: {
    model: string;
    prompt: string;
    maxOutputTokens?: number;
    timeoutMs: number;
  }): Promise<AdapterResult>;
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
