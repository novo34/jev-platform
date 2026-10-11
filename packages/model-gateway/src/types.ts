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

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

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
  estimatedCostChf: number;
}

export interface PriceRate {
  inputPerMillionChf: number;
  outputPerMillionChf: number;
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
