import {
  ModelGatewayError,
  type ModelProvider,
  type NormalizedUsage,
  type PriceRate
} from "./types.js";

export class PricingCatalog {
  constructor(private readonly rates: Record<string, PriceRate> = {}) {}

  static fromJson(value: string | undefined): PricingCatalog {
    if (!value) return new PricingCatalog();
    return new PricingCatalog(JSON.parse(value) as Record<string, PriceRate>);
  }

  estimateChf(
    provider: ModelProvider,
    model: string,
    usage: NormalizedUsage
  ): number {
    const rate = this.rates[`${provider}:${model}`] ?? this.rates[`${provider}:*`];
    if (!rate) {
      throw new ModelGatewayError(
        "PRICING_REQUIRED",
        `pricing is required before paid provider call: ${provider}/${model}`
      );
    }
    return (
      (usage.inputTokens / 1_000_000) * rate.inputPerMillionChf +
      (usage.outputTokens / 1_000_000) * rate.outputPerMillionChf
    );
  }

  has(provider: ModelProvider, model: string): boolean {
    return Boolean(
      this.rates[`${provider}:${model}`] ?? this.rates[`${provider}:*`]
    );
  }
}
