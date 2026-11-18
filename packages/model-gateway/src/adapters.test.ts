import { describe, expect, it } from "vitest";
import { DeepSeekAdapter, OpenAIAdapter, parseRetryAfterMs } from "./adapters.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("direct provider output cap validation", () => {
  it("rejects invalid maxOutputTokens without sending HTTP requests", async () => {
    let requests = 0;
    const http = async () => {
      requests += 1;
      throw new Error("must never fetch");
    };
    for (const adapter of [
      new OpenAIAdapter(http, "https://example.test"),
      new DeepSeekAdapter(http, "https://example.test")
    ]) {
      for (const maxOutputTokens of [0, -1, NaN, Infinity, 1.25, 32769]) {
        await expect(adapter.execute("test-key", {
          model: "test", prompt: "Safe", timeoutMs: 1000, maxOutputTokens
        })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      }
    }
    expect(requests).toBe(0);
  });
});

describe("HTTP Retry-After metadata", () => {
  it("parses seconds and HTTP dates and ignores invalid headers", () => {
    const now = Date.parse("2026-10-11T10:00:00.000Z");
    expect(parseRetryAfterMs("2", now)).toBe(2000);
    expect(parseRetryAfterMs("Sun, 11 Oct 2026 10:00:03 GMT", now)).toBe(3000);
    expect(parseRetryAfterMs("Sun, 11 Oct 2026 09:59:59 GMT", now)).toBe(0);
    expect(parseRetryAfterMs("nonsense", now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
    expect(parseRetryAfterMs("9999999999999999999999999999999999999999999999", now))
      .toBeGreaterThan(5000);
  });

  it("carries the provider's 429 delay into the typed error", async () => {
    const adapter = new OpenAIAdapter(
      async () => new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429, headers: { "Retry-After": "1" }
      }),
      "https://example.test"
    );
    await expect(adapter.execute("sk-test", {
      model: "test", prompt: "hello", timeoutMs: 1000
    })).rejects.toMatchObject({
      code: "PROVIDER_HTTP_ERROR", status: 429,
      retryable: true, retryAfterMs: 1000
    });
  });
});

describe("provider response body timeout", () => {
  it("retains 429 Retry-After when the response body stalls", async () => {
    const adapter = new OpenAIAdapter(
      async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          }, { once: true });
        }
      }), { status: 429, headers: { "Retry-After": "60" } }),
      "https://example.test"
    );
    await expect(adapter.execute("sk-test", {
      model: "test", prompt: "hello", timeoutMs: 25
    })).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT", status: 429,
      retryable: true, retryAfterMs: 60_000
    });
  });

  it("aborts a stalled OpenAI response body after headers arrive", async () => {
    let aborted = false;
    const adapter = new OpenAIAdapter(
      async (_url, init) => {
        const signal = init?.signal;
        return new Response(new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () => {
              aborted = true;
              controller.error(new DOMException("aborted", "AbortError"));
            }, { once: true });
          }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
      "https://example.test"
    );
    await expect(adapter.execute("sk-test", {
      model: "test", prompt: "hello", timeoutMs: 25
    })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", retryable: true });
    expect(aborted).toBe(true);
  });
});

describe("OpenAI response privacy", () => {
  it("explicitly disables server-side response storage", async () => {
    let submitted: Record<string, unknown> | undefined;
    const adapter = new OpenAIAdapter(
      async (_url, init) => {
        submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          output_text: "ok",
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
        });
      },
      "https://example.test"
    );
    await adapter.execute("sk-test", {
      model: "test", prompt: "private code", timeoutMs: 1000
    });
    expect(submitted).toMatchObject({ store: false, input: "private code" });
  });
});

describe("OpenAI multi-part output", () => {
  it("concatenates every output_text part across response items", async () => {
    const adapter = new OpenAIAdapter(
      async () => jsonResponse({
        id: "resp_multi",
        status: "completed",
        output: [
          { content: [{ type: "output_text", text: "Hello" }, { type: "refusal", refusal: "ignore" }] },
          { content: [{ type: "output_text", text: " world" }] }
        ],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }
      }),
      "https://example.test"
    );
    const result = await adapter.execute("sk-test", {
      model: "test", prompt: "hello", timeoutMs: 1000
    });
    expect(result.content).toBe("Hello world");
  });
});

describe("provider adapter usage validation", () => {
  it("rejects coerced or fractional token counts from both providers", async () => {
    const badValues: unknown[] = [null, "3", true, 1.5, -1, Number.MAX_SAFE_INTEGER + 1];
    for (const bad of badValues) {
      const openai = new OpenAIAdapter(
        async () => jsonResponse({
          output_text: "ok",
          usage: { input_tokens: bad, output_tokens: 2, total_tokens: 5 }
        }),
        "https://example.test"
      );
      await expect(openai.execute("sk-test", {
        model: "test", prompt: "hello", timeoutMs: 1000
      })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });

      const deepseek = new DeepSeekAdapter(
        async () => jsonResponse({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 2, completion_tokens: bad, total_tokens: 5 }
        }),
        "https://example.test"
      );
      await expect(deepseek.execute("ds-test", {
        model: "test", prompt: "hello", timeoutMs: 1000
      })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
    }
  });

  it("rejects OpenAI responses that omit usage", async () => {
    const adapter = new OpenAIAdapter(
      async () =>
        jsonResponse({
          id: "resp_1",
          status: "completed",
          output_text: "ok"
        }),
      "https://example.test"
    );

    await expect(
      adapter.execute("sk-test", {
        model: "test",
        prompt: "hello",
        timeoutMs: 1000
      })
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });

  it("rejects DeepSeek responses with non-finite or negative usage", async () => {
    const adapter = new DeepSeekAdapter(
      async () =>
        jsonResponse({
          id: "chat_1",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: -1,
            completion_tokens: "not-a-number",
            total_tokens: 1
          }
        }),
      "https://example.test"
    );

    await expect(
      adapter.execute("ds-test", {
        model: "test",
        prompt: "hello",
        timeoutMs: 1000
      })
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });
});

describe("PLT-052 adapter usage mapping through HTTP responses", () => {
  const input = { model: "m", prompt: "hi", timeoutMs: 1000 };

  it("maps OpenAI cached and written tokens and keeps request bodies unchanged", async () => {
    let sent: Record<string, unknown> = {};
    const adapter = new OpenAIAdapter(async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return jsonResponse({
        id: "resp_1", status: "completed", output_text: "ok",
        usage: {
          input_tokens: 1_150, output_tokens: 16, total_tokens: 1_166,
          input_tokens_details: { cached_tokens: 1_000, cache_write_tokens: 100,
            cache_write_tokens_details: { ttl_30m_tokens: 100, ttl_12h_tokens: 0 } }
        }
      });
    }, "https://example.test");
    const result = await adapter.execute("sk-test", input);
    expect(result.usage).toMatchObject({
      inputTokens: 50, cacheReadTokens: 1_000, cacheWriteTokens: 100,
      cacheWrite30mTokens: 100, totalInputTokens: 1_150, totalTokens: 1_166
    });
    // No cache marking is sent in this PR (the switch arrives later).
    expect(Object.keys(sent).sort()).toEqual(["input", "model", "store"]);
  });

  it("maps DeepSeek hit/miss tokens", async () => {
    const adapter = new DeepSeekAdapter(async () => jsonResponse({
      id: "ds_1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 700, completion_tokens: 16, total_tokens: 716,
        prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 60
      }
    }), "https://example.test");
    const result = await adapter.execute("ds-test", input);
    expect(result.usage).toMatchObject({
      inputTokens: 60, cacheReadTokens: 640, cacheWriteTokens: 0, totalInputTokens: 700
    });
  });

  it("rejects inconsistent cache counters as PROVIDER_RESPONSE_INVALID", async () => {
    const openai = new OpenAIAdapter(async () => jsonResponse({
      output_text: "ok",
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11,
        input_tokens_details: { cached_tokens: 8, cache_write_tokens: 8 } }
    }), "https://example.test");
    await expect(openai.execute("sk-test", input))
      .rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
    const deepseek = new DeepSeekAdapter(async () => jsonResponse({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11,
        prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 1 }
    }), "https://example.test");
    await expect(deepseek.execute("ds-test", input))
      .rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });
});
