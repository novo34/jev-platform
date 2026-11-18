import { describe, expect, it } from "vitest";
import {
  AnthropicAdapter, ANTHROPIC_API_VERSION, anthropicMinPrefixTokens, createDefaultProviderRegistry
} from "./adapters.js";
import { buildPrompt, type PromptSegment, type ToolDefinition } from "./prompt-builder.js";
import { CachePolicy, isCacheAttributableError } from "./cache-policy.js";
import { MODEL_PROVIDERS, ModelGatewayError } from "./types.js";

// All tests use a simulated fetch: no request ever leaves the process.
const TENANT = "ab".repeat(32);
const cacheOn = { enabled: true, projectTtl: "1h", taskTtl: "5m" } as const;

const segments: PromptSegment[] = [
  { kind: "input", content: "Do the thing." },
  { kind: "history", content: "earlier turn" },
  { kind: "task_context", content: "task details" },
  { kind: "rules", id: "r2", content: "rule two" },
  { kind: "system", content: "You are JEV." },
  { kind: "rules", id: "r1", content: "rule one" }
];
const tools: ToolDefinition[] = [
  { name: "zeta", input_schema: { type: "object", properties: { b: {}, a: {} } } },
  { name: "alpha", description: "first", input_schema: { type: "object" } }
];

function reply(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { "Content-Type": "application/json" }, ...init
  });
}
const okBody = (usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 5 }) => ({
  id: "msg_test", type: "message", role: "assistant", stop_reason: "end_turn",
  content: [{ type: "text", text: "OK" }], usage
});

function recorder(responder: (n: number) => Response = () => reply(okBody())) {
  const calls: Array<{ url: string; init: RequestInit; json: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, json: JSON.parse(String(init.body ?? "null")) });
    return responder(calls.length);
  }) as unknown as typeof fetch;
  return { calls, adapter: new AnthropicAdapter(fetchImpl, "https://example.test/v1") };
}

const baseInput = { model: "claude-sonnet-5-5", prompt: "unused", timeoutMs: 1000 };
const bps = (json: any): Array<{ where: string; ttl: string }> => {
  const out: Array<{ where: string; ttl: string }> = [];
  json.system.forEach((b: any, i: number) => b.cache_control && out.push({ where: `system.${i}`, ttl: b.cache_control.ttl }));
  json.messages.forEach((m: any, mi: number) => m.content.forEach((b: any, i: number) =>
    b.cache_control && out.push({ where: `messages.${mi}.${i}`, ttl: b.cache_control.ttl })));
  return out;
};

describe("AnthropicAdapter request", () => {
  it("sends x-api-key and anthropic-version to POST /messages", async () => {
    const { calls, adapter } = recorder();
    await adapter.execute("key-for-test", { ...baseInput, built: buildPrompt(segments, tools, TENANT) });
    expect(calls[0]!.url).toBe("https://example.test/v1/messages");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({
      "x-api-key": "key-for-test", "anthropic-version": ANTHROPIC_API_VERSION
    });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("sends 3 explicit breakpoints with 1h before 5m and never the top-level cache_control", async () => {
    const { calls, adapter } = recorder();
    const result = await adapter.execute("k", {
      ...baseInput, built: buildPrompt(segments, tools, TENANT), cache: cacheOn
    });
    const json = calls[0]!.json;
    expect(json).not.toHaveProperty("cache_control");
    expect(json).not.toHaveProperty("tools");
    expect(bps(json)).toEqual([
      { where: "system.3", ttl: "1h" }, // last project block (tools, system, r1, r2)
      { where: "system.4", ttl: "5m" }, // task_context
      { where: "messages.0.0", ttl: "5m" } // last history block
    ]);
    expect(json.system[3].text).toContain("rule two");
    expect(json.system[4].text).toContain("task details");
    expect(json.messages[0].content[1].text).toContain("Do the thing.");
    expect(json.messages[0].content[1].cache_control).toBeUndefined();
    expect(json.system.every((b: any) => b.cache_control?.type === undefined || b.cache_control.type === "ephemeral")).toBe(true);
    expect(result.cacheMarks).toBe(3);
    // 1h strictly before 5m in request order.
    const order = bps(json).map(b => b.ttl);
    expect(order).toEqual([...order].sort((a, b) => (a === "1h" ? -1 : 1) - (b === "1h" ? -1 : 1)));
    expect(json.max_tokens).toBeGreaterThan(0);
  });

  it("omits the task breakpoint without task_context and history; honors configured TTLs", async () => {
    const { calls, adapter } = recorder();
    const built = buildPrompt(
      [{ kind: "system", content: "s" }, { kind: "input", content: "go" }], undefined, TENANT
    );
    await adapter.execute("k", { ...baseInput, built, cache: cacheOn });
    expect(bps(calls[0]!.json)).toEqual([{ where: "system.0", ttl: "1h" }]);
    await adapter.execute("k", { ...baseInput, built, cache: { enabled: true, projectTtl: "5m", taskTtl: "5m" } });
    expect(bps(calls[1]!.json)).toEqual([{ where: "system.0", ttl: "5m" }]);
    await expect(adapter.execute("k", {
      ...baseInput, built, cache: { enabled: true, projectTtl: "5m", taskTtl: "1h" }
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(calls).toHaveLength(2);
  });

  it("sends no cache_control at all when the cache is off or unspecified", async () => {
    const { calls, adapter } = recorder();
    const built = buildPrompt(segments, tools, TENANT);
    const off = await adapter.execute("k", { ...baseInput, built, cache: { enabled: false } });
    await adapter.execute("k", { ...baseInput, built });
    for (const call of calls) expect(JSON.stringify(call.json)).not.toContain("cache_control");
    expect(off.cacheMarks).toBeUndefined();
  });

  it("sends a plain-text prompt as one user message with no breakpoints (cacheMarks 0 when asked)", async () => {
    const { calls, adapter } = recorder();
    const result = await adapter.execute("k", { ...baseInput, prompt: "hello", cache: cacheOn, maxOutputTokens: 16 });
    expect(calls[0]!.json).toEqual({
      model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "hello" }]
    });
    expect(result.cacheMarks).toBe(0);
  });

  it("is canonical and deterministic: tools and rules in any input order give identical bytes", async () => {
    const a = recorder();
    const b = recorder();
    await a.adapter.execute("k", { ...baseInput, built: buildPrompt(segments, tools, TENANT), cache: cacheOn });
    await b.adapter.execute("k", {
      ...baseInput,
      built: buildPrompt([...segments].reverse(), [...tools].reverse(), TENANT),
      cache: cacheOn
    });
    // history/input are single segments here, so the reversal only reorders sortable kinds.
    expect(b.calls[0]!.init.body).toBe(a.calls[0]!.init.body);
    const json = a.calls[0]!.json;
    expect(json.system[0].text.indexOf('"name":"alpha"')).toBeLessThan(json.system[0].text.indexOf('"name":"zeta"'));
    expect(json.system[0].text).toContain('"properties":{"a":{},"b":{}}');
    // tools come first, then system (with the tenant namespace), as in the API hierarchy.
    expect(json.system[1].text).toContain(TENANT);
  });

  it("rejects invalid output caps and requests without content before any fetch", async () => {
    const { calls, adapter } = recorder();
    await expect(adapter.execute("k", { ...baseInput, maxOutputTokens: 0 }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const noInput = buildPrompt([{ kind: "system", content: "s" }], undefined, TENANT);
    await expect(adapter.execute("k", { ...baseInput, built: noInput, cache: cacheOn }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(calls).toHaveLength(0);
  });

  it("plans the TTLs used for pricing", () => {
    const { adapter } = recorder();
    expect(adapter.plannedCacheTtls(buildPrompt(segments, tools, TENANT), cacheOn)).toEqual(["1h", "5m"]);
    expect(adapter.plannedCacheTtls(buildPrompt([{ kind: "system", content: "s" }, { kind: "input", content: "i" }], undefined, TENANT), cacheOn)).toEqual(["1h"]);
    expect(adapter.plannedCacheTtls(undefined, cacheOn)).toEqual([]);
    expect(adapter.plannedCacheTtls(buildPrompt(segments, tools, TENANT), { enabled: false })).toEqual([]);
  });
});

describe("AnthropicAdapter response", () => {
  it("maps read, 5m and 1h writes into the normalized usage", async () => {
    const { adapter } = recorder(() => reply(okBody({
      input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 1800,
      cache_creation_input_tokens: 248,
      cache_creation: { ephemeral_5m_input_tokens: 148, ephemeral_1h_input_tokens: 100 }
    })));
    const result = await adapter.execute("k", { ...baseInput, built: buildPrompt(segments, tools, TENANT), cache: cacheOn });
    expect(result.content).toBe("OK");
    expect(result.finishReason).toBe("end_turn");
    expect(result.usage).toMatchObject({
      inputTokens: 50, outputTokens: 7, cacheReadTokens: 1800, cacheWriteTokens: 248,
      cacheWrite5mTokens: 148, cacheWrite1hTokens: 100, totalInputTokens: 2098, totalTokens: 2105
    });
  });

  it("rejects a response without text or with invalid usage", async () => {
    const noText = recorder(() => reply({ ...okBody(), content: [{ type: "thinking", thinking: "" }] }));
    await expect(noText.adapter.execute("k", baseInput)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
    const badUsage = recorder(() => reply(okBody({ input_tokens: -1, output_tokens: 1 })));
    await expect(badUsage.adapter.execute("k", baseInput)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });

  const errorBody = (type: string, message: string) => ({ type: "error", error: { type, message } });

  it.each([
    [429, "rate_limit_error", true], [529, "overloaded_error", true],
    [500, "api_error", true], [504, "timeout_error", true],
    [400, "invalid_request_error", false], [401, "authentication_error", false],
    [403, "permission_error", false], [404, "not_found_error", false], [413, "request_too_large", false]
  ])("maps HTTP %i (%s) to a PROVIDER_HTTP_ERROR, retryable=%s", async (status, type, retryable) => {
    const { adapter } = recorder(() => reply(errorBody(type, `msg ${type}`), { status, headers: { "retry-after": "2" } }));
    await expect(adapter.execute("k", baseInput)).rejects.toMatchObject({
      code: "PROVIDER_HTTP_ERROR", status, retryable, message: `msg ${type}`,
      ...(retryable ? { retryAfterMs: 2000 } : {})
    });
  });

  it("times out as a retryable PROVIDER_TIMEOUT", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })) as unknown as typeof fetch;
    const adapter = new AnthropicAdapter(fetchImpl, "https://example.test/v1");
    await expect(adapter.execute("k", { ...baseInput, timeoutMs: 20 }))
      .rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", retryable: true });
  });

  it("health uses x-api-key on GET /models", async () => {
    const { calls, adapter } = recorder(() => reply({ data: [] }));
    expect(await adapter.health("k")).toMatchObject({ ok: true });
    expect(calls[0]!.url).toBe("https://example.test/v1/models");
    expect(calls[0]!.init.headers).toMatchObject({ "x-api-key": "k", "anthropic-version": ANTHROPIC_API_VERSION });
  });
});

describe("Anthropic cache capability", () => {
  it("is explicit with 5m and 1h TTLs, bills writes and is registered by default", () => {
    const adapter = new AnthropicAdapter();
    expect(adapter.cacheSupport).toMatchObject({ mode: "explicit", ttls: ["5m", "1h"], billsWrite: true });
    expect(createDefaultProviderRegistry().has("anthropic")).toBe(true);
    expect(MODEL_PROVIDERS).toContain("anthropic");
  });

  it.each([
    ["claude-sonnet-5-5", 512], ["claude-haiku-5-5", 512], ["claude-opus-5-5", 512],
    ["claude-sonnet-5-5-20261001", 512], ["claude-sonnet-5-5-latest", 512],
    ["claude-sonnet-5", 1024], ["claude-sonnet-4-5", 1024], ["claude-opus-4-8", 1024],
    ["claude-opus-4-7", 2048], ["claude-opus-4-6", 4096], ["claude-haiku-4-5-20251001", 4096],
    ["claude-unknown-9", undefined], ["", undefined], ["constructor", undefined]
  ])("minimum for %s is %s", (model, expected) => {
    expect(anthropicMinPrefixTokens(model)).toBe(expected);
    expect(new AnthropicAdapter().cacheSupport.minPrefixTokens(model)).toBe(expected);
  });
});

describe("CachePolicy TTL configuration and cache-error heuristic", () => {
  it("defaults to the hybrid 1h project / 5m task TTL and validates the variables strictly", () => {
    expect(CachePolicy.fromEnv({})).toMatchObject({ projectTtl: "1h", taskTtl: "5m" });
    expect(CachePolicy.fromEnv({ JEV_PROMPT_CACHE_PROJECT_TTL: "5m" })).toMatchObject({ projectTtl: "5m", taskTtl: "5m" });
    for (const env of [
      { JEV_PROMPT_CACHE_PROJECT_TTL: "2h" }, { JEV_PROMPT_CACHE_TASK_TTL: "" },
      { JEV_PROMPT_CACHE_PROJECT_TTL: "5m", JEV_PROMPT_CACHE_TASK_TTL: "1h" }
    ]) {
      expect(() => CachePolicy.fromEnv(env)).toThrowError(
        expect.objectContaining({ code: "CACHE_CONFIG_INVALID" }) as unknown as Error
      );
    }
  });

  it("treats Anthropic-shaped cache 400s as attributable and 429/529/spend-limit as not", () => {
    const http = (status: number, message: string) =>
      new ModelGatewayError("PROVIDER_HTTP_ERROR", message, status >= 500 || status === 429, status);
    expect(isCacheAttributableError(http(400, "system.0.cache_control.ttl: Input should be '5m' or '1h'"))).toBe(true);
    expect(isCacheAttributableError(http(400, "A maximum of 4 blocks with cache_control may be provided"))).toBe(true);
    expect(isCacheAttributableError(http(529, "Overloaded cache"))).toBe(false);
    expect(isCacheAttributableError(http(429, "cache rate limit"))).toBe(false);
    expect(isCacheAttributableError(http(400, "You have reached your specified workspace API usage limits"))).toBe(false);
  });

  it("marks only the LAST project, task and history block: at most 3 breakpoints with several of each", async () => {
    const many: PromptSegment[] = [
      { kind: "system", content: "sys" },
      { kind: "rules", id: "r1", content: "rule one" },
      { kind: "rules", id: "r2", content: "rule two" },
      { kind: "task_context", content: "task a" },
      { kind: "task_context", content: "task b" },
      { kind: "task_context", content: "task c" },
      { kind: "history", content: "h1" },
      { kind: "history", content: "h2" },
      { kind: "input", content: "go" }
    ];
    const { calls, adapter } = recorder();
    const built = buildPrompt(many, tools, TENANT);
    const result = await adapter.execute("k", { ...baseInput, built, cache: cacheOn });
    const marks = bps(calls[0]!.json);
    expect(marks).toHaveLength(3);
    expect(result.cacheMarks).toBe(3);
    // Order in the request: project (1h) before task (5m) before history (5m).
    expect(marks.map(m => m.ttl)).toEqual(["1h", "5m", "5m"]);
    const system = calls[0]!.json.system;
    const markedTexts = system.filter((b: any) => b.cache_control).map((b: any) => b.text);
    expect(markedTexts).toHaveLength(2);
    expect(system[system.length - 1].cache_control).toBeDefined();
    expect(system[system.length - 1].text).toContain("task c");
    expect(system.filter((b: any) => /task [ab]/.test(b.text)).every((b: any) => !b.cache_control)).toBe(true);
    const content = calls[0]!.json.messages[0].content;
    expect(content.filter((b: any) => b.cache_control)).toHaveLength(1);
    expect(content[1].cache_control).toBeDefined();
    expect(content[0].cache_control).toBeUndefined();
    expect(adapter.plannedCacheTtls(built, cacheOn)).toEqual(["1h", "5m"]);
  });
});
