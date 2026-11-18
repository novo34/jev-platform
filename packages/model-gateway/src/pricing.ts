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

const OPTIONAL_RATE_KEYS = [
  "cacheReadPerMillionChf",
  "cacheWrite5mPerMillionChf",
  "cacheWrite1hPerMillionChf",
  "cacheWrite30mPerMillionChf",
  "cacheWrite12hPerMillionChf"
] as const;
const MAX_TIER_PROMPT_TOKENS = 100_000_000;

export type CacheWriteTtl = "5m" | "1h" | "30m" | "12h";

const WRITE_RATE_KEY: Record<CacheWriteTtl, keyof PriceRate> = {
  "5m": "cacheWrite5mPerMillionChf",
  "1h": "cacheWrite1hPerMillionChf",
  "30m": "cacheWrite30mPerMillionChf",
  "12h": "cacheWrite12hPerMillionChf"
};

function validRate(value: unknown): value is PriceRate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rate = value as Record<string, unknown>;
  const validAmount = (amount: unknown) =>
    typeof amount === "number" && Number.isFinite(amount) &&
    amount >= 0 && amount <= MAX_RATE_CHF_PER_MILLION;
  if (!["inputPerMillionChf", "outputPerMillionChf"].every(key => validAmount(rate[key]))) {
    return false;
  }
  // Optional cache rates share the same bounds; present-but-invalid is rejected.
  if (!OPTIONAL_RATE_KEYS.every(key => rate[key] === undefined || validAmount(rate[key]))) {
    return false;
  }
  if (rate.cacheWriteBilledAs !== undefined && rate.cacheWriteBilledAs !== "input") return false;
  if (rate.maxPromptTokens !== undefined &&
      (!Number.isSafeInteger(rate.maxPromptTokens) || (rate.maxPromptTokens as number) < 1 ||
        (rate.maxPromptTokens as number) > MAX_TIER_PROMPT_TOKENS)) {
    return false;
  }
  return true;
}

// Providers that cache automatically even when JEV does not ask for it: their
// cache-read rate is always required before a paid call (design point 3).
const AUTOMATIC_CACHE_PROVIDERS: ReadonlySet<string> = new Set(["openai", "deepseek"]);

export interface PricingRequirements {
  // Explicit JEV cache use (Anthropic-style): read plus the write rate of every TTL used.
  cacheEnabled?: boolean;
  cacheWriteTtls?: CacheWriteTtl[];
}

export interface CostEstimate {
  estimatedCostChf: number;
  estimatedCostWithoutCacheChf: number;
  estimatedCacheSavingsChf: number;
}

function notEstimable(reason: string): ModelGatewayError {
  return new ModelGatewayError("NOT_ESTIMABLE", `cost is not estimable: ${reason}`);
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

  private rateFor(provider: string, model: string): PriceRate | undefined {
    return this.rates[`${provider}:${model}`] ?? this.rates[`${provider}:*`];
  }

  // Names of the applicable rates that are not configured. Empty = the call
  // may proceed. Evaluated BEFORE any provider call.
  missingRates(
    provider: ModelProvider | string,
    model: string,
    requirements: PricingRequirements = {}
  ): string[] {
    const rate = this.rateFor(provider, model);
    const missing: string[] = [];
    if (!rate) missing.push("inputPerMillionChf", "outputPerMillionChf");
    const needsRead = AUTOMATIC_CACHE_PROVIDERS.has(provider) || requirements.cacheEnabled === true;
    if (needsRead && rate?.cacheReadPerMillionChf === undefined) {
      missing.push("cacheReadPerMillionChf");
    }
    for (const ttl of requirements.cacheEnabled ? requirements.cacheWriteTtls ?? [] : []) {
      const key = WRITE_RATE_KEY[ttl];
      if (rate?.[key] === undefined && rate?.cacheWriteBilledAs !== "input") {
        missing.push(key as string);
      }
    }
    return missing;
  }

  has(provider: ModelProvider | string, model: string): boolean {
    return this.missingRates(provider, model).length === 0;
  }

  // Conservative pre-call tier check: true when the configured rate has a
  // prompt ceiling and the estimated prompt exceeds it.
  exceedsTier(provider: string, model: string, estimatedPromptTokens: number): boolean {
    const ceiling = this.rateFor(provider, model)?.maxPromptTokens;
    return ceiling !== undefined && estimatedPromptTokens > ceiling;
  }

  estimate(provider: ModelProvider | string, model: string, usage: NormalizedUsage): CostEstimate {
    const rate = this.rateFor(provider, model);
    if (!rate) {
      throw new ModelGatewayError(
        "PRICING_REQUIRED",
        `pricing is required before paid provider call: ${provider}/${model}`
      );
    }
    // Unexpected responses are NOT_ESTIMABLE; a rate is never substituted
    // except the explicit cacheWriteBilledAs "input" for writes.
    if (rate.maxPromptTokens !== undefined && usage.totalInputTokens > rate.maxPromptTokens) {
      throw notEstimable(`prompt of ${usage.totalInputTokens} tokens exceeds the ${rate.maxPromptTokens}-token pricing tier`);
    }
    let cacheReadChf = 0;
    if (usage.cacheReadTokens > 0) {
      if (rate.cacheReadPerMillionChf === undefined) {
        throw notEstimable("cache read tokens reported without a cache read rate");
      }
      cacheReadChf = (usage.cacheReadTokens / 1_000_000) * rate.cacheReadPerMillionChf;
    }
    const writeRate = (key: keyof PriceRate): number | undefined => {
      const configured = rate[key] as number | undefined;
      if (configured !== undefined) return configured;
      return rate.cacheWriteBilledAs === "input" ? rate.inputPerMillionChf : undefined;
    };
    const writes: Array<[CacheWriteTtl, number]> = [
      ["5m", usage.cacheWrite5mTokens], ["1h", usage.cacheWrite1hTokens],
      ["30m", usage.cacheWrite30mTokens], ["12h", usage.cacheWrite12hTokens]
    ];
    let cacheWriteChf = 0;
    let attributed = 0;
    for (const [ttl, tokens] of writes) {
      attributed += tokens;
      if (tokens === 0) continue;
      const perMillion = writeRate(WRITE_RATE_KEY[ttl]);
      if (perMillion === undefined) {
        throw notEstimable(`cache write tokens (${ttl}) reported without a ${ttl} write rate`);
      }
      cacheWriteChf += (tokens / 1_000_000) * perMillion;
    }
    const unattributed = usage.cacheWriteTokens - attributed;
    if (unattributed > 0) {
      // Provider reported writes without a TTL: only an explicit "input"
      // billing declaration allows pricing them.
      if (rate.cacheWriteBilledAs !== "input") {
        throw notEstimable("cache write tokens reported without a TTL attribution or write rate");
      }
      cacheWriteChf += (unattributed / 1_000_000) * rate.inputPerMillionChf;
    }
    const outputChf = (usage.outputTokens / 1_000_000) * rate.outputPerMillionChf;
    const estimatedChf =
      (usage.inputTokens / 1_000_000) * rate.inputPerMillionChf +
      cacheReadChf + cacheWriteChf + outputChf;
    // Everything at the input rate, as if no cache existed (savings may be negative).
    const withoutCacheChf =
      (usage.totalInputTokens / 1_000_000) * rate.inputPerMillionChf + outputChf;
    for (const amount of [estimatedChf, withoutCacheChf]) {
      if (!Number.isFinite(amount) || amount < 0 || amount > MAX_RECORDED_COST_CHF) {
        throw new ModelGatewayError(
          "PROVIDER_RESPONSE_INVALID", "estimated provider cost exceeds accounting range"
        );
      }
    }
    return {
      estimatedCostChf: estimatedChf,
      estimatedCostWithoutCacheChf: withoutCacheChf,
      estimatedCacheSavingsChf: withoutCacheChf - estimatedChf
    };
  }

  estimateChf(provider: ModelProvider | string, model: string, usage: NormalizedUsage): number {
    return this.estimate(provider, model, usage).estimatedCostChf;
  }
}
