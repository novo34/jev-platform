import { describe, expect, it } from "vitest";
import { PricingCatalog } from "./pricing.js";
import { ModelGatewayError } from "./types.js";
import { mapAnthropicUsage, mapOpenAIUsage, plainUsage } from "./usage.js";

const usage = plainUsage(100, 50);

describe("PLT-009 pricing guardrails", () => {
  it("rejects a paid call without matching pricing", () => {
    const catalog = new PricingCatalog();
    expect(catalog.has("openai", "gpt-test")).toBe(false);
    try {
      catalog.estimateChf("openai", "gpt-test", usage);
      throw new Error("Expected pricing rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelGatewayError);
      expect((error as ModelGatewayError).code).toBe("PRICING_REQUIRED");
      expect((error as Error).message).toMatch(/pricing is required before paid provider call/);
    }
  });

  it("accepts an explicit zero-rate model without selecting another provider", () => {
    const catalog = new PricingCatalog({
      "deepseek:free-test": { inputPerMillionChf: 0, outputPerMillionChf: 0, cacheReadPerMillionChf: 0 }
    });
    expect(catalog.has("deepseek", "free-test")).toBe(true);
    expect(catalog.estimateChf("deepseek", "free-test", usage)).toBe(0);
    expect(catalog.has("openai", "free-test")).toBe(false);
  });

  it("uses exact model rates before provider wildcard rates", () => {
    const catalog = new PricingCatalog({
      "openai:*": { inputPerMillionChf: 100, outputPerMillionChf: 100 },
      "openai:gpt-test": { inputPerMillionChf: 2, outputPerMillionChf: 4 }
    });
    expect(catalog.estimateChf("openai", "gpt-test", usage)).toBeCloseTo(0.0004, 12);
    expect(catalog.estimateChf("openai", "other", usage)).toBeCloseTo(0.015, 12);
    expect(catalog.has("deepseek", "gpt-test")).toBe(false);
  });

  it.each([
    '{"openai:gpt-test":{"inputPerMillionChf":-1,"outputPerMillionChf":1}}',
    '{"openai:gpt-test":{"inputPerMillionChf":1e309,"outputPerMillionChf":1}}',
    '{"openai:gpt-test":{"inputPerMillionChf":1000000.0000000001,"outputPerMillionChf":1}}',
    '{"openai:gpt-test":{"inputPerMillionChf":1}}',
    '[]',
    '{not valid json}'
  ])("rejects invalid and unsafe pricing configuration", json => {
    expect(() => PricingCatalog.fromJson(json)).toThrow();
  });

  it("accepts the exact price cap and rejects a fractional amount above it", () => {
    expect(() => new PricingCatalog({
      "openai:test": { inputPerMillionChf: 1_000_000, outputPerMillionChf: 0 }
    })).not.toThrow();
    expect(() => new PricingCatalog({
      "openai:test": { inputPerMillionChf: 1_000_000.0000000001, outputPerMillionChf: 0 }
    })).toThrow();
  });

  it("rejects cost estimates outside accounting range", () => {
    const catalog = new PricingCatalog({
      "deepseek:test": { inputPerMillionChf: 1_000_000, outputPerMillionChf: 1_000_000 }
    });
    expect(catalog.estimateChf(
      "deepseek", "test", plainUsage(99_999_999, 0)
    )).toBe(99_999_999);
    try {
      catalog.estimateChf(
        "deepseek", "test", plainUsage(100_000_000, 0)
      );
      expect.fail("Expected accounting range rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelGatewayError);
      expect((error as ModelGatewayError).code).toBe("PROVIDER_RESPONSE_INVALID");
      expect((error as Error).message).toMatch(/estimated provider cost exceeds accounting range/);
    }
  });
});

describe("PLT-052 cache pricing", () => {
  const sonnet = {
    inputPerMillionChf: 2, outputPerMillionChf: 10,
    cacheReadPerMillionChf: 0.1,
    cacheWrite5mPerMillionChf: 2.5, cacheWrite1hPerMillionChf: 4
  };
  const catalog = new PricingCatalog({
    "anthropic:claude-sonnet-5-5": sonnet,
    "anthropic:claude-haiku-5-5": { ...sonnet, maxPromptTokens: 100_000 }
  });

  it("reproduces the design example arithmetic (read, 5m write, no cache)", () => {
    const read = catalog.estimate("anthropic", "claude-sonnet-5-5", mapAnthropicUsage({
      input_tokens: 1_500, output_tokens: 800, cache_read_input_tokens: 20_000
    }));
    expect(read.estimatedCostChf).toBeCloseTo(0.013, 9);
    expect(read.estimatedCostWithoutCacheChf).toBeCloseTo(0.051, 9);
    expect(read.estimatedCacheSavingsChf).toBeCloseTo(0.038, 9);
    const write = catalog.estimate("anthropic", "claude-sonnet-5-5", mapAnthropicUsage({
      input_tokens: 1_500, output_tokens: 800, cache_creation_input_tokens: 20_000,
      cache_creation: { ephemeral_5m_input_tokens: 20_000, ephemeral_1h_input_tokens: 0 }
    }));
    expect(write.estimatedCostChf).toBeCloseTo(0.061, 9);
    expect(write.estimatedCacheSavingsChf).toBeCloseTo(-0.010, 9);
  });

  it("prices 1h writes with their own TTL rate", () => {
    const usage = mapAnthropicUsage({
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 }
    });
    expect(catalog.estimateChf("anthropic", "claude-sonnet-5-5", usage)).toBeCloseTo(4, 9);
  });

  it("requires read for OpenAI and DeepSeek even with the cache off", () => {
    const noRead = new PricingCatalog({
      "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 },
      "deepseek:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 },
      "qwen:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 }
    });
    expect(noRead.missingRates("openai", "m")).toEqual(["cacheReadPerMillionChf"]);
    expect(noRead.missingRates("deepseek", "m")).toEqual(["cacheReadPerMillionChf"]);
    expect(noRead.has("openai", "m")).toBe(false);
    expect(noRead.missingRates("qwen", "m")).toEqual([]);
    expect(noRead.missingRates("glm", "m")).toEqual(["inputPerMillionChf", "outputPerMillionChf"]);
  });

  it("reports every missing applicable cache rate when the cache is used", () => {
    const partial = new PricingCatalog({
      "anthropic:a": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0.1 }
    });
    expect(partial.missingRates("anthropic", "a")).toEqual([]);
    expect(partial.missingRates("anthropic", "a", { cacheEnabled: false, cacheWriteTtls: ["1h"] })).toEqual([]);
    expect(partial.missingRates("anthropic", "a", { cacheEnabled: true, cacheWriteTtls: ["5m", "1h"] }))
      .toEqual(["cacheWrite5mPerMillionChf", "cacheWrite1hPerMillionChf"]);
    expect(new PricingCatalog().missingRates("anthropic", "a", { cacheEnabled: true, cacheWriteTtls: ["5m"] }))
      .toEqual(["inputPerMillionChf", "outputPerMillionChf", "cacheReadPerMillionChf", "cacheWrite5mPerMillionChf"]);
  });

  it("is NOT_ESTIMABLE (never the input rate) for unexpected cache tokens", () => {
    const noCache = new PricingCatalog({
      "openai:m": { inputPerMillionChf: 1, outputPerMillionChf: 1 }
    });
    const code = (fn: () => unknown) => {
      try { fn(); } catch (error) { return (error as ModelGatewayError).code; }
      return "none";
    };
    expect(code(() => noCache.estimate("openai", "m", mapOpenAIUsage({
      input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 5 }
    })))).toBe("NOT_ESTIMABLE");
    expect(code(() => noCache.estimate("openai", "m", mapOpenAIUsage({
      input_tokens: 10, output_tokens: 1,
      input_tokens_details: { cache_write_tokens: 5 },
      cache_write_tokens_details: { ttl_30m_tokens: 5 }
    })))).toBe("NOT_ESTIMABLE");
    // Write with no TTL attribution and no explicit billing declaration.
    expect(code(() => catalog.estimate("anthropic", "claude-sonnet-5-5", mapAnthropicUsage({
      input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 5
    })))).toBe("NOT_ESTIMABLE");
  });

  it("bills writes at the input rate only when cacheWriteBilledAs is explicit", () => {
    const billed = new PricingCatalog({
      "openai:old": {
        inputPerMillionChf: 2, outputPerMillionChf: 0, cacheReadPerMillionChf: 0.5,
        cacheWriteBilledAs: "input"
      }
    });
    const usage = mapOpenAIUsage({
      input_tokens: 1_000_000, output_tokens: 0,
      input_tokens_details: { cached_tokens: 400_000, cache_write_tokens: 100_000 }
    });
    // 500k ordinary * 2 + 100k write at input * 2 + 400k read * 0.5, per million
    expect(billed.estimateChf("openai", "old", usage)).toBeCloseTo(1 + 0.2 + 0.2, 9);
  });

  it("makes a response above the Haiku tier ceiling NOT_ESTIMABLE and flags large prompts before the call", () => {
    expect(catalog.exceedsTier("anthropic", "claude-haiku-5-5", 100_000)).toBe(false);
    expect(catalog.exceedsTier("anthropic", "claude-haiku-5-5", 100_001)).toBe(true);
    expect(catalog.exceedsTier("anthropic", "claude-sonnet-5-5", 10_000_000)).toBe(false);
    expect(() => catalog.estimate("anthropic", "claude-haiku-5-5", plainUsage(100_001, 1)))
      .toThrowError(/pricing tier/);
    expect(catalog.estimateChf("anthropic", "claude-haiku-5-5", plainUsage(100_000, 0))).toBeCloseTo(0.2, 9);
  });

  it.each([
    '{"a:m":{"inputPerMillionChf":1,"outputPerMillionChf":1,"cacheReadPerMillionChf":-1}}',
    '{"a:m":{"inputPerMillionChf":1,"outputPerMillionChf":1,"cacheWrite1hPerMillionChf":1000001}}',
    '{"a:m":{"inputPerMillionChf":1,"outputPerMillionChf":1,"cacheWrite5mPerMillionChf":"1"}}',
    '{"a:m":{"inputPerMillionChf":1,"outputPerMillionChf":1,"cacheWrite30mPerMillionChf":null}}',
    '{"a:m":{"inputPerMillionChf":1,"outputPerMillionChf":1,"cacheWriteBilledAs":"output"}}',
    '{"a:m":{"inputPerMillionChf":1,"outputPerMillionChf":1,"maxPromptTokens":0}}',
    '{"a:m":{"inputPerMillionChf":1,"outputPerMillionChf":1,"maxPromptTokens":1.5}}'
  ])("rejects invalid cache pricing fields", json => {
    expect(() => PricingCatalog.fromJson(json)).toThrow(ModelGatewayError);
  });

  it("accepts every cache field at the exact cap", () => {
    expect(() => PricingCatalog.fromJson(JSON.stringify({
      "openai:m": {
        inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 1_000_000,
        cacheWrite5mPerMillionChf: 1_000_000, cacheWrite1hPerMillionChf: 1_000_000,
        cacheWrite30mPerMillionChf: 1_000_000, cacheWrite12hPerMillionChf: 1_000_000,
        cacheWriteBilledAs: "input", maxPromptTokens: 100_000
      }
    }))).not.toThrow();
  });
});
