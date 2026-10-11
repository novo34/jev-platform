import {
  ModelGatewayError,
  type AdapterResult,
  type ModelProvider,
  type ProviderAdapter,
  type ProviderHealth
} from "./types.js";

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

function normalizedUsage(
  inputValue: unknown,
  outputValue: unknown,
  totalValue: unknown,
  provider: string
) {
  const inputTokens = inputValue;
  const outputTokens = outputValue;
  const totalTokens = totalValue;

  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(totalTokens) ||
    (inputTokens as number) < 0 ||
    (outputTokens as number) < 0 ||
    (totalTokens as number) < 0
  ) {
    throw new ModelGatewayError(
      "PROVIDER_RESPONSE_INVALID",
      `${provider} response contained invalid usage`
    );
  }

  return { inputTokens: inputTokens as number, outputTokens: outputTokens as number, totalTokens: totalTokens as number };
}

abstract class BaseHttpAdapter implements ProviderAdapter {
  abstract readonly provider: ModelProvider;

  constructor(
    protected readonly fetchImpl: FetchLike = fetch,
    protected readonly baseUrl: string
  ) {}

  async health(apiKey: string, timeoutMs = 10_000): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const { body } = await fetchJsonWithTimeout(
        this.fetchImpl,
        `${this.baseUrl}/models`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` }
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

  abstract execute(
    apiKey: string,
    input: {
      model: string;
      prompt: string;
      maxOutputTokens?: number;
      timeoutMs: number;
    }
  ): Promise<AdapterResult>;
}

export class OpenAIAdapter extends BaseHttpAdapter {
  readonly provider = "openai" as const;

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
    }
  ): Promise<AdapterResult> {
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

    return {
      content: textFromOpenAIResponse(body),
      usage: normalizedUsage(
        usage.input_tokens,
        usage.output_tokens,
        usage.total_tokens,
        "OpenAI"
      ),
      finishReason: typeof body?.status === "string" ? body.status : undefined,
      rawMetadata: {
        responseId: typeof body?.id === "string" ? body.id : undefined
      }
    };
  }
}

export class DeepSeekAdapter extends BaseHttpAdapter {
  readonly provider = "deepseek" as const;

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
    }
  ): Promise<AdapterResult> {
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

    return {
      content,
      usage: normalizedUsage(
        usage.prompt_tokens,
        usage.completion_tokens,
        usage.total_tokens,
        "DeepSeek"
      ),
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
    .register(new DeepSeekAdapter());
}
