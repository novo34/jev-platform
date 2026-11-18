import { describe, expect, it } from "vitest";
import {
  cacheHitRate,
  mapAnthropicUsage,
  mapDeepSeekUsage,
  mapOpenAIUsage,
  observedCacheStatus,
  plainUsage
} from "./usage.js";
import { ModelGatewayError } from "./types.js";

const invalidCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelGatewayError);
    return (error as ModelGatewayError).code;
  }
  throw new Error("expected PROVIDER_RESPONSE_INVALID");
};

describe("PLT-052 normalized usage mapping", () => {
  it("maps Anthropic usage: input excludes cache, total is the documented sum", () => {
    const usage = mapAnthropicUsage({
      input_tokens: 1500,
      output_tokens: 800,
      cache_creation_input_tokens: 20_000,
      cache_read_input_tokens: 3_000,
      cache_creation: { ephemeral_5m_input_tokens: 5_000, ephemeral_1h_input_tokens: 15_000 }
    });
    expect(usage).toEqual({
      inputTokens: 1500, outputTokens: 800, cacheReadTokens: 3_000,
      cacheWriteTokens: 20_000, cacheWrite5mTokens: 5_000, cacheWrite1hTokens: 15_000,
      cacheWrite30mTokens: 0, cacheWrite12hTokens: 0,
      totalInputTokens: 24_500, totalTokens: 25_300
    });
  });

  it("keeps an Anthropic write without TTL breakdown unattributed", () => {
    const usage = mapAnthropicUsage({
      input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 100
    });
    expect(usage.cacheWriteTokens).toBe(100);
    expect(usage.cacheWrite5mTokens + usage.cacheWrite1hTokens).toBe(0);
    expect(mapAnthropicUsage({ input_tokens: 1, output_tokens: 1 }).cacheReadTokens).toBe(0);
  });

  it("rejects an Anthropic breakdown that does not add up", () => {
    expect(invalidCode(() => mapAnthropicUsage({
      input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 10,
      cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 4 }
    }))).toBe("PROVIDER_RESPONSE_INVALID");
  });

  it("maps OpenAI 5.6+: input_tokens includes cached and written tokens", () => {
    const usage = mapOpenAIUsage({
      input_tokens: 1_150, output_tokens: 16, total_tokens: 1_166,
      input_tokens_details: {
        cached_tokens: 1_000, cache_write_tokens: 100,
        cache_write_tokens_details: { ttl_30m_tokens: 100, ttl_12h_tokens: 0 }
      }
    });
    expect(usage.inputTokens).toBe(50);
    expect(usage.cacheReadTokens).toBe(1_000);
    expect(usage.cacheWriteTokens).toBe(100);
    expect(usage.cacheWrite30mTokens).toBe(100);
    expect(usage.cacheWrite12hTokens).toBe(0);
    expect(usage.totalInputTokens).toBe(1_150);
    expect(usage.totalTokens).toBe(1_166);
  });

  it("also accepts the OpenAI TTL split at the top level of usage", () => {
    const usage = mapOpenAIUsage({
      input_tokens: 100, output_tokens: 1,
      input_tokens_details: { cache_write_tokens: 40 },
      cache_write_tokens_details: { ttl_30m_tokens: 10, ttl_12h_tokens: 30 }
    });
    expect([usage.cacheWrite30mTokens, usage.cacheWrite12hTokens]).toEqual([10, 30]);
  });

  it("maps OpenAI before 5.6 (cached_tokens only) with writes at 0", () => {
    const usage = mapOpenAIUsage({
      input_tokens: 2_000, output_tokens: 5, input_tokens_details: { cached_tokens: 1_536 }
    });
    expect(usage).toMatchObject({
      inputTokens: 464, cacheReadTokens: 1_536, cacheWriteTokens: 0, totalInputTokens: 2_000
    });
    expect(mapOpenAIUsage({ input_tokens: 9, output_tokens: 1 }).inputTokens).toBe(9);
  });

  it("rejects inconsistent OpenAI cache counters", () => {
    expect(invalidCode(() => mapOpenAIUsage({
      input_tokens: 100, output_tokens: 1,
      input_tokens_details: { cached_tokens: 80, cache_write_tokens: 30 }
    }))).toBe("PROVIDER_RESPONSE_INVALID");
    expect(invalidCode(() => mapOpenAIUsage({
      input_tokens: 100, output_tokens: 1,
      input_tokens_details: { cache_write_tokens: 30 },
      cache_write_tokens_details: { ttl_30m_tokens: 10 }
    }))).toBe("PROVIDER_RESPONSE_INVALID");
  });

  it("maps DeepSeek hit/miss with no write charge", () => {
    const usage = mapDeepSeekUsage({
      prompt_tokens: 700, completion_tokens: 16, total_tokens: 716,
      prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 60
    });
    expect(usage).toMatchObject({
      inputTokens: 60, cacheReadTokens: 640, cacheWriteTokens: 0,
      totalInputTokens: 700, outputTokens: 16, totalTokens: 716
    });
  });

  it("maps DeepSeek without counters as all ordinary input and rejects a partial or wrong split", () => {
    expect(mapDeepSeekUsage({ prompt_tokens: 34, completion_tokens: 16 }))
      .toMatchObject({ inputTokens: 34, cacheReadTokens: 0, totalTokens: 50 });
    expect(invalidCode(() => mapDeepSeekUsage({
      prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 10
    }))).toBe("PROVIDER_RESPONSE_INVALID");
    expect(invalidCode(() => mapDeepSeekUsage({
      prompt_tokens: 10, completion_tokens: 1,
      prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 4
    }))).toBe("PROVIDER_RESPONSE_INVALID");
  });

  it.each([
    [() => mapAnthropicUsage(undefined)],
    [() => mapAnthropicUsage({ input_tokens: -1, output_tokens: 1 })],
    [() => mapAnthropicUsage({ input_tokens: 1.5, output_tokens: 1 })],
    [() => mapOpenAIUsage({ input_tokens: "1", output_tokens: 1 })],
    [() => mapOpenAIUsage({ input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: -1 } })],
    [() => mapDeepSeekUsage({ prompt_tokens: 1, completion_tokens: Number.MAX_SAFE_INTEGER + 2 })]
  ])("rejects invalid usage shapes", fn => {
    expect(invalidCode(fn)).toBe("PROVIDER_RESPONSE_INVALID");
  });

  it("derives only observable cache status and the hit rate formula", () => {
    expect(observedCacheStatus(plainUsage(10, 1))).toBeUndefined();
    expect(observedCacheStatus(mapDeepSeekUsage({
      prompt_tokens: 10, completion_tokens: 1,
      prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 0
    }))).toBe("HIT");
    expect(observedCacheStatus(mapDeepSeekUsage({
      prompt_tokens: 10, completion_tokens: 1,
      prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6
    }))).toBe("PARTIAL");
    const written = mapAnthropicUsage({
      input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0 }
    });
    expect(observedCacheStatus(written)).toBe("WRITE");
    // Design example: 20,000 read / (20,000 + 0 + 1,500) = 93.0 %
    const read = mapAnthropicUsage({
      input_tokens: 1_500, output_tokens: 800, cache_read_input_tokens: 20_000
    });
    expect(cacheHitRate(read)).toBeCloseTo(0.9302, 4);
    expect(cacheHitRate(plainUsage(0, 0))).toBe(0);
  });
  // Present-but-malformed detail objects must be rejected, never read as zero.
  // Explicit null is treated as absent: OpenAI and Anthropic serialize
  // unreported nested objects as null, and a null carries no cache split.
  const malformed: Array<[string, unknown]> = [
    ["array", []], ["string", "x"], ["number", 5], ["boolean", true]
  ];

  it("rejects malformed OpenAI input_tokens_details and accepts absent or null", () => {
    for (const [, bad] of malformed) {
      expect(invalidCode(() => mapOpenAIUsage(
        { input_tokens: 100, output_tokens: 1, input_tokens_details: bad }
      ))).toBe("PROVIDER_RESPONSE_INVALID");
    }
    for (const ok of [undefined, null]) {
      const usage = mapOpenAIUsage({ input_tokens: 100, output_tokens: 1, input_tokens_details: ok });
      expect(usage.inputTokens).toBe(100);
      expect(usage.cacheReadTokens).toBe(0);
    }
  });

  it("rejects malformed OpenAI TTL breakdowns in both locations", () => {
    for (const [, bad] of malformed) {
      expect(invalidCode(() => mapOpenAIUsage({
        input_tokens: 100, output_tokens: 1,
        input_tokens_details: { cache_write_tokens: 10, cache_write_tokens_details: bad }
      }))).toBe("PROVIDER_RESPONSE_INVALID");
      expect(invalidCode(() => mapOpenAIUsage({
        input_tokens: 100, output_tokens: 1,
        input_tokens_details: { cache_write_tokens: 10 },
        cache_write_tokens_details: bad
      }))).toBe("PROVIDER_RESPONSE_INVALID");
    }
    // A malformed top-level split is rejected even when the nested one is valid.
    expect(invalidCode(() => mapOpenAIUsage({
      input_tokens: 100, output_tokens: 1,
      input_tokens_details: {
        cache_write_tokens: 10,
        cache_write_tokens_details: { ttl_30m_tokens: 10 }
      },
      cache_write_tokens_details: []
    }))).toBe("PROVIDER_RESPONSE_INVALID");
    const ok = mapOpenAIUsage({
      input_tokens: 100, output_tokens: 1,
      input_tokens_details: { cache_write_tokens: 10, cache_write_tokens_details: null }
    });
    expect(ok.cacheWriteTokens).toBe(10);
  });

  it("rejects a malformed Anthropic cache_creation breakdown and accepts absent or null", () => {
    for (const [, bad] of malformed) {
      expect(invalidCode(() => mapAnthropicUsage({
        input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 10, cache_creation: bad
      }))).toBe("PROVIDER_RESPONSE_INVALID");
    }
    for (const ok of [undefined, null]) {
      const usage = mapAnthropicUsage({
        input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 10, cache_creation: ok
      });
      expect(usage.cacheWriteTokens).toBe(10);
      expect(usage.cacheWrite5mTokens).toBe(0);
    }
  });

  it("rejects malformed top-level usage and DeepSeek counters", () => {
    for (const bad of [[], "x", 5, null, undefined]) {
      expect(invalidCode(() => mapOpenAIUsage(bad))).toBe("PROVIDER_RESPONSE_INVALID");
      expect(invalidCode(() => mapAnthropicUsage(bad))).toBe("PROVIDER_RESPONSE_INVALID");
      expect(invalidCode(() => mapDeepSeekUsage(bad))).toBe("PROVIDER_RESPONSE_INVALID");
    }
    for (const bad of [{}, [], "5", -1]) {
      expect(invalidCode(() => mapDeepSeekUsage({
        prompt_tokens: 10, completion_tokens: 1,
        prompt_cache_hit_tokens: bad, prompt_cache_miss_tokens: 5
      }))).toBe("PROVIDER_RESPONSE_INVALID");
    }
  });
});
