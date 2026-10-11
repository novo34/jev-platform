import {
  ModelGatewayError,
  type ModelProvider,
  type NormalizedUsage,
  type PriceRate
} from "./types.js";

// Deliberately conservative: database accounting columns are NUMERIC(14,6).
// A misconfigured astronomical price must be rejected before a paid call.
const MAX_RATE_CHF_PER_MILLION = 1_000_000;
const MAX_RECORDED_COST_CHF = 99_999_999;

function validRate(value: unknown): value is PriceRate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rate = value as Record<string, unknown>;
  return ["inputPerMillionChf", "outputPerMillionChf"].every(
    key => typeof rate[key] === "number" && Number.isFinite(rate[key]) &&
      rate[key] >= 0 && rate[key] <= MAX_RATE_CHF_PER_MILLION
  );
}

export class PricingCatalog {
  private readonly rates: Record<string, PriceRate>;

  constructor(rates: Record<string, PriceRate> = {}) {
    if (typeof rates !== "object" || rates === null || Array.isArray(rates)) {
      throw new ModelGatewayError("INVALID_REQUEST", "pricing catalog must be an object");
    }
    for (const [key, value] of Object.entries(rates)) {
      if (!validRate(value)) {
        throw new ModelGatewayError("INVALID_REQUEST", `invalid pricing rate: ${key}`);
      }
    }
    this.rates = { ...rates };
  }

  static fromJson(value: string | undefined): PricingCatalog {
    if (!value) return new PricingCatalog();
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ModelGatewayError("INVALID_REQUEST", "pricing catalog is not valid JSON");
    }
    return new PricingCatalog(parsed as Record<string, PriceRate>);
  }

  estimateChf(provider: ModelProvider, model: string, usage: NormalizedUsage): number {
    const rate = this.rates[`${provider}:${model}`] ?? this.rates[`${provider}:*`];
    if (!rate) {
      throw new ModelGatewayError(
        "PRICING_REQUIRED",
        `pricing is required before paid provider call: ${provider}/${model}`
      );
    }
    const estimatedChf =
      (usage.inputTokens / 1_000_000) * rate.inputPerMillionChf +
      (usage.outputTokens / 1_000_000) * rate.outputPerMillionChf;
    if (!Number.isFinite(estimatedChf) || estimatedChf < 0 ||
        estimatedChf > MAX_RECORDED_COST_CHF) {
      throw new ModelGatewayError(
        "PROVIDER_RESPONSE_INVALID", "estimated provider cost exceeds accounting range"
      );
    }
    return estimatedChf;
  }

  has(provider: ModelProvider, model: string): boolean {
    return Boolean(this.rates[`${provider}:${model}`] ?? this.rates[`${provider}:*`]);
  }
}
