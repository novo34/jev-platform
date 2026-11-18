import { MODEL_PROVIDERS, ModelGatewayError, type CacheTtl, type ModelProvider } from "./types.js";

// PLT-052 design point 9: global switch and per-provider list for JEV's own
// cache marks (cache_control / prompt_cache_key). OpenAI and DeepSeek cache
// automatically and that CANNOT be turned off: with "off" JEV only stops
// sending cache marks and records cache_status DISABLED; cache reads reported
// by those providers are still recorded and priced.

const CACHE_PROVIDER_NAMES: readonly string[] = MODEL_PROVIDERS;

// Hybrid TTL (design point 5): 1h for the stable project block, 5m for task
// context and history. Anthropic requires longer TTLs before shorter ones, and
// the project block always comes first, so the project TTL may never be shorter.
export const DEFAULT_PROJECT_TTL: CacheTtl = "1h";
export const DEFAULT_TASK_TTL: CacheTtl = "5m";

function parseTtl(raw: string | undefined, name: string, fallback: CacheTtl): CacheTtl {
  if (raw === undefined) return fallback;
  if (raw !== "5m" && raw !== "1h") {
    throw configError(`${name} must be exactly "5m" or "1h" (got ${JSON.stringify(raw)})`);
  }
  return raw;
}

const AUTOMATIC_CACHE_NOTE =
  "automatic provider cache cannot be disabled and remains active; reads are still recorded";

export interface CacheDecision {
  // true: the gateway asks the adapter to mark the cache for this call.
  enabled: boolean;
  // Why the cache is not marked (only when enabled is false).
  reason?: string;
}

function configError(message: string): ModelGatewayError {
  return new ModelGatewayError("CACHE_CONFIG_INVALID", message);
}

export class CachePolicy {
  private readonly allowed: ReadonlySet<string> | undefined;

  // allowedProviders undefined = every provider (only meaningful when on).
  constructor(
    readonly enabled: boolean = false,
    allowedProviders?: readonly string[],
    readonly projectTtl: CacheTtl = DEFAULT_PROJECT_TTL,
    readonly taskTtl: CacheTtl = DEFAULT_TASK_TTL
  ) {
    if (projectTtl === "5m" && taskTtl === "1h") {
      throw configError("the project TTL cannot be shorter than the task TTL (1h entries must precede 5m ones)");
    }
    if (allowedProviders !== undefined) {
      for (const name of allowedProviders) {
        if (!CACHE_PROVIDER_NAMES.includes(name)) {
          throw configError(`unknown provider in cache provider list: ${JSON.stringify(name)}`);
        }
      }
    }
    this.allowed = allowedProviders ? new Set(allowedProviders) : undefined;
  }

  static disabled(): CachePolicy {
    return new CachePolicy(false);
  }

  // Strict parsing. Absent JEV_PROMPT_CACHE = off. Any value other than exactly
  // "on" or "off" (including empty, other case or surrounding spaces) is a
  // configuration error: it must never silently become "on".
  static fromEnv(env: Record<string, string | undefined> = process.env): CachePolicy {
    const raw = env.JEV_PROMPT_CACHE;
    let enabled = false;
    if (raw !== undefined) {
      if (raw !== "on" && raw !== "off") {
        throw configError(
          `JEV_PROMPT_CACHE must be exactly "on" or "off" (got ${JSON.stringify(raw)})`
        );
      }
      enabled = raw === "on";
    }
    const rawProviders = env.JEV_PROMPT_CACHE_PROVIDERS;
    let providers: string[] | undefined;
    if (rawProviders !== undefined) {
      providers = rawProviders.split(",");
      // Validated even when the switch is off, so a typo never waits for "on".
      if (providers.some((name) => !CACHE_PROVIDER_NAMES.includes(name))) {
        throw configError(
          `JEV_PROMPT_CACHE_PROVIDERS must be a comma-separated list of: ${CACHE_PROVIDER_NAMES.join(", ")}`
        );
      }
    }
    // Validated like the switch, even when off.
    const projectTtl = parseTtl(env.JEV_PROMPT_CACHE_PROJECT_TTL, "JEV_PROMPT_CACHE_PROJECT_TTL", DEFAULT_PROJECT_TTL);
    const taskTtl = parseTtl(env.JEV_PROMPT_CACHE_TASK_TTL, "JEV_PROMPT_CACHE_TASK_TTL", DEFAULT_TASK_TTL);
    return new CachePolicy(enabled, providers, projectTtl, taskTtl);
  }

  decide(provider: ModelProvider | string): CacheDecision {
    if (!this.enabled) {
      return { enabled: false, reason: "JEV_PROMPT_CACHE is off" };
    }
    if (this.allowed && !this.allowed.has(provider)) {
      return { enabled: false, reason: `provider ${provider} is not in JEV_PROMPT_CACHE_PROVIDERS` };
    }
    return { enabled: true };
  }
}

// cache_reason for a DISABLED call. Providers with automatic caching say so.
export function disabledReason(
  decision: CacheDecision, automatic: boolean
): string {
  const base = decision.reason ?? "cache disabled";
  return automatic ? `${base}; ${AUTOMATIC_CACHE_NOTE}` : base;
}

// A provider rejection attributable to the cache marks JEV sent: HTTP 400/422
// whose message names the cache parameters. Auth (401), rate limits (429),
// 5xx (incl. Anthropic 529 overloaded) and timeouts are NEVER cache-attributable,
// and neither is an unrelated 400.
// Checked against the Anthropic errors page (2026-11-18): it documents the 400
// invalid_request_error shape ({type:"error", error:{type,message}}) but quotes
// no cache-specific message; Anthropic validation messages carry the field path
// (e.g. "system.0.cache_control...") so the keywords below match. A 400 for the
// spend limit or other causes does not name the cache and is not retried as such.
export function isCacheAttributableError(error: unknown): boolean {
  if (!(error instanceof ModelGatewayError)) return false;
  if (error.code !== "PROVIDER_HTTP_ERROR") return false;
  if (error.status !== 400 && error.status !== 422) return false;
  return /cache|breakpoint|ephemeral|\bttl\b/i.test(error.message);
}
