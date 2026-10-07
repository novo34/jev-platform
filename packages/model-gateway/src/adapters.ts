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

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ModelGatewayError(
        "PROVIDER_TIMEOUT",
        "provider request timed out",
        true
      );
    }
    throw new ModelGatewayError(
      "PROVIDER_HTTP_ERROR",
      error instanceof Error ? error.message : "provider request failed",
      true
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function jsonOrProviderError(response: Response): Promise<any> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ModelGatewayError(
      "PROVIDER_HTTP_ERROR",
      typeof body?.error?.message === "string"
        ? body.error.message
        : `provider returned HTTP ${response.status}`,
      retryableStatus(response.status),
      response.status
    );
  }
  return body;
}

function textFromOpenAIResponse(body: any): string {
  if (typeof body?.output_text === "string" && body.output_text) {
    return body.output_text;
  }

  for (const item of body?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === "string" && content.text) {
        return content.text;
      }
    }
  }

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
  const inputTokens = Number(inputValue);
  const outputTokens = Number(outputValue);
  const totalTokens = Number(totalValue);

  if (
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(totalTokens) ||
    inputTokens < 0 ||
    outputTokens < 0 ||
    totalTokens < 0
  ) {
    throw new ModelGatewayError(
      "PROVIDER_RESPONSE_INVALID",
      `${provider} response contained invalid usage`
    );
  }

  return { inputTokens, outputTokens, totalTokens };
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
      const response = await fetchWithTimeout(
        this.fetchImpl,
        `${this.baseUrl}/models`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` }
        },
        timeoutMs
      );
      await jsonOrProviderError(response);
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
    const response = await fetchWithTimeout(
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
    const body = await jsonOrProviderError(response);
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
    const response = await fetchWithTimeout(
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
    const body = await jsonOrProviderError(response);
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
