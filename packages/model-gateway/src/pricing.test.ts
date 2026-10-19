import { describe, expect, it } from "vitest";
import { PricingCatalog } from "./pricing.js";

const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

describe("PLT-009 pricing guardrails", () => {
  it("rejects a paid call without matching pricing", () => {
    const catalog = new PricingCatalog();
    expect(catalog.has("openai", "gpt-test")).toBe(false);
    expect(() => catalog.estimateChf("openai", "gpt-test", usage)).toThrow(
      expect.objectContaining({ code: "PRICING_REQUIRED" })
    );
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
    '{"openai:gpt-test":{"inputPerMillionChf":1000001,"outputPerMillionChf":1}}',
    '{"openai:gpt-test":{"inputPerMillionChf":1}}',
    '[]',
    '{not valid json}'
  ])("rejects invalid and unsafe pricing configuration", json => {
    expect(() => PricingCatalog.fromJson(json)).toThrow();
  });

  it("rejects cost estimates outside accounting range", () => {
    const catalog = new PricingCatalog({
      "deepseek:test": { inputPerMillionChf: 1_000_000, outputPerMillionChf: 1_000_000 }
    });
    expect(() => catalog.estimateChf(
      "deepseek", "test", { inputTokens: 100_000_000, outputTokens: 0, totalTokens: 100_000_000 }
    )).toThrow(expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID" }));
  });
});
