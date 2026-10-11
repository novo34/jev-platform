import { describe, expect, it } from "vitest";
import { DeepSeekAdapter, OpenAIAdapter } from "./adapters.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("provider response body timeout", () => {
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

describe("provider adapter usage validation", () => {
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
