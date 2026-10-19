import { describe, expect, it } from "vitest";
import { PricingCatalog } from "./pricing.js";
import { ModelGatewayError } from "./types.js";

const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

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
      "deepseek:free-test": { inputPerMillionChf: 0, outputPerMillionChf: 0 }
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
      "deepseek", "test", { inputTokens: 99_999_999, outputTokens: 0, totalTokens: 99_999_999 }
    )).toBe(99_999_999);
    expect(() => catalog.estimateChf(
      "deepseek", "test", { inputTokens: 100_000_000, outputTokens: 0, totalTokens: 100_000_000 }
    )).toThrow(/estimated provider cost exceeds accounting range/);
  });
});
