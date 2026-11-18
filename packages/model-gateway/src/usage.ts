import {
  ModelGatewayError,
  type CacheStatus,
  type NormalizedUsage
} from "./types.js";

// Pure mappers from each provider's raw `usage` object to the common model
// (PLT-052 design, point 2). They perform no I/O. The Anthropic mapper exists
// before its adapter on purpose: the adapter and the `anthropic` provider id
// arrive in a later PR.

function invalid(provider: string, detail: string): ModelGatewayError {
  return new ModelGatewayError(
    "PROVIDER_RESPONSE_INVALID",
    `${provider} response contained invalid usage${detail ? `: ${detail}` : ""}`
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function required(value: unknown, provider: string, field: string): number {
  if (!isCount(value)) throw invalid(provider, field);
  return value;
}

// A missing optional field means "not reported" (0); a present field must be valid.
function optional(value: unknown, provider: string, field: string): number {
  if (value === undefined || value === null) return 0;
  return required(value, provider, field);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

interface Parts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  cacheWrite30mTokens?: number;
  cacheWrite12hTokens?: number;
}

export function buildNormalizedUsage(parts: Parts, provider = "provider"): NormalizedUsage {
  const cacheReadTokens = parts.cacheReadTokens ?? 0;
  const cacheWriteTokens = parts.cacheWriteTokens ?? 0;
  const cacheWrite5mTokens = parts.cacheWrite5mTokens ?? 0;
  const cacheWrite1hTokens = parts.cacheWrite1hTokens ?? 0;
  const cacheWrite30mTokens = parts.cacheWrite30mTokens ?? 0;
  const cacheWrite12hTokens = parts.cacheWrite12hTokens ?? 0;
  const totalInputTokens = parts.inputTokens + cacheWriteTokens + cacheReadTokens;
  const totalTokens = totalInputTokens + parts.outputTokens;
  const all = [
    parts.inputTokens, parts.outputTokens, cacheReadTokens, cacheWriteTokens,
    cacheWrite5mTokens, cacheWrite1hTokens, cacheWrite30mTokens, cacheWrite12hTokens,
    totalInputTokens, totalTokens
  ];
  if (!all.every(isCount)) throw invalid(provider, "token totals out of range");
  if (cacheWrite5mTokens + cacheWrite1hTokens + cacheWrite30mTokens + cacheWrite12hTokens >
      cacheWriteTokens) {
    throw invalid(provider, "cache write TTL tokens exceed total cache write tokens");
  }
  return {
    inputTokens: parts.inputTokens,
    outputTokens: parts.outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    cacheWrite30mTokens,
    cacheWrite12hTokens,
    totalInputTokens
  };
}

// Usage for a provider without any cache accounting (legacy shape).
export function plainUsage(inputTokens: number, outputTokens: number): NormalizedUsage {
  return buildNormalizedUsage({ inputTokens, outputTokens });
}

// Anthropic Messages API: input_tokens EXCLUDES cache reads and writes.
export function mapAnthropicUsage(raw: unknown): NormalizedUsage {
  const usage = record(raw);
  if (!usage) throw invalid("Anthropic", "usage missing");
  const inputTokens = required(usage.input_tokens, "Anthropic", "input_tokens");
  const outputTokens = required(usage.output_tokens, "Anthropic", "output_tokens");
  const cacheWriteTokens = optional(
    usage.cache_creation_input_tokens, "Anthropic", "cache_creation_input_tokens"
  );
  const cacheReadTokens = optional(
    usage.cache_read_input_tokens, "Anthropic", "cache_read_input_tokens"
  );
  const breakdown = record(usage.cache_creation);
  const cacheWrite5mTokens = optional(
    breakdown?.ephemeral_5m_input_tokens, "Anthropic", "ephemeral_5m_input_tokens"
  );
  const cacheWrite1hTokens = optional(
    breakdown?.ephemeral_1h_input_tokens, "Anthropic", "ephemeral_1h_input_tokens"
  );
  // With a breakdown the TTL parts must add up; without one the write stays
  // unattributed (the TTL is never guessed) and pricing decides.
  if (breakdown && cacheWrite5mTokens + cacheWrite1hTokens !== cacheWriteTokens) {
    throw invalid("Anthropic", "cache_creation breakdown does not match cache_creation_input_tokens");
  }
  return buildNormalizedUsage({
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    cacheWrite5mTokens, cacheWrite1hTokens
  }, "Anthropic");
}

// OpenAI Responses API: input_tokens INCLUDES cached and written tokens.
// Models before GPT-5.6 only report cached_tokens (writes are 0).
export function mapOpenAIUsage(raw: unknown): NormalizedUsage {
  const usage = record(raw);
  if (!usage) throw invalid("OpenAI", "usage missing");
  const totalInput = required(usage.input_tokens, "OpenAI", "input_tokens");
  const outputTokens = required(usage.output_tokens, "OpenAI", "output_tokens");
  const details = record(usage.input_tokens_details);
  const cacheReadTokens = optional(details?.cached_tokens, "OpenAI", "cached_tokens");
  const cacheWriteTokens = optional(details?.cache_write_tokens, "OpenAI", "cache_write_tokens");
  // The documentation shows the TTL split next to the write counter; accept it
  // under the input details or at the top level of usage.
  const ttl = record(details?.cache_write_tokens_details) ??
    record(usage.cache_write_tokens_details);
  const cacheWrite30mTokens = optional(ttl?.ttl_30m_tokens, "OpenAI", "ttl_30m_tokens");
  const cacheWrite12hTokens = optional(ttl?.ttl_12h_tokens, "OpenAI", "ttl_12h_tokens");
  if (cacheReadTokens + cacheWriteTokens > totalInput) {
    throw invalid("OpenAI", "cached plus written tokens exceed input_tokens");
  }
  if (ttl && cacheWrite30mTokens + cacheWrite12hTokens !== cacheWriteTokens) {
    throw invalid("OpenAI", "cache write TTL breakdown does not match cache_write_tokens");
  }
  return buildNormalizedUsage({
    inputTokens: totalInput - cacheReadTokens - cacheWriteTokens,
    outputTokens, cacheReadTokens, cacheWriteTokens,
    cacheWrite30mTokens, cacheWrite12hTokens
  }, "OpenAI");
}

// DeepSeek chat/completions: hit/miss split of the prompt. There is no cache
// write charge and no TTL control, so writes are always 0.
export function mapDeepSeekUsage(raw: unknown): NormalizedUsage {
  const usage = record(raw);
  if (!usage) throw invalid("DeepSeek", "usage missing");
  const promptTokens = required(usage.prompt_tokens, "DeepSeek", "prompt_tokens");
  const outputTokens = required(usage.completion_tokens, "DeepSeek", "completion_tokens");
  const hasHit = usage.prompt_cache_hit_tokens !== undefined && usage.prompt_cache_hit_tokens !== null;
  const hasMiss = usage.prompt_cache_miss_tokens !== undefined && usage.prompt_cache_miss_tokens !== null;
  if (hasHit !== hasMiss) throw invalid("DeepSeek", "incomplete prompt cache hit/miss counters");
  if (!hasHit) {
    // Counters not reported: no cache information, all ordinary input.
    return buildNormalizedUsage({ inputTokens: promptTokens, outputTokens }, "DeepSeek");
  }
  const hit = required(usage.prompt_cache_hit_tokens, "DeepSeek", "prompt_cache_hit_tokens");
  const miss = required(usage.prompt_cache_miss_tokens, "DeepSeek", "prompt_cache_miss_tokens");
  if (hit + miss !== promptTokens) {
    throw invalid("DeepSeek", "prompt cache hit plus miss does not match prompt_tokens");
  }
  return buildNormalizedUsage(
    { inputTokens: miss, outputTokens, cacheReadTokens: hit }, "DeepSeek"
  );
}

// Cache state that can be observed from the response alone. Returns undefined
// when no cache token was reported (MISS/DISABLED/BELOW_MINIMUM need to know
// whether caching was requested, which is outside this PR).
export function observedCacheStatus(usage: NormalizedUsage): CacheStatus | undefined {
  if (usage.cacheReadTokens > 0) {
    return usage.cacheWriteTokens === 0 && usage.inputTokens === 0 ? "HIT" : "PARTIAL";
  }
  if (usage.cacheWriteTokens > 0) return "WRITE";
  return undefined;
}

// cacheRead / (cacheRead + cacheWrite + ordinary input), 0 with no input.
export function cacheHitRate(usage: NormalizedUsage): number {
  return usage.totalInputTokens === 0 ? 0 : usage.cacheReadTokens / usage.totalInputTokens;
}
