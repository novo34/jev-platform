import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import {
  AnthropicAdapter,
  CachePolicy,
  DeepSeekAdapter,
  ModelGateway,
  OpenAIAdapter,
  PricingCatalog,
  ProviderCredentialStore,
  ProviderRegistry
} from "@jev/model-gateway";
import {
  CACHE_ACCEPTANCE_CONSENT,
  CallObserver,
  buildCacheAcceptancePlan,
  createGuardedFetch,
  runCacheAcceptance,
  type CacheAcceptanceReport
} from "./cache-acceptance.js";

// Real ModelGateway + real adapters + PostgreSQL; only the network is simulated
// (a fake `fetch` that returns the documented response shape of each provider).
const pool = createDatabasePool();
const store = new ProviderCredentialStore(pool, randomBytes(32).toString("base64"));
const organizationId = randomUUID();
const userId = randomUUID();
const projectA = randomUUID();
const projectB = randomUUID();
const repoA = randomUUID();
const repoB = randomUUID();
const taskA = randomUUID();
const taskB = randomUUID();

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

beforeAll(async () => {
  await migrate(pool);
  await pool.query("INSERT INTO organizations (id, name) VALUES ($1, 'Cache Acceptance Org')", [organizationId]);
  await pool.query(
    "INSERT INTO users (id, organization_id, email, display_name, role) VALUES ($1, $2, $3, 'Owner', 'ADMIN')",
    [userId, organizationId, `cache-acceptance-${userId}@test.local`]
  );
  for (const [project, repo, task] of [[projectA, repoA, taskA], [projectB, repoB, taskB]] as const) {
    await pool.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Cache Acceptance')", [project, organizationId]);
    await pool.query(
      "INSERT INTO repositories (id, project_id, full_name, role) VALUES ($1, $2, $3, 'backend')",
      [repo, project, `novo34/test-cache-acceptance-${repo}`]
    );
    await pool.query("INSERT INTO tasks (id, project_id, repository_id, title) VALUES ($1, $2, $3, 'Cache acceptance')", [task, project, repo]);
  }
  for (const provider of ["anthropic", "openai", "deepseek"] as const) {
    await store.configure(organizationId, provider, `fixture-secret-${provider}`, userId);
  }
});

afterAll(async () => {
  await pool.query("TRUNCATE task_state_history");
  await pool.query("DELETE FROM model_provider_calls WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM cost_events WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM audit_events WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM provider_credentials WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM tasks WHERE project_id = ANY($1)", [[projectA, projectB]]);
  await pool.query("DELETE FROM repositories WHERE id = ANY($1)", [[repoA, repoB]]);
  await pool.query("DELETE FROM projects WHERE id = ANY($1)", [[projectA, projectB]]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
  await pool.end();
});

interface FakeNetwork {
  fetch: typeof fetch;
  requests: Array<{ url: string; body: any; headers: Record<string, string> }>;
}

// mode "isolated": a prefix is cached per tenant namespace (the first line of the
// prompt). "shared": one cache for every tenant (the failure the harness must catch).
// "reject-anthropic": Anthropic answers 400 naming cache_control.
function fakeNetwork(mode: "isolated" | "shared" | "reject-anthropic"): FakeNetwork {
  const cached = new Set<string>();
  const requests: FakeNetwork["requests"] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    requests.push({ url, body, headers: init.headers as Record<string, string> });
    const text: string = JSON.stringify(body.system ?? body.input ?? body.messages);
    const namespace = mode === "shared" ? "shared" : /jev-tenant-namespace: ([0-9a-f]{64})/.exec(text)?.[1] ?? "none";
    const key = `${url}|${namespace}`;
    const hit = cached.has(key);
    cached.add(key);
    if (url.includes("anthropic")) {
      if (mode === "reject-anthropic") {
        return json(400, { type: "error", error: { type: "invalid_request_error", message: "system.1.cache_control.ttl: not permitted" } });
      }
      return json(200, {
        id: "msg_fixture", stop_reason: "end_turn", content: [{ type: "text", text: "OK" }],
        usage: {
          input_tokens: 40, output_tokens: 4,
          cache_read_input_tokens: hit ? 1500 : 0,
          cache_creation_input_tokens: hit ? 0 : 1500,
          cache_creation: { ephemeral_5m_input_tokens: hit ? 0 : 300, ephemeral_1h_input_tokens: hit ? 0 : 1200 }
        }
      });
    }
    if (url.includes("openai")) {
      return json(200, {
        id: "resp_fixture", status: "completed", output_text: "OK",
        usage: {
          input_tokens: 1540, output_tokens: 4, total_tokens: 1544,
          input_tokens_details: { cached_tokens: hit ? 1500 : 0, cache_write_tokens: hit ? 0 : 1500, cache_write_tokens_details: { ttl_30m_tokens: hit ? 0 : 1500, ttl_12h_tokens: 0 } }
        }
      });
    }
    return json(200, {
      id: "chat_fixture", choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 1540, completion_tokens: 4, total_tokens: 1544,
        prompt_cache_hit_tokens: hit ? 1500 : 0, prompt_cache_miss_tokens: hit ? 40 : 1540
      }
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

async function runAgainst(network: FakeNetwork): Promise<CacheAcceptanceReport> {
  const pricing = PricingCatalog.fromJson(JSON.stringify(PRICING));
  const observer = new CallObserver();
  const guarded = createGuardedFetch(network.fetch, observer);
  const registry = new ProviderRegistry()
    .register(new OpenAIAdapter(guarded, "https://fake.openai.test/v1"))
    .register(new DeepSeekAdapter(guarded, "https://fake.deepseek.test"))
    .register(new AnthropicAdapter(guarded, "https://fake.anthropic.test/v1"));
  const policy = new CachePolicy(true, ["anthropic", "openai", "deepseek"], "1h", "5m");
  const gateway = new ModelGateway(pool, store, registry, pricing, 3, 30_000, () => {}, policy, "tenant-secret-fixture");
  const plan = buildCacheAcceptancePlan({
    NODE_ENV: "development",
    JEV_LIVE_CACHE_ACCEPTANCE: CACHE_ACCEPTANCE_CONSENT,
    JEV_LIVE_CACHE_MAX_CHF: "0.10",
    JEV_MODEL_PRICING_JSON: JSON.stringify(PRICING),
    DATABASE_URL: "postgres://localhost:5432/jev_test",
    JEV_SECRET_ENCRYPTION_KEY: "placeholder-not-a-key",
    JEV_TENANT_NAMESPACE_SECRET: "tenant-secret-fixture",
    JEV_ACCEPT_ORGANIZATION_ID: organizationId,
    JEV_ACCEPT_PROJECT_ID: projectA,
    JEV_ACCEPT_TASK_ID: taskA,
    JEV_ACCEPT_OTHER_PROJECT_ID: projectB,
    JEV_ACCEPT_OTHER_TASK_ID: taskB,
    JEV_ACCEPT_CACHE_PAUSE_MS: "0"
  });
  return runCacheAcceptance(plan, {
    execute: request => gateway.execute(request),
    listCredentialProviders: async org => (await store.list(org)).map(item => item.provider),
    lookupCacheStatus: async (org, requestId) => {
      const result = await pool.query(
        "SELECT cache_status FROM model_provider_calls WHERE organization_id = $1 AND request_id = $2 AND outcome = 'SUCCESS'",
        [org, requestId]
      );
      return (result.rows[0]?.cache_status as string | null | undefined) ?? null;
    },
    observer,
    pricing,
    sleep: async () => {}
  });
}

describe("cache acceptance through the real gateway (simulated network)", () => {
  it("PASS: 9 requests, hybrid TTL marks, write then read, isolation, persisted cache status", async () => {
    const network = fakeNetwork("isolated");
    const report = await runAgainst(network);
    expect(report.overall).toBe("PASS");
    expect(network.requests).toHaveLength(9);
    // Exactly the planned calls, max_tokens 16, no retry.
    const anthropic = network.requests.filter(r => r.url.includes("anthropic"));
    expect(anthropic).toHaveLength(3);
    for (const request of anthropic) expect(request.body.max_tokens).toBe(16);
    // Hybrid TTL: 1h on the project block, 5m on the task block, 1h before 5m.
    const ttls = anthropic[0]!.body.system.flatMap((b: any) => b.cache_control ? [b.cache_control.ttl] : []);
    expect(ttls).toEqual(["1h", "5m"]);
    const calls = report.providers.find(p => p.provider === "anthropic")!.calls;
    expect(calls.map(c => c.cacheStatus)).toEqual(["WRITE", "PARTIAL", "WRITE"]);
    expect(calls[0]!.tokens).toMatchObject({ cacheWrite1h: 1200, cacheWrite5m: 300 });
    expect(calls[1]!.tokens!.cacheRead).toBe(1500);
    expect(calls.every(c => c.attempts === 1 && c.networkAttempts === 1)).toBe(true);
    const out = JSON.stringify(report);
    expect(out).not.toMatch(/fixture-secret|bearer|authorization/i);
  });

  it("FAIL: a cache shared across tenants is detected", async () => {
    const report = await runAgainst(fakeNetwork("shared"));
    expect(report.overall).toBe("FAIL");
    expect(report.providers.every(p => p.checks.find(c => c.name === "tenant_isolation")!.status === "FAIL")).toBe(true);
  });

  it("does not retry without cache when Anthropic rejects the marks: one request, scenario failed, error format recorded", async () => {
    const network = fakeNetwork("reject-anthropic");
    const report = await runAgainst(network);
    expect(network.requests.filter(r => r.url.includes("anthropic"))).toHaveLength(1);
    const anthropic = report.providers.find(p => p.provider === "anthropic")!;
    expect(anthropic.calls.map(c => c.outcome)).toEqual(["FAILED", "NOT_RUN", "NOT_RUN"]);
    expect(anthropic.calls[0]!.blockedRetries).toBe(1);
    expect(anthropic.checks.find(c => c.name === "anthropic_error_format")).toMatchObject({ status: "PASS" });
    expect(report.overall).toBe("FAIL");
    // The other providers still ran their three calls.
    expect(network.requests.filter(r => !r.url.includes("anthropic"))).toHaveLength(6);
  });
});
