import { describe, expect, it } from "vitest";
import {
  AnthropicAdapter,
  ModelGatewayError,
  PricingCatalog,
  mapAnthropicUsage,
  mapDeepSeekUsage,
  mapOpenAIUsage,
  type ModelGatewayRequest,
  type ModelGatewayResult,
  type NormalizedUsage
} from "@jev/model-gateway";
import {
  CACHE_ACCEPTANCE_CONSENT,
  CacheAcceptanceError,
  CallObserver,
  assertLiveReady,
  buildAcceptanceSegments,
  buildCacheAcceptancePlan,
  createGuardedFetch,
  describeShape,
  formatPlanText,
  formatReportText,
  parseCapChf,
  promptStats,
  runCacheAcceptance,
  sanitizeProviderMessage,
  type AcceptanceDeps,
  type CacheAcceptanceReport
} from "./cache-acceptance.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT_A = "22222222-2222-4222-8222-222222222222";
const TASK_A = "33333333-3333-4333-8333-333333333333";
const PROJECT_B = "44444444-4444-4444-8444-444444444444";
const TASK_B = "55555555-5555-4555-8555-555555555555";

const PRICING = {
  "anthropic:claude-sonnet-5-5": {
    inputPerMillionChf: 1.68, outputPerMillionChf: 8.4, cacheReadPerMillionChf: 0.084,
    cacheWrite5mPerMillionChf: 2.1, cacheWrite1hPerMillionChf: 3.36
  },
  "openai:gpt-6.1-terra": {
    inputPerMillionChf: 0.84, outputPerMillionChf: 4.2, cacheReadPerMillionChf: 0.042,
    cacheWrite30mPerMillionChf: 1.05, cacheWrite12hPerMillionChf: 2.1
  },
  "deepseek:deepseek-flash": {
    inputPerMillionChf: 0.25, outputPerMillionChf: 1, cacheReadPerMillionChf: 0.005,
    cacheWriteBilledAs: "input"
  }
};

function liveEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: "development",
    JEV_LIVE_CACHE_ACCEPTANCE: CACHE_ACCEPTANCE_CONSENT,
    JEV_LIVE_CACHE_MAX_CHF: "0.10",
    JEV_MODEL_PRICING_JSON: JSON.stringify(PRICING),
    DATABASE_URL: "postgres://localhost:5432/jev_test",
    JEV_SECRET_ENCRYPTION_KEY: "placeholder-not-a-key",
    JEV_TENANT_NAMESPACE_SECRET: "placeholder-not-a-secret",
    JEV_ACCEPT_ORGANIZATION_ID: ORG,
    JEV_ACCEPT_PROJECT_ID: PROJECT_A,
    JEV_ACCEPT_TASK_ID: TASK_A,
    JEV_ACCEPT_OTHER_PROJECT_ID: PROJECT_B,
    JEV_ACCEPT_OTHER_TASK_ID: TASK_B,
    JEV_ACCEPT_CACHE_PAUSE_MS: "0",
    ...extra
  };
}

// ---- simulated executor --------------------------------------------------

type Behavior = "cache" | "shared-cache" | "no-cache";

function usageFor(provider: string, hit: boolean, shared: boolean): NormalizedUsage {
  // Real response shapes of each provider, mapped by the real mappers.
  if (provider === "anthropic") {
    return mapAnthropicUsage(hit
      ? { input_tokens: 40, output_tokens: 4, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }
      : { input_tokens: 40, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 1500,
          cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 1200 } });
  }
  if (provider === "openai") {
    return mapOpenAIUsage(hit
      ? { input_tokens: 1540, output_tokens: 4, total_tokens: 1544,
          input_tokens_details: { cached_tokens: 1500, cache_write_tokens: 0, cache_write_tokens_details: { ttl_30m_tokens: 0, ttl_12h_tokens: 0 } } }
      : { input_tokens: 1540, output_tokens: 4, total_tokens: 1544,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1500, cache_write_tokens_details: { ttl_30m_tokens: 1500, ttl_12h_tokens: 0 } } });
  }
  void shared;
  return mapDeepSeekUsage(hit
    ? { prompt_tokens: 1540, completion_tokens: 4, total_tokens: 1544, prompt_cache_hit_tokens: 1500, prompt_cache_miss_tokens: 40 }
    : { prompt_tokens: 1540, completion_tokens: 4, total_tokens: 1544, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1540 });
}

function makeDeps(behavior: Behavior = "cache", overrides: Partial<AcceptanceDeps> = {}) {
  const pricing = PricingCatalog.fromJson(JSON.stringify(PRICING));
  const calls: ModelGatewayRequest[] = [];
  const seen = new Set<string>();
  const observer = new CallObserver();
  const deps: AcceptanceDeps = {
    observer,
    pricing,
    sleep: async () => {},
    listCredentialProviders: async () => ["anthropic", "openai", "deepseek"],
    execute: async (request: ModelGatewayRequest): Promise<ModelGatewayResult> => {
      calls.push(request);
      const target = request.targets[0]!;
      const key = behavior === "shared-cache"
        ? target.provider
        : `${target.provider}|${request.organizationId}|${request.projectId}`;
      const hit = behavior !== "no-cache" && seen.has(key);
      seen.add(key);
      const usage = usageFor(target.provider, hit, behavior === "shared-cache");
      if (target.provider === "openai") {
        observer.recordResponse(200, true, { usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 } } });
      }
      return {
        content: "OK", usage, requestId: request.requestId, provider: target.provider,
        model: target.model, attempts: 1, latencyMs: 5,
        estimatedCostChf: pricing.estimate(target.provider, target.model, usage).estimatedCostChf
      };
    },
    ...overrides
  };
  return { deps, calls, observer };
}

async function run(env: Record<string, string | undefined>, deps: AcceptanceDeps): Promise<CacheAcceptanceReport> {
  return runCacheAcceptance(buildCacheAcceptancePlan(env), deps);
}

const status = (report: CacheAcceptanceReport, provider: string, check: string) =>
  report.providers.find(p => p.provider === provider)!.checks.find(c => c.name === check)!.status;

// ---- tests ---------------------------------------------------------------

describe("cap parsing", () => {
  it("accepts plain decimals in (0, 0.10]", () => {
    expect(parseCapChf("0.10")).toBe(0.1);
    expect(parseCapChf("0.1")).toBe(0.1);
    expect(parseCapChf("0.002")).toBe(0.002);
  });

  it("rejects missing, malformed and non-positive caps", () => {
    for (const raw of [undefined, ""]) {
      expect(() => parseCapChf(raw)).toThrowError(expect.objectContaining({ code: "CAP_REQUIRED" }));
    }
    for (const raw of ["abc", "-1", "0", "0.0", "1e-1", "0x1", " 0.1", "0.1 ", "NaN", "Infinity", "0,1", ".1"]) {
      expect(() => parseCapChf(raw), raw).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^CAP_(INVALID|REQUIRED)$/) }));
    }
  });

  it("rejects a cap above CHF 0.10", () => {
    for (const raw of ["0.11", "0.100001", "1", "5"]) {
      expect(() => parseCapChf(raw), raw).toThrowError(expect.objectContaining({ code: "CAP_ABOVE_LIMIT" }));
    }
  });
});

describe("synthetic prompt", () => {
  it("covers the cache minimum, is deterministic and carries no dates, digits or ids", () => {
    const stats = promptStats(buildAcceptanceSegments());
    expect(stats.tokensLowerBound).toBeGreaterThanOrEqual(1100);
    expect(JSON.stringify(buildAcceptanceSegments())).toEqual(JSON.stringify(buildAcceptanceSegments()));
    const stable = buildAcceptanceSegments().filter(s => s.kind !== "input").map(s => s.content).join("\n");
    expect(stable).not.toMatch(/\d/);
  });
});

describe("dry run (default)", () => {
  it("without the consent variable builds a plan, calls nothing and lists what is missing", async () => {
    const env = liveEnv({ JEV_LIVE_CACHE_ACCEPTANCE: undefined, DATABASE_URL: undefined });
    const plan = buildCacheAcceptancePlan(env);
    expect(plan.mode).toBe("dry-run");
    expect(plan.live).toBeUndefined();
    expect(plan.missingVariables.join(" ")).toContain("JEV_LIVE_CACHE_ACCEPTANCE");
    expect(plan.missingVariables).toContain("DATABASE_URL");
    expect(plan.providers.map(p => p.provider)).toEqual(["anthropic", "openai", "deepseek"]);
    const text = formatPlanText(plan);
    expect(text).toContain("DRY RUN");
    expect(text).toContain("USD");
    expect(text).toContain("CHF");
    expect(text).toContain("A-1");
    expect(text).toContain("Missing variables:");
    expect(() => assertLiveReady(plan)).toThrow(CacheAcceptanceError);
    // A paid run cannot start from a dry-run plan, even with every dependency injected.
    const { deps, calls } = makeDeps();
    await expect(runCacheAcceptance(plan, deps)).rejects.toThrow(CacheAcceptanceError);
    expect(calls).toHaveLength(0);
  });

  it("is not enabled by a near-miss consent value", () => {
    for (const value of ["i_authorize_cache_paid_calls", "I_AUTHORIZE_ONE_PAID_CALL", "true", "1", ` ${CACHE_ACCEPTANCE_CONSENT}`, ""]) {
      expect(buildCacheAcceptancePlan(liveEnv({ JEV_LIVE_CACHE_ACCEPTANCE: value })).mode, value).toBe("dry-run");
    }
  });

  it("makes no network request at all (fetch is poisoned)", () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("network used"); }) as typeof fetch;
    try {
      const plan = buildCacheAcceptancePlan({ JEV_MODEL_PRICING_JSON: JSON.stringify(PRICING) });
      expect(formatPlanText(plan)).toContain("Worst-case estimate");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("live guards (nothing is called)", () => {
  it("refuses a missing, invalid or too large cap", async () => {
    const cases: Array<[string | undefined, string]> = [
      [undefined, "CAP_REQUIRED"], ["abc", "CAP_INVALID"], ["0", "CAP_INVALID"],
      ["0.11", "CAP_ABOVE_LIMIT"], ["1", "CAP_ABOVE_LIMIT"]
    ];
    for (const [cap, code] of cases) {
      const { deps, calls } = makeDeps();
      await expect(run(liveEnv({ JEV_LIVE_CACHE_MAX_CHF: cap }), deps), String(cap))
        .rejects.toMatchObject({ code });
      expect(calls).toHaveLength(0);
    }
  });

  it("aborts when the worst-case estimate exceeds the cap", async () => {
    const { deps, calls } = makeDeps();
    await expect(run(liveEnv({ JEV_LIVE_CACHE_MAX_CHF: "0.0001" }), deps))
      .rejects.toMatchObject({ code: "ESTIMATE_EXCEEDS_CAP" });
    expect(calls).toHaveLength(0);
  });

  it("aborts with PRICING_REQUIRED when no provider has all its rates", async () => {
    const { deps, calls } = makeDeps();
    await expect(run(liveEnv({ JEV_MODEL_PRICING_JSON: "{}" }), deps))
      .rejects.toMatchObject({ code: "PRICING_REQUIRED" });
    expect(calls).toHaveLength(0);
  });

  it("skips a provider with a missing rate (cache read, then Anthropic 1h write) and runs the others", async () => {
    const noRead = { ...PRICING, "openai:gpt-6.1-terra": { inputPerMillionChf: 1, outputPerMillionChf: 1 } };
    const { deps, calls } = makeDeps();
    const report = await run(liveEnv({ JEV_MODEL_PRICING_JSON: JSON.stringify(noRead) }), deps);
    const skipped = report.providers.find(p => p.provider === "openai")!;
    expect(skipped.status).toBe("SKIPPED");
    expect(skipped.skipReason).toContain("PRICING_REQUIRED");
    expect(skipped.skipReason).toContain("cacheReadPerMillionChf");
    expect(calls.map(c => c.targets[0]!.provider)).not.toContain("openai");

    const no1h = { ...PRICING, "anthropic:claude-sonnet-5-5": { ...PRICING["anthropic:claude-sonnet-5-5"], cacheWrite1hPerMillionChf: undefined } };
    const second = makeDeps();
    const report2 = await run(liveEnv({ JEV_MODEL_PRICING_JSON: JSON.stringify(no1h) }), second.deps);
    expect(report2.providers.find(p => p.provider === "anthropic")!.skipReason).toContain("cacheWrite1hPerMillionChf");
    expect(second.calls.map(c => c.targets[0]!.provider)).not.toContain("anthropic");
    expect(report2.overall).toBe("INCOMPLETE");
  });

  it("skips a provider without a stored credential and keeps going", async () => {
    const { deps, calls } = makeDeps("cache", { listCredentialProviders: async () => ["anthropic", "openai"] });
    const report = await run(liveEnv(), deps);
    expect(report.providers.find(p => p.provider === "deepseek")).toMatchObject({ status: "SKIPPED" });
    expect(report.providers.find(p => p.provider === "deepseek")!.skipReason).toContain("CREDENTIAL_MISSING");
    expect(calls.map(c => c.targets[0]!.provider)).not.toContain("deepseek");
    expect(calls).toHaveLength(6);
  });

  it("aborts when no provider has a credential", async () => {
    const { deps, calls } = makeDeps("cache", { listCredentialProviders: async () => [] });
    await expect(run(liveEnv(), deps)).rejects.toMatchObject({ code: "NO_RUNNABLE_PROVIDERS" });
    expect(calls).toHaveLength(0);
  });

  it("requires NODE_ENV=development, a local database and the other tenant", async () => {
    for (const env of [
      liveEnv({ NODE_ENV: "production" }),
      liveEnv({ DATABASE_URL: "postgres://db.example.com:5432/jev_test" }),
      liveEnv({ JEV_ACCEPT_OTHER_PROJECT_ID: undefined }),
      liveEnv({ JEV_ACCEPT_TASK_ID: "not-a-uuid" }),
      liveEnv({ JEV_TENANT_NAMESPACE_SECRET: undefined })
    ]) {
      const { deps, calls } = makeDeps();
      await expect(run(env, deps)).rejects.toBeInstanceOf(CacheAcceptanceError);
      expect(calls).toHaveLength(0);
    }
  });
});

describe("tenant A and B must not share the cache namespace", () => {
  const ORG_B = "66666666-6666-4666-8666-666666666666";

  it("rejects, in dry-run and live, B equal to A in organization and project (even with another task)", async () => {
    for (const mode of [undefined, CACHE_ACCEPTANCE_CONSENT]) {
      const env = liveEnv({ JEV_LIVE_CACHE_ACCEPTANCE: mode, JEV_ACCEPT_OTHER_PROJECT_ID: PROJECT_A });
      const plan = buildCacheAcceptancePlan(env);
      expect(plan.problems.some(p => p.code === "CONFIG_INVALID" && /differ from tenant A/.test(p.message))).toBe(true);
      expect(plan.live).toBeUndefined();
      expect(formatPlanText(plan)).toContain("tenant B must differ");
    }
    const { deps, calls } = makeDeps();
    await expect(run(liveEnv({ JEV_ACCEPT_OTHER_PROJECT_ID: PROJECT_A }), deps)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    // Explicit same organization and upper-case ids are the same tenant too.
    await expect(run(liveEnv({
      JEV_ACCEPT_OTHER_PROJECT_ID: PROJECT_A.toUpperCase(), JEV_ACCEPT_OTHER_ORGANIZATION_ID: ORG.toUpperCase()
    }), deps)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(calls).toHaveLength(0);
  });

  it("rejects the same task id for A and B", async () => {
    const plan = buildCacheAcceptancePlan(liveEnv({ JEV_ACCEPT_OTHER_TASK_ID: TASK_A }));
    expect(plan.problems.some(p => p.code === "CONFIG_INVALID")).toBe(true);
    expect(plan.live).toBeUndefined();
  });

  it("accepts another project, or another organization with the same project", () => {
    expect(buildCacheAcceptancePlan(liveEnv()).problems).toEqual([]);
    const otherOrg = buildCacheAcceptancePlan(liveEnv({
      JEV_ACCEPT_OTHER_ORGANIZATION_ID: ORG_B, JEV_ACCEPT_OTHER_PROJECT_ID: PROJECT_A
    }));
    expect(otherOrg.problems).toEqual([]);
    expect(otherOrg.live).toBeDefined();
  });
});

describe("persisted cache_status source", () => {
  it("database when the lookup works", async () => {
    const { deps } = makeDeps("cache", { lookupCacheStatus: async () => "WRITE" });
    const report = await run(liveEnv(), deps);
    expect(report.overall).toBe("PASS");
    for (const p of report.providers) for (const c of p.calls) expect(c.cacheStatusSource).toBe("database");
    expect(formatReportText(report)).toContain("source database");
    expect(JSON.stringify(report)).toContain('"cacheStatusSource":"database"');
  });

  it("a failing lookup (A-2, B-1) is INCONCLUSIVE, not PASS, and the paid call is not repeated", async () => {
    let n = 0;
    const base = makeDeps("cache");
    const failing = new Set<string>();
    const { deps, calls } = makeDeps("cache", {
      lookupCacheStatus: async (_org, requestId) => {
        if (failing.has(requestId)) throw new Error("db down");
        return "WRITE";
      },
      execute: async request => {
        n += 1;
        // Calls come in order A-1, A-2, B-1 per provider.
        if (n % 3 !== 1) failing.add(request.requestId);
        return base.deps.execute(request);
      }
    });
    const report = await run(liveEnv(), deps);
    expect(calls).toHaveLength(0); // base.deps recorded them, not this wrapper
    expect(base.calls).toHaveLength(9);
    expect(n).toBe(9);
    expect(report.overall).toBe("INCOMPLETE");
    for (const p of report.providers) {
      const labels = p.calls.map(c => c.cacheStatusSource);
      expect(labels).toEqual(["database", "unavailable", "unavailable"]);
      expect(p.calls[1]!.cacheStatus).toBeNull();
      expect(p.checks.find(c => c.name === "tenant_isolation")!.status).toBe("INCONCLUSIVE");
      expect(p.checks.find(c => c.name === "read_second_call")!.status).toBe("INCONCLUSIVE");
    }
    expect(formatReportText(report)).toContain("source unavailable");
  });
});

describe("full run with simulated adapters", () => {
  it("PASS: write on the first call, read on the second, no cross-tenant read", async () => {
    const { deps, calls } = makeDeps("cache");
    const report = await run(liveEnv(), deps);
    expect(report.overall).toBe("PASS");
    expect(calls).toHaveLength(9);
    for (const request of calls) {
      expect(request.maxRetries).toBe(0);
      expect(request.maxOutputTokens).toBe(16);
      expect(request.segments).toBeDefined();
    }
    // Two calls with the same tenant and one with another.
    const anthropicCalls = calls.filter(c => c.targets[0]!.provider === "anthropic");
    expect(anthropicCalls.map(c => c.projectId)).toEqual([PROJECT_A, PROJECT_A, PROJECT_B]);
    for (const provider of ["anthropic", "openai", "deepseek"]) {
      expect(status(report, provider, "read_second_call")).toBe("PASS");
      expect(status(report, provider, "tenant_isolation")).toBe("PASS");
      expect(status(report, provider, "usage_mapping")).toBe("PASS");
      expect(status(report, provider, "no_paid_retry")).toBe("PASS");
    }
    expect(status(report, "anthropic", "write_first_call")).toBe("PASS");
    expect(status(report, "anthropic", "ttl_attribution")).toBe("PASS");
    expect(status(report, "anthropic", "read_saves_cost")).toBe("PASS");
    const a1 = report.providers[0]!.calls[0]!;
    expect(a1.tokens).toMatchObject({ cacheWrite5m: 300, cacheWrite1h: 1200, cacheRead: 0 });
    expect(report.providers[0]!.calls[1]!.tokens!.cacheRead).toBe(1500);
    expect(report.providers[0]!.calls[1]!.savingsChf!).toBeGreaterThan(0);
    expect(report.accumulatedChf).toBeLessThan(report.capChf);
    expect(report.capChf).toBe(0.1);
  });

  it("FAIL: a cross-tenant cache read fails the isolation check", async () => {
    const { deps } = makeDeps("shared-cache");
    const report = await run(liveEnv(), deps);
    expect(report.overall).toBe("FAIL");
    for (const provider of ["anthropic", "openai", "deepseek"]) {
      expect(status(report, provider, "tenant_isolation")).toBe("FAIL");
    }
  });

  it("FAIL: no read on the second call (Anthropic, OpenAI); DeepSeek is only inconclusive", async () => {
    const { deps } = makeDeps("no-cache");
    const report = await run(liveEnv(), deps);
    expect(status(report, "anthropic", "read_second_call")).toBe("FAIL");
    expect(status(report, "openai", "read_second_call")).toBe("FAIL");
    expect(status(report, "deepseek", "read_second_call")).toBe("INCONCLUSIVE");
    expect(report.overall).toBe("FAIL");
  });

  it("prints no prompt content, keys or authorization data", async () => {
    const { deps } = makeDeps("cache");
    const report = await run(liveEnv(), deps);
    const out = JSON.stringify(report) + formatReportText(report);
    const rules = buildAcceptanceSegments().find(s => s.kind === "rules")!.content;
    expect(out).not.toContain(rules.slice(0, 40));
    expect(out).not.toMatch(/bearer|authorization|x-api-key|placeholder-not-a/i);
    expect(out).toContain("PLT-052 cache acceptance");
    expect(formatReportText(report)).toContain("cache_status");
  });
});

describe("hard stop and no retry", () => {
  const onlyAnthropic = { JEV_ACCEPT_CACHE_PROVIDERS: "anthropic" };

  it("stops after a call that reaches the cap", async () => {
    let n = 0;
    const base = makeDeps("cache");
    const deps: AcceptanceDeps = {
      ...base.deps,
      execute: async request => {
        const result = await base.deps.execute(request);
        n += 1;
        return { ...result, estimatedCostChf: n === 1 ? 0.06 : 0.05 };
      }
    };
    const report = await run(liveEnv(onlyAnthropic), deps);
    expect(report.stoppedReason).toBe("CAP_REACHED");
    expect(base.calls).toHaveLength(2);
    expect(report.providers[0]!.calls.map(c => c.outcome)).toEqual(["SUCCESS", "SUCCESS", "NOT_RUN"]);
    expect(report.overall).not.toBe("PASS");
  });

  it("does not start a call whose worst case no longer fits the cap", async () => {
    const base = makeDeps("cache");
    const deps: AcceptanceDeps = {
      ...base.deps,
      execute: async request => ({ ...(await base.deps.execute(request)), estimatedCostChf: 0.095 })
    };
    const report = await run(liveEnv(onlyAnthropic), deps);
    expect(report.stoppedReason).toBe("CAP_WOULD_BE_EXCEEDED");
    expect(base.calls).toHaveLength(1);
  });

  it("counts the worst case for a call that failed after a network request", async () => {
    const base = makeDeps("cache");
    const deps: AcceptanceDeps = {
      ...base.deps,
      execute: async () => {
        // Simulates a billed request whose response could not be used.
        deps.observer.claimNetworkAttempt();
        throw new ModelGatewayError("PROVIDER_RESPONSE_INVALID");
      }
    };
    const report = await run(liveEnv(onlyAnthropic), deps);
    const call = report.providers[0]!.calls[0]!;
    expect(call.outcome).toBe("FAILED");
    expect(call.assumedWorstCaseChf).toBeGreaterThan(0);
    expect(report.accumulatedChf).toBeCloseTo(call.assumedWorstCaseChf!, 9);
  });

  it("treats a cache error as a failed scenario and stops it without retrying", async () => {
    const base = makeDeps("cache");
    let anthropicCalls = 0;
    const deps: AcceptanceDeps = {
      ...base.deps,
      execute: async request => {
        if (request.targets[0]!.provider === "anthropic") {
          anthropicCalls += 1;
          throw new ModelGatewayError("PROVIDER_HTTP_ERROR", "cache_control rejected", false, 400);
        }
        return base.deps.execute(request);
      }
    };
    const report = await run(liveEnv(), deps);
    expect(anthropicCalls).toBe(1);
    const anthropic = report.providers.find(p => p.provider === "anthropic")!;
    expect(anthropic.calls.map(c => c.outcome)).toEqual(["FAILED", "NOT_RUN", "NOT_RUN"]);
    expect(report.overall).toBe("FAIL");
    // The other providers still ran.
    expect(base.calls.filter(c => c.targets[0]!.provider !== "anthropic")).toHaveLength(6);
  });

  it("the guarded fetch lets exactly one request through per call and records the real Anthropic error envelope", async () => {
    let network = 0;
    const base = (async () => {
      network += 1;
      return new Response(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "system.0.cache_control.ttl: invalid for key sk-ant-abcdef123456" }
      }), { status: 400, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const observer = new CallObserver();
    const adapter = new AnthropicAdapter(createGuardedFetch(base, observer));
    const input = { model: "claude-sonnet-5-5", prompt: "x", maxOutputTokens: 16, timeoutMs: 1000 };

    // Outside a call: refused before the network.
    await expect(adapter.execute("fixture-key", input)).rejects.toThrow(/PAID_RETRY_BLOCKED/);
    expect(network).toBe(0);

    observer.begin("anthropic");
    await expect(adapter.execute("fixture-key", input)).rejects.toMatchObject({ status: 400 });
    // The policy's retry without cache would be a second request: blocked.
    await expect(adapter.execute("fixture-key", input)).rejects.toThrow(/PAID_RETRY_BLOCKED/);
    const observation = observer.finish();
    expect(network).toBe(1);
    expect(observation.networkAttempts).toBe(1);
    expect(observation.blockedRetries).toBe(1);
    expect(observation.httpError).toMatchObject({ status: 400, envelope: { wellFormed: true, type: "error", errorType: "invalid_request_error" } });
    expect(observation.httpError!.envelope!.message).not.toContain("sk-ant-abcdef123456");
  });

  it("records only the shape (types) of a successful usage object, including null details", async () => {
    const base = (async () => new Response(JSON.stringify({
      usage: { input_tokens: 5, output_tokens: 1, input_tokens_details: null }
    }), { status: 200 })) as unknown as typeof fetch;
    const observer = new CallObserver();
    observer.begin("openai");
    await createGuardedFetch(base, observer)("https://example.invalid/responses");
    expect(observer.finish().usageShape).toEqual({
      input_tokens: "number", output_tokens: "number", input_tokens_details: "null"
    });
    expect(describeShape({ a: 1, b: { c: "secret" } })).toEqual({ a: "number", b: { c: "string" } });
  });

  it("sanitizes provider messages", () => {
    const text = sanitizeProviderMessage("bad Bearer abc.def and key sk-proj-ABCDEFGH12345 and ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(text).not.toMatch(/abc\.def|ABCDEFGH|ZZZZZZZZ/);
  });
});
