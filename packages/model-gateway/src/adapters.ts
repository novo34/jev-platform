import {
  ModelGatewayError,
  type AdapterExecuteInput,
  type AdapterResult,
  type AdapterCacheOptions,
  type CacheSupport,
  type CacheTtl,
  type ModelProvider,
  type ProviderAdapter,
  type ProviderHealth
} from "./types.js";
import type { BuiltPrompt } from "./prompt-builder.js";
import { DEFAULT_PROJECT_TTL, DEFAULT_TASK_TTL } from "./cache-policy.js";
import { mapAnthropicUsage, mapDeepSeekUsage, mapOpenAIUsage } from "./usage.js";

type FetchLike = typeof fetch;

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

// HTTP Retry-After may be delta-seconds or an HTTP-date. Never trust it as an unbounded wait.
export function parseRetryAfterMs(header: string | null, nowMs = Date.now()): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds * 1000 : Number.POSITIVE_INFINITY;
  }
  // Date.parse supports the standard IMF-fixdate (and legacy HTTP-date variants).
  if (!value.includes(",") && !value.endsWith("GMT")) return undefined;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

function assertOutputTokenCap(value: number | undefined): void {
  if (value !== undefined &&
      (!Number.isSafeInteger(value) || value < 1 || value > 32_768)) {
    throw new ModelGatewayError(
      "INVALID_REQUEST", "maxOutputTokens must be an integer between 1 and 32768"
    );
  }
}

async function fetchJsonWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ response: Response; body: any }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let receivedStatus: number | undefined;
  let receivedRetryAfterMs: number | undefined;
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    receivedStatus = response.status;
    receivedRetryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
    const body = await response.json().catch((error: unknown) => {
      if (controller.signal.aborted) throw error;
      return null;
    });
    if (!response.ok) {
      const providerError = new ModelGatewayError(
        "PROVIDER_HTTP_ERROR",
        typeof body?.error?.message === "string"
          ? body.error.message
          : `provider returned HTTP ${response.status}`,
        retryableStatus(response.status),
        response.status
      );
      if (providerError.retryable && receivedRetryAfterMs !== undefined) {
        Object.assign(providerError, { retryAfterMs: receivedRetryAfterMs });
      }
      throw providerError;
    }
    return { response, body };
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      const timedOut = new ModelGatewayError(
        "PROVIDER_TIMEOUT", "provider request timed out", true, receivedStatus
      );
      if (receivedRetryAfterMs !== undefined) {
        Object.assign(timedOut, { retryAfterMs: receivedRetryAfterMs });
      }
      throw timedOut;
    }
    if (error instanceof ModelGatewayError) throw error;
    throw new ModelGatewayError(
      "PROVIDER_HTTP_ERROR",
      error instanceof Error ? error.message : "provider request failed",
      true
    );
  } finally {
    clearTimeout(timeout);
  }
}

function textFromOpenAIResponse(body: any): string {
  if (typeof body?.output_text === "string" && body.output_text) {
    return body.output_text;
  }

  const parts: string[] = [];
  for (const item of Array.isArray(body?.output) ? body.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  if (parts.length > 0) return parts.join("");

  throw new ModelGatewayError(
    "PROVIDER_RESPONSE_INVALID",
    "OpenAI response did not contain text output"
  );
}

// Providers must still report a valid grand total, as before PLT-052.
function assertReportedTotal(value: unknown, provider: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ModelGatewayError(
      "PROVIDER_RESPONSE_INVALID",
      `${provider} response contained invalid usage`
    );
  }
}

abstract class BaseHttpAdapter implements ProviderAdapter {
  abstract readonly provider: ModelProvider;

  constructor(
    protected readonly fetchImpl: FetchLike = fetch,
    protected readonly baseUrl: string
  ) {}

  protected authHeaders(apiKey: string): Record<string, string> {
    return { Authorization: `Bearer ${apiKey}` };
  }

  async health(apiKey: string, timeoutMs = 10_000): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const { body } = await fetchJsonWithTimeout(
        this.fetchImpl,
        `${this.baseUrl}/models`,
        {
          method: "GET",
          headers: this.authHeaders(apiKey)
        },
        timeoutMs
      );
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        detail: error instanceof ModelGatewayError ? error.code : "provider_health_failed"
      };
    }
  }

  abstract execute(apiKey: string, input: AdapterExecuteInput): Promise<AdapterResult>;
}

export class OpenAIAdapter extends BaseHttpAdapter {
  readonly provider = "openai" as const;
  // Automatic cache that cannot be disabled; no cache marks are sent yet.
  readonly cacheSupport: CacheSupport = {
    mode: "automatic", ttls: [], minPrefixTokens: () => undefined, billsWrite: true
  };

  constructor(fetchImpl: FetchLike = fetch, baseUrl = "https://api.openai.com/v1") {
    super(fetchImpl, baseUrl);
  }

  async execute(
    apiKey: string,
    input: {
      model: string;
      prompt: string;
      maxOutputTokens?: number;
      timeoutMs: number;
      cache?: AdapterCacheOptions;
    }
  ): Promise<AdapterResult> {
    assertOutputTokenCap(input.maxOutputTokens);
    const { body } = await fetchJsonWithTimeout(
      this.fetchImpl,
      `${this.baseUrl}/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: input.model,
          input: input.prompt,
          // Stateless code/task prompts must not be retained by the provider.
          store: false,
          ...(input.maxOutputTokens ? { max_output_tokens: input.maxOutputTokens } : {})
        })
      },
      input.timeoutMs
    );
    const usage = body?.usage;
    if (!usage) {
      throw new ModelGatewayError(
        "PROVIDER_RESPONSE_INVALID",
        "OpenAI response did not contain usage"
      );
    }

    assertReportedTotal(usage.total_tokens, "OpenAI");
    return {
      content: textFromOpenAIResponse(body),
      usage: mapOpenAIUsage(usage),
      finishReason: typeof body?.status === "string" ? body.status : undefined,
      rawMetadata: {
        responseId: typeof body?.id === "string" ? body.id : undefined
      }
    };
  }
}

export class DeepSeekAdapter extends BaseHttpAdapter {
  readonly provider = "deepseek" as const;
  readonly cacheSupport: CacheSupport = {
    mode: "automatic", ttls: [], minPrefixTokens: () => undefined, billsWrite: false
  };

  constructor(fetchImpl: FetchLike = fetch, baseUrl = "https://api.deepseek.com") {
    super(fetchImpl, baseUrl);
  }

  async execute(
    apiKey: string,
    input: {
      model: string;
      prompt: string;
      maxOutputTokens?: number;
      timeoutMs: number;
      cache?: AdapterCacheOptions;
    }
  ): Promise<AdapterResult> {
    assertOutputTokenCap(input.maxOutputTokens);
    const { body } = await fetchJsonWithTimeout(
      this.fetchImpl,
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: "user", content: input.prompt }],
          ...(input.maxOutputTokens ? { max_tokens: input.maxOutputTokens } : {})
        })
      },
      input.timeoutMs
    );
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new ModelGatewayError(
        "PROVIDER_RESPONSE_INVALID",
        "DeepSeek response did not contain text output"
      );
    }
    const usage = body?.usage;
    if (!usage) {
      throw new ModelGatewayError(
        "PROVIDER_RESPONSE_INVALID",
        "DeepSeek response did not contain usage"
      );
    }

    assertReportedTotal(usage.total_tokens, "DeepSeek");
    return {
      content,
      usage: mapDeepSeekUsage(usage),
      finishReason:
        typeof body?.choices?.[0]?.finish_reason === "string"
          ? body.choices[0].finish_reason
          : undefined,
      rawMetadata: {
        responseId: typeof body?.id === "string" ? body.id : undefined
      }
    };
  }
}

// Anthropic Messages API. Source: platform.claude.com/docs/en/build-with-claude/prompt-caching
// and /api/errors, consulted 2026-11-18 (curl, text only; no API call was made).
export const ANTHROPIC_API_VERSION = "2026-10-21";
// max_tokens is mandatory in the Messages API; used when the caller sets none.
// Thinking (on by default in Claude 5.x) shares max_tokens with the answer, so a
// very small cap may leave no text block (rejected as PROVIDER_RESPONSE_INVALID).
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;
// The API accepts at most 4 breakpoints; the adapter uses at most 3.
export const ANTHROPIC_MAX_BREAKPOINTS = 4;

// Minimum cacheable prompt length per model (docs table, 2026-11-18). Below it
// the API caches nothing and returns no error. Unknown model => undefined.
const ANTHROPIC_MIN_PREFIX_TOKENS: Readonly<Record<string, number>> = {
  ...Object.fromEntries([
    "claude-fable-5-2", "claude-fable-5-1", "claude-fable-5",
    "claude-mythos-5-2", "claude-mythos-5-1", "claude-mythos-5",
    "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-haiku-5-5"
  ].map(id => [id, 512])),
  ...Object.fromEntries([
    "claude-opus-4-8", "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5",
    "claude-opus-4-1", "claude-opus-4", "claude-sonnet-4"
  ].map(id => [id, 1024])),
  "claude-opus-4-7": 2048,
  ...Object.fromEntries(
    ["claude-opus-4-6", "claude-opus-4-5", "claude-haiku-4-5"].map(id => [id, 4096])
  )
};

export function anthropicMinPrefixTokens(model: string): number | undefined {
  // Accept dated snapshots (claude-sonnet-5-5-20261001) and "-latest" aliases.
  const id = model.toLowerCase().replace(/-(\d{8}|latest)$/, "");
  return Object.hasOwn(ANTHROPIC_MIN_PREFIX_TOKENS, id) ? ANTHROPIC_MIN_PREFIX_TOKENS[id] : undefined;
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl: CacheTtl };
}

export interface AnthropicRequestPlan {
  system: AnthropicTextBlock[];
  messages: Array<{ role: "user"; content: AnthropicTextBlock[] }>;
  // Breakpoints sent, in request order (1h always before 5m).
  breakpoints: CacheTtl[];
}

// Canonical layout (design point 2): tools text -> project blocks -> task_context
// in `system`; history + input in ONE user message. Explicit per-block breakpoints
// only (never the top-level automatic cache_control): (1) last project block, project
// TTL; (2) last task block, task TTL; (3) last history block, task TTL.
// `tools` are sent as the canonical text the builder hashed, NOT as the API
// `tools` parameter: the gateway has no tool loop, and this way the hashed bytes
// are the bytes sent.
export function planAnthropicRequest(
  built: BuiltPrompt, cache: AdapterCacheOptions | undefined
): AnthropicRequestPlan {
  const mark = cache?.enabled === true;
  const projectTtl = cache?.projectTtl ?? DEFAULT_PROJECT_TTL;
  const taskTtl = cache?.taskTtl ?? DEFAULT_TASK_TTL;
  if (mark && projectTtl === "5m" && taskTtl === "1h") {
    throw new ModelGatewayError("INVALID_REQUEST", "project cache TTL cannot be shorter than task cache TTL");
  }
  const breakpoints: CacheTtl[] = [];
  const block = (text: string, ttl?: CacheTtl): AnthropicTextBlock => {
    if (mark && ttl) breakpoints.push(ttl);
    return { type: "text", text, ...(mark && ttl ? { cache_control: { type: "ephemeral", ttl } } : {}) };
  };
  const system: AnthropicTextBlock[] = [];
  if (built.toolsText) system.push(block(built.toolsText));
  const project = built.blocks.filter(b => b.stability === "project");
  project.forEach((b, i) => system.push(block(b.text, i === project.length - 1 ? projectTtl : undefined)));
  // Only the LAST task block carries the mark (like project and history), so the
  // plan never exceeds 3 breakpoints however many task_context segments exist.
  const task = built.blocks.filter(b => b.stability === "task");
  task.forEach((b, i) => system.push(block(b.text, i === task.length - 1 ? taskTtl : undefined)));
  const history = built.blocks.filter(b => b.kind === "history");
  const inputs = built.blocks.filter(b => b.kind === "input");
  const content: AnthropicTextBlock[] = [];
  history.forEach((b, i) => content.push(block(b.text, i === history.length - 1 ? taskTtl : undefined)));
  for (const b of inputs) content.push(block(b.text));
  if (system.length === 0 || content.length === 0) {
    throw new ModelGatewayError("INVALID_REQUEST", "a segmented Anthropic request needs a project segment and a history or input segment");
  }
  if (breakpoints.length > ANTHROPIC_MAX_BREAKPOINTS) {
    throw new ModelGatewayError("INVALID_REQUEST", "too many cache breakpoints");
  }
  return { system, messages: [{ role: "user", content }], breakpoints };
}

export class AnthropicAdapter extends BaseHttpAdapter {
  readonly provider = "anthropic" as const;
  readonly cacheSupport: CacheSupport = {
    mode: "explicit", ttls: ["5m", "1h"], minPrefixTokens: anthropicMinPrefixTokens, billsWrite: true
  };

  constructor(fetchImpl: FetchLike = fetch, baseUrl = "https://api.anthropic.com/v1") {
    super(fetchImpl, baseUrl);
  }

  protected authHeaders(apiKey: string): Record<string, string> {
    return { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_API_VERSION };
  }

  plannedCacheTtls(built: BuiltPrompt | undefined, cache: AdapterCacheOptions): CacheTtl[] {
    if (!built || !cache.enabled) return [];
    return [...new Set(planAnthropicRequest(built, cache).breakpoints)];
  }

  async execute(apiKey: string, input: AdapterExecuteInput): Promise<AdapterResult> {
    assertOutputTokenCap(input.maxOutputTokens);
    // Plain-text input: one user message, no breakpoints (never cached).
    const plan: AnthropicRequestPlan | undefined = input.built
      ? planAnthropicRequest(input.built, input.cache)
      : undefined;
    const { body } = await fetchJsonWithTimeout(
      this.fetchImpl,
      `${this.baseUrl}/messages`,
      {
        method: "POST",
        headers: { ...this.authHeaders(apiKey), "Content-Type": "application/json" },
        body: JSON.stringify({
          model: input.model,
          max_tokens: input.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
          ...(plan
            ? { system: plan.system, messages: plan.messages }
            : { messages: [{ role: "user", content: input.prompt }] })
        })
      },
      input.timeoutMs
    );
    const parts: string[] = [];
    for (const item of Array.isArray(body?.content) ? body.content : []) {
      if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
    }
    if (parts.length === 0) {
      throw new ModelGatewayError(
        "PROVIDER_RESPONSE_INVALID", "Anthropic response did not contain text output"
      );
    }
    return {
      content: parts.join(""),
      usage: mapAnthropicUsage(body?.usage),
      cacheMarks: input.cache?.enabled === true ? (plan?.breakpoints.length ?? 0) : undefined,
      finishReason: typeof body?.stop_reason === "string" ? body.stop_reason : undefined,
      rawMetadata: {
        responseId: typeof body?.id === "string" ? body.id : undefined
      }
    };
  }
}

export class ProviderRegistry {
  private readonly adapters = new Map<ModelProvider, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    this.adapters.set(adapter.provider, adapter);
    return this;
  }

  get(provider: ModelProvider): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new ModelGatewayError(
        "PROVIDER_NOT_REGISTERED",
        `provider not registered: ${provider}`
      );
    }
    return adapter;
  }

  has(provider: ModelProvider): boolean {
    return this.adapters.has(provider);
  }
}

export function createDefaultProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register(new OpenAIAdapter())
    .register(new DeepSeekAdapter())
    .register(new AnthropicAdapter());
}
