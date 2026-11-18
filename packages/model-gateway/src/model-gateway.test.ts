import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import {
  ModelGateway,
  CachePolicy,
  ModelGatewayError,
  PricingCatalog,
  ProviderCredentialStore,
  ProviderRegistry,
  mapDeepSeekUsage,
  mapOpenAIUsage,
  plainUsage,
  type PriceRate,
  type ProviderAdapter
} from "./index.js";

const pool = createDatabasePool();
const encryptionKey = randomBytes(32).toString("base64");
const credentials = new ProviderCredentialStore(pool, encryptionKey);
const organizationId = randomUUID();
const userId = randomUUID();
const projectId = randomUUID();
const repositoryId = randomUUID();
const orderId = randomUUID();
const taskId = randomUUID();

beforeAll(async () => {
  await migrate(pool);
  await pool.query("INSERT INTO organizations (id, name) VALUES ($1, 'Gateway Org')", [organizationId]);
  await pool.query(
    `INSERT INTO users (id, organization_id, email, display_name, role)
     VALUES ($1, $2, $3, 'Gateway Owner', 'ADMIN')`,
    [userId, organizationId, `gateway-${userId}@test.local`]
  );
  await pool.query(
    "INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Gateway Project')",
    [projectId, organizationId]
  );
  await pool.query(
    `INSERT INTO repositories (id, project_id, full_name, role)
     VALUES ($1, $2, $3, $4)`,
    [repositoryId, projectId, "novo34/test-model-gateway", "backend"]
  );
  await pool.query(
    `INSERT INTO orders (id, project_id, author_user_id, objective)
     VALUES ($1, $2, $3, 'Gateway order')`,
    [orderId, projectId, userId]
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, order_id, repository_id, title)
     VALUES ($1, $2, $3, $4, 'Gateway task')`,
    [taskId, projectId, orderId, repositoryId]
  );
});

afterAll(async () => {
  // Owner-only disposable teardown: canonical Task history rejects row deletion.
  await pool.query("TRUNCATE task_state_history");
  await pool.query("DELETE FROM model_provider_calls WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM cost_events WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM audit_events WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM provider_credentials WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM tasks WHERE project_id = $1", [projectId]);
  await pool.query("DELETE FROM orders WHERE project_id = $1", [projectId]);
  await pool.query("DELETE FROM repositories WHERE id = $1", [repositoryId]);
  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
  await pool.end();
});

describe("ProviderCredentialStore", () => {
  it("stores provider credentials encrypted and never returns them in metadata", async () => {
    const secret = "sk-test-super-secret-1234";
    const metadata = await credentials.configure(organizationId, "openai", secret, userId);

    expect(metadata).toMatchObject({
      provider: "openai",
      configured: true,
      lastFour: "1234"
    });

    const persisted = await pool.query(
      `SELECT ciphertext, last_four
         FROM provider_credentials
        WHERE organization_id = $1 AND provider = 'openai'`,
      [organizationId]
    );
    expect(persisted.rows[0].ciphertext).not.toContain(secret);
    expect(persisted.rows[0].last_four).toBe("1234");
    await expect(credentials.getSecret(organizationId, "openai")).resolves.toBe(secret);
    expect(JSON.stringify(await credentials.list(organizationId))).not.toContain(secret);
  });
});

describe("PricingCatalog validation", () => {
  it("rejects invalid prices before any provider can be called", () => {
    const invalidRates = [
      { inputPerMillionChf: -1, outputPerMillionChf: 1 },
      { inputPerMillionChf: Infinity, outputPerMillionChf: 1 },
      { inputPerMillionChf: 1, outputPerMillionChf: NaN },
      { inputPerMillionChf: 1 },
      { inputPerMillionChf: "1", outputPerMillionChf: 1 },
      { inputPerMillionChf: 1e15, outputPerMillionChf: 1 }
    ];
    for (const rate of invalidRates) {
      expect(() => new PricingCatalog({ "openai:*": rate as never }))
        .toThrowError(ModelGatewayError);
    }
    for (const raw of ['{"openai:*":{"inputPerMillionChf":-1,"outputPerMillionChf":1}}', '[]', 'null', '{']) {
      expect(() => PricingCatalog.fromJson(raw)).toThrowError(ModelGatewayError);
    }
    const priced = new PricingCatalog({
      "openai:*": { inputPerMillionChf: 1_000_000, outputPerMillionChf: 0, cacheReadPerMillionChf: 0 }
    });
    expect(() => priced.estimateChf("openai", "test", plainUsage(100_000_000, 0))).toThrowError(ModelGatewayError);
    expect(new PricingCatalog({ "openai:*": { inputPerMillionChf: 0, outputPerMillionChf: 0, cacheReadPerMillionChf: 0 } })
      .has("openai", "gpt-test")).toBe(true);
  });
});

describe("ModelGateway", () => {
  it("rejects excessive or duplicate targets before contacting a provider", async () => {
    const gateway = new ModelGateway(pool, credentials, new ProviderRegistry(),
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0 } }));
    const base = {
      organizationId, projectId, orderId, taskId, agentRole: "DEVELOPER",
      prompt: "Do not invoke paid providers"
    };
    await expect(gateway.execute({
      ...base, requestId: randomUUID(),
      targets: Array.from({ length: 5 }, (_, i) => ({
        provider: "openai" as const, model: "model-" + i
      }))
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(gateway.execute({
      ...base, requestId: randomUUID(),
      targets: [
        { provider: "openai", model: "same-model" },
        { provider: "openai", model: "same-model" }
      ]
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("caps total paid attempts across all fallback models", async () => {
    let calls = 0;
    const registry = new ProviderRegistry().register({
      provider: "openai",
      async execute() {
        calls += 1;
        throw new ModelGatewayError("PROVIDER_HTTP_ERROR", "unavailable", true, 503);
      },
      async health() { return { ok: true }; }
    });
    const gateway = new ModelGateway(pool, credentials, registry,
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0 } }));
    await expect(gateway.execute({
      requestId: randomUUID(), organizationId, projectId, orderId, taskId,
      agentRole: "DEVELOPER", prompt: "Bound total retries",
      targets: Array.from({ length: 4 }, (_, i) => ({
        provider: "openai" as const, model: "fallback-" + i
      })),
      maxRetries: 3
    })).rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
    expect(calls).toBe(8);
  });

  it("records failure when global budget ends before the local retry limit", async () => {
    let attempts = 0;
    const registry = new ProviderRegistry().register({
      provider: "openai",
      async execute() {
        attempts += 1;
        throw new ModelGatewayError("PROVIDER_HTTP_ERROR", "temporary upstream failure", true, 503);
      },
      async health() { return { ok: true }; }
    });
    const gateway = new ModelGateway(pool, credentials, registry,
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0 } }));
    const requestId = randomUUID();
    await expect(gateway.execute({
      requestId, organizationId, projectId, orderId, taskId,
      agentRole: "DEVELOPER", prompt: "Exhaust shared provider attempt budget",
      targets: [
        { provider: "openai", model: "model-one" },
        { provider: "openai", model: "model-two" }
      ],
      maxRetries: 5
    })).rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
    expect(attempts).toBe(8);
    const calls = await pool.query(
      "SELECT model, outcome, attempt_count FROM model_provider_calls WHERE request_id = $1 ORDER BY model",
      [requestId]
    );
    expect(calls.rows).toEqual([
      expect.objectContaining({ model: "model-one", outcome: "FAILED", attempt_count: 6 }),
      expect.objectContaining({ model: "model-two", outcome: "FAILED", attempt_count: 2 })
    ]);
  }, 25_000);

  it("does not lose task order attribution when orderId is omitted", async () => {
    const gateway = new ModelGateway(pool, credentials, new ProviderRegistry(),
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0 } }));
    await expect(gateway.execute({
      requestId: randomUUID(), organizationId, projectId, taskId,
      agentRole: "DEVELOPER", prompt: "No ambiguous billing",
      targets: [{ provider: "openai", model: "test" }]
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("honors Retry-After before retrying a paid 429 response", async () => {
    let calls = 0;
    const callTimes: number[] = [];
    const registry = new ProviderRegistry().register({
      provider: "openai",
      async execute() {
        calls += 1;
        callTimes.push(Date.now());
        if (calls === 1) {
          throw Object.assign(
            new ModelGatewayError("PROVIDER_HTTP_ERROR", "rate limited", true, 429),
            { retryAfterMs: 1000 }
          );
        }
        return {
          content: "ok",
          usage: plainUsage(2, 1)
        };
      },
      async health() { return { ok: true }; }
    });
    const gateway = new ModelGateway(pool, credentials, registry,
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0 } }));
    const result = await gateway.execute({
      requestId: randomUUID(), organizationId, projectId, orderId, taskId,
      agentRole: "DEVELOPER", prompt: "Retry safely",
      targets: [{ provider: "openai", model: "test" }], maxRetries: 1
    });
    expect(result.attempts).toBe(2);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(900);
  });

  it("avoids a paid retry when provider Retry-After exceeds bounded budget", async () => {
    let calls = 0;
    const registry = new ProviderRegistry().register({
      provider: "openai",
      async execute() {
        calls += 1;
        throw Object.assign(
          new ModelGatewayError("PROVIDER_HTTP_ERROR", "too many requests", true, 429),
          { retryAfterMs: 60_000 }
        );
      },
      async health() { return { ok: true }; }
    });
    const gateway = new ModelGateway(pool, credentials, registry,
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0 } }));
    await expect(gateway.execute({
      requestId: randomUUID(), organizationId, projectId, orderId, taskId,
      agentRole: "DEVELOPER", prompt: "Respect provider deadline",
      targets: [{ provider: "openai", model: "test" }], maxRetries: 5
    })).rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
    expect(calls).toBe(1);
  });

  it("rejects missing, nonfinite or unsafe output caps without contacting paid providers", async () => {
    let paidCalls = 0;
    const registry = new ProviderRegistry().register({
      provider: "openai",
      async execute() {
        paidCalls += 1;
        throw new Error("paid call must not occur");
      },
      async health() { return { ok: true }; }
    });
    const gateway = new ModelGateway(pool, credentials, registry,
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0 } }));
    for (const maxOutputTokens of [0, -3, NaN, Infinity, 1.5, 32769]) {
      await expect(gateway.execute({
        requestId: randomUUID(), organizationId, projectId, orderId, taskId,
        agentRole: "DEVELOPER", prompt: "Safe cap",
        targets: [{ provider: "openai", model: "test" }], maxOutputTokens
      })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(paidCalls).toBe(0);
  });

  it("rejects invalid paid-call retry and timeout budgets before any provider execution", async () => {
    let calls = 0;
    const registry = new ProviderRegistry().register({
      provider: "openai",
      async execute() {
        calls += 1;
        throw new Error("provider must not be called for invalid limits");
      },
      async health() { return { ok: true }; }
    });
    const gateway = new ModelGateway(
      pool, credentials, registry,
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0 } })
    );
    const base = {
      organizationId, projectId, orderId, taskId,
      agentRole: "DEVELOPER", prompt: "Validate budgets",
      targets: [{ provider: "openai" as const, model: "gpt-test" }]
    };
    for (const maxRetries of [Infinity, NaN, -1, 0.5, 6]) {
      await expect(gateway.execute({ ...base, requestId: randomUUID(), maxRetries }))
        .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    for (const timeoutMs of [Infinity, NaN, 0, -5, 1.5, 300_001]) {
      await expect(gateway.execute({ ...base, requestId: randomUUID(), timeoutMs }))
        .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(calls).toBe(0);
  });

  it("records retries, fallback, normalized usage and CHF cost", async () => {
    await credentials.configure(organizationId, "deepseek", "ds-test-secret-5678", userId);

    let deepSeekAttempts = 0;
    const deepseek: ProviderAdapter = {
      provider: "deepseek",
      async execute() {
        deepSeekAttempts += 1;
        throw new ModelGatewayError(
          "PROVIDER_HTTP_ERROR",
          "temporary upstream failure",
          true,
          503
        );
      },
      async health() {
        return { ok: true };
      }
    };

    const openai: ProviderAdapter = {
      provider: "openai",
      async execute() {
        return {
          content: "gateway-ok",
          usage: plainUsage(1000, 500),
          finishReason: "completed"
        };
      },
      async health() {
        return { ok: true };
      }
    };

    const registry = new ProviderRegistry().register(deepseek).register(openai);
    const pricing = new PricingCatalog({
      "deepseek:*": { inputPerMillionChf: 1, outputPerMillionChf: 2, cacheReadPerMillionChf: 0 },
      "openai:*": { inputPerMillionChf: 2, outputPerMillionChf: 4, cacheReadPerMillionChf: 0 }
    });
    const gateway = new ModelGateway(pool, credentials, registry, pricing);
    const requestId = randomUUID();

    const result = await gateway.execute({
      requestId,
      organizationId,
      projectId,
      orderId,
      taskId,
      agentRole: "DEVELOPER",
      prompt: "Implement the requested change",
      targets: [
        { provider: "deepseek", model: "deepseek-test" },
        { provider: "openai", model: "openai-test" }
      ],
      maxRetries: 1,
      timeoutMs: 5_000
    });

    expect(deepSeekAttempts).toBe(2);
    expect(result).toMatchObject({
      provider: "openai",
      attempts: 1,
      fallbackFrom: "deepseek",
      content: "gateway-ok"
    });
    expect(result.estimatedCostChf).toBeCloseTo(0.004);

    const calls = await pool.query(
      `SELECT provider, outcome, attempt_count, fallback_from, error_code
         FROM model_provider_calls
        WHERE request_id = $1`,
      [requestId]
    );
    expect(calls.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "deepseek",
        outcome: "FAILED",
        attempt_count: 2,
        error_code: "PROVIDER_HTTP_ERROR"
      }),
      expect.objectContaining({
        provider: "openai",
        outcome: "SUCCESS",
        attempt_count: 1,
        fallback_from: "deepseek"
      })
    ]));

    const cost = await pool.query(
      "SELECT currency, amount, usage FROM cost_events WHERE usage->>'requestId' = $1",
      [requestId]
    );
    expect(cost.rows[0].currency).toBe("CHF");
    expect(Number(cost.rows[0].amount)).toBeCloseTo(0.004);
    expect(cost.rows[0].usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 500,
      attempts: 1,
      fallbackFrom: "deepseek"
    });
  });

  it("continues to a fallback when an earlier provider has no adapter", async () => {
    await credentials.configure(organizationId, "qwen", "qwen-test-secret-9999", userId);

    const openai: ProviderAdapter = {
      provider: "openai",
      async execute() {
        return {
          content: "fallback-after-unregistered",
          usage: plainUsage(10, 5)
        };
      },
      async health() {
        return { ok: true };
      }
    };
    const gateway = new ModelGateway(
      pool,
      credentials,
      new ProviderRegistry().register(openai),
      new PricingCatalog({
        "qwen:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 },
        "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0 }
      })
    );
    const requestId = randomUUID();

    const result = await gateway.execute({
      requestId,
      organizationId,
      projectId,
      orderId,
      taskId,
      agentRole: "DEVELOPER",
      prompt: "Fallback from unsupported adapter",
      targets: [
        { provider: "qwen", model: "qwen-test" },
        { provider: "openai", model: "openai-test" }
      ]
    });

    expect(result).toMatchObject({
      provider: "openai",
      fallbackFrom: "qwen",
      content: "fallback-after-unregistered"
    });

    const blocked = await pool.query(
      `SELECT outcome, error_code
         FROM model_provider_calls
        WHERE request_id = $1 AND provider = 'qwen'`,
      [requestId]
    );
    expect(blocked.rows[0]).toMatchObject({
      outcome: "BLOCKED",
      error_code: "PROVIDER_NOT_REGISTERED"
    });
  });

  it("rejects cross-tenant entity ownership before contacting a provider", async () => {
    const otherOrganizationId = randomUUID();
    const otherProjectId = randomUUID();
    const otherRepositoryId = randomUUID();
    const otherTaskId = randomUUID();
    let calls = 0;

    await pool.query(
      "INSERT INTO organizations (id, name) VALUES ($1, 'Other Org')",
      [otherOrganizationId]
    );
    await pool.query(
      "INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Other Project')",
      [otherProjectId, otherOrganizationId]
    );
    await pool.query(
      "INSERT INTO repositories (id, project_id, full_name, role) VALUES ($1, $2, $3, $4)",
      [otherRepositoryId, otherProjectId, "other/tenant-repository", "backend"]
    );
    await pool.query(
      "INSERT INTO tasks (id, project_id, repository_id, title) VALUES ($1, $2, $3, 'Other Task')",
      [otherTaskId, otherProjectId, otherRepositoryId]
    );

    const registry = new ProviderRegistry().register({
      provider: "openai",
      async execute() {
        calls += 1;
        return {
          content: "must-not-run",
          usage: plainUsage(1, 1)
        };
      },
      async health() {
        return { ok: true };
      }
    });

    const gateway = new ModelGateway(
      pool,
      credentials,
      registry,
      new PricingCatalog({
        "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0 }
      })
    );

    await expect(
      gateway.execute({
        requestId: randomUUID(),
        organizationId,
        projectId: otherProjectId,
        taskId: otherTaskId,
        agentRole: "DEVELOPER",
        prompt: "Must be blocked before paid call",
        targets: [{ provider: "openai", model: "openai-test" }]
      })
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    expect(calls).toBe(0);

    // Owner-only disposable teardown; never grant runtime TRUNCATE.
    await pool.query("TRUNCATE task_state_history");
    await pool.query("DELETE FROM tasks WHERE id = $1", [otherTaskId]);
    await pool.query("DELETE FROM repositories WHERE id = $1", [otherRepositoryId]);
    await pool.query("DELETE FROM projects WHERE id = $1", [otherProjectId]);
    await pool.query("DELETE FROM organizations WHERE id = $1", [otherOrganizationId]);
  });

  it("blocks a paid call when pricing is not configured", async () => {
    const registry = new ProviderRegistry().register({
      provider: "openai",
      async execute() {
        throw new Error("must not execute");
      },
      async health() {
        return { ok: true };
      }
    });
    const gateway = new ModelGateway(pool, credentials, registry, new PricingCatalog());

    await expect(gateway.execute({
      requestId: randomUUID(),
      organizationId,
      projectId,
      orderId,
      taskId,
      agentRole: "DEVELOPER",
      prompt: "No unpriced calls",
      targets: [{ provider: "openai", model: "unpriced-model" }]
    })).rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
  });
});

describe("PLT-052 gateway cache accounting", () => {
  const baseRequest = () => ({
    requestId: randomUUID(), organizationId, projectId, orderId, taskId,
    agentRole: "DEVELOPER", prompt: "Cache accounting"
  });
  const adapterReturning = (
    provider: "openai" | "deepseek", usage: ReturnType<typeof plainUsage>, counter: { calls: number }
  ): ProviderAdapter => ({
    provider,
    async execute() {
      counter.calls += 1;
      return { content: "ok", usage };
    },
    async health() { return { ok: true }; }
  });
  const callRow = async (requestId: string) => (await pool.query(
    "SELECT * FROM model_provider_calls WHERE request_id = $1", [requestId]
  )).rows[0];

  it("blocks OpenAI and DeepSeek without a cache read rate before any call", async () => {
    await credentials.configure(organizationId, "openai", "sk-cache-test-secret-1111", userId);
    await credentials.configure(organizationId, "deepseek", "ds-cache-test-secret-2222", userId);
    for (const provider of ["openai", "deepseek"] as const) {
      const counter = { calls: 0 };
      const gateway = new ModelGateway(
        pool, credentials,
        new ProviderRegistry().register(adapterReturning(provider, plainUsage(1, 1), counter)),
        new PricingCatalog({ [`${provider}:*`]: { inputPerMillionChf: 1, outputPerMillionChf: 1 } })
      );
      const request = { ...baseRequest(), targets: [{ provider, model: "m" }] };
      await expect(gateway.execute(request)).rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
      expect(counter.calls).toBe(0);
      expect(await callRow(request.requestId)).toMatchObject({
        outcome: "BLOCKED", error_code: "PRICING_REQUIRED", attempt_count: 0
      });
    }
  });

  it("persists cache tokens, status, cost without cache and savings", async () => {
    await credentials.configure(organizationId, "deepseek", "ds-cache-test-secret-2222", userId);
    const usage = mapDeepSeekUsage({
      prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000,
      prompt_cache_hit_tokens: 600_000, prompt_cache_miss_tokens: 400_000
    });
    const counter = { calls: 0 };
    const gateway = new ModelGateway(
      pool, credentials,
      new ProviderRegistry().register(adapterReturning("deepseek", usage, counter)),
      new PricingCatalog({
        "deepseek:*": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0.1 }
      }),
      3, 30_000, () => undefined, CachePolicy.fromEnv({ JEV_PROMPT_CACHE: "on" })
    );
    const request = { ...baseRequest(), targets: [{ provider: "deepseek" as const, model: "m" }] };
    const result = await gateway.execute(request);
    expect(result.estimatedCostChf).toBeCloseTo(0.46, 9);
    const row = await callRow(request.requestId);
    expect(row).toMatchObject({
      outcome: "SUCCESS", cache_status: "PARTIAL", cache_write_tokens: "0",
      prefix_project_sha256: null, prefix_task_sha256: null, error_code: null
    });
    expect(row.cache_read_tokens).toBe("600000");
    expect(Number(row.estimated_cost_chf)).toBeCloseTo(0.46, 6);
    expect(Number(row.estimated_cost_without_cache_chf)).toBeCloseTo(1, 6);
    expect(Number(row.estimated_cache_savings_chf)).toBeCloseTo(0.54, 6);
    const cost = await pool.query(
      "SELECT usage FROM cost_events WHERE usage->>'requestId' = $1", [request.requestId]
    );
    expect(cost.rows[0].usage).toMatchObject({
      inputTokens: 400_000, cacheReadTokens: 600_000, cacheWriteTokens: 0, totalInputTokens: 1_000_000
    });
  });

  it("records a NOT_ESTIMABLE response with reason and alert, without a cost event or substitute price", async () => {
    await credentials.configure(organizationId, "openai", "sk-cache-test-secret-1111", userId);
    // Cache write reported by a model whose catalog entry has no write rate.
    const usage = mapOpenAIUsage({
      input_tokens: 100, output_tokens: 1,
      input_tokens_details: { cache_write_tokens: 40 },
      cache_write_tokens_details: { ttl_30m_tokens: 40 }
    });
    const alerts: unknown[] = [];
    const gateway = new ModelGateway(
      pool, credentials,
      new ProviderRegistry().register(adapterReturning("openai", usage, { calls: 0 })),
      new PricingCatalog({
        "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0.1 }
      }),
      3, 30_000, alert => alerts.push(alert), CachePolicy.fromEnv({ JEV_PROMPT_CACHE: "on" })
    );
    const request = { ...baseRequest(), targets: [{ provider: "openai" as const, model: "m" }] };
    const result = await gateway.execute(request);
    expect(result.estimatedCostChf).toBeNull();
    expect(result.costNotEstimableReason).toMatch(/30m write rate/);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ code: "COST_NOT_ESTIMABLE", requestId: request.requestId });
    const row = await callRow(request.requestId);
    expect(row).toMatchObject({
      outcome: "SUCCESS", error_code: "NOT_ESTIMABLE", estimated_cost_chf: null, cache_status: "WRITE"
    });
    expect(row.cache_reason).toMatch(/not estimable/);
    expect(row.cache_write_tokens).toBe("40");
    const cost = await pool.query(
      "SELECT 1 FROM cost_events WHERE usage->>'requestId' = $1", [request.requestId]
    );
    expect(cost.rowCount).toBe(0);
  });

  it("blocks with PROMPT_TOO_LARGE_FOR_TIER before calling when the prompt exceeds the tier", async () => {
    await credentials.configure(organizationId, "openai", "sk-cache-test-secret-1111", userId);
    const counter = { calls: 0 };
    const gateway = new ModelGateway(
      pool, credentials,
      new ProviderRegistry().register(adapterReturning("openai", plainUsage(1, 1), counter)),
      new PricingCatalog({
        "openai:tier": {
          inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0.1,
          maxPromptTokens: 1_000
        }
      })
    );
    const big = { ...baseRequest(), prompt: "x".repeat(2_001),
      targets: [{ provider: "openai" as const, model: "tier" }] };
    await expect(gateway.execute(big)).rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
    expect(counter.calls).toBe(0);
    expect(await callRow(big.requestId)).toMatchObject({
      outcome: "BLOCKED", error_code: "PROMPT_TOO_LARGE_FOR_TIER"
    });
    const small = { ...baseRequest(), prompt: "x".repeat(2_000),
      targets: [{ provider: "openai" as const, model: "tier" }] };
    await expect(gateway.execute(small)).resolves.toMatchObject({ provider: "openai" });
    expect(counter.calls).toBe(1);
  });
});

describe("PLT-052 cache switch and safe failure", () => {
  const rates = {
    "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0.1 },
    "deepseek:*": { inputPerMillionChf: 1, outputPerMillionChf: 1, cacheReadPerMillionChf: 0.1 }
  };
  const request = () => ({
    requestId: randomUUID(), organizationId, projectId, orderId, taskId,
    agentRole: "DEVELOPER", prompt: "Cache switch",
    targets: [{ provider: "openai" as const, model: "m" }]
  });
  const rows = async (requestId: string) => (await pool.query(
    "SELECT * FROM model_provider_calls WHERE request_id = $1 ORDER BY created_at, attempt_count", [requestId]
  )).rows;
  const costs = async (requestId: string) => (await pool.query(
    "SELECT amount FROM cost_events WHERE usage->>'requestId' = $1", [requestId]
  )).rows;

  // Simulated adapter with explicit cache marks: no network at all.
  function explicitAdapter(script: Array<(cacheEnabled: boolean | undefined) => void>) {
    const seen: Array<boolean | undefined> = [];
    const adapter: ProviderAdapter = {
      provider: "openai",
      cacheSupport: { mode: "explicit", ttls: ["5m"], minPrefixTokens: () => undefined, billsWrite: true },
      async execute(_key, input) {
        seen.push(input.cache?.enabled);
        script[Math.min(seen.length - 1, script.length - 1)]?.(input.cache?.enabled);
        return { content: "ok", usage: plainUsage(10, 5) };
      },
      async health() { return { ok: true }; }
    };
    return { adapter, seen };
  }
  const reject = (status: number, message: string, retryable = false) => () => {
    throw new ModelGatewayError("PROVIDER_HTTP_ERROR", message, retryable, status);
  };
  const gatewayFor = (adapter: ProviderAdapter, policy: CachePolicy, pricing: Record<string, PriceRate> = rates) =>
    new ModelGateway(
      pool, credentials, new ProviderRegistry().register(adapter),
      new PricingCatalog(pricing), 3, 30_000, () => undefined, policy
    );
  const on = () => CachePolicy.fromEnv({ JEV_PROMPT_CACHE: "on" });
  const withCachePricing = {
    "openai:*": { ...rates["openai:*"], cacheWrite5mPerMillionChf: 1.25 }
  };

  it("records DISABLED, sends no cache marks, and says automatic caches stay active (off by default)", async () => {
    await credentials.configure(organizationId, "openai", "sk-cache-test-secret-1111", userId);
    const { adapter, seen } = explicitAdapter([() => undefined]);
    const req = request();
    // Default policy (not injected) is off.
    await new ModelGateway(pool, credentials, new ProviderRegistry().register(adapter), new PricingCatalog(rates))
      .execute(req);
    expect(seen).toEqual([undefined]); // no cache options at all
    const [row] = await rows(req.requestId);
    expect(row).toMatchObject({ outcome: "SUCCESS", cache_status: "DISABLED" });
    expect(row.cache_reason).toMatch(/JEV_PROMPT_CACHE is off/);

    // Automatic providers: the reason says the provider cache remains active.
    const automatic: ProviderAdapter = {
      provider: "openai",
      cacheSupport: { mode: "automatic", ttls: [], minPrefixTokens: () => undefined, billsWrite: true },
      async execute() { return { content: "ok", usage: mapOpenAIUsage({
        input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 60 } }) }; },
      async health() { return { ok: true }; }
    };
    const req2 = request();
    await gatewayFor(automatic, CachePolicy.fromEnv({ JEV_PROMPT_CACHE: "off" })).execute(req2);
    const [auto] = await rows(req2.requestId);
    expect(auto).toMatchObject({ cache_status: "DISABLED", cache_read_tokens: "60" });
    expect(auto.cache_reason).toMatch(/automatic provider cache cannot be disabled/);
  });

  it("does not mark the cache for a provider outside JEV_PROMPT_CACHE_PROVIDERS", async () => {
    const { adapter, seen } = explicitAdapter([() => undefined]);
    const req = request();
    await gatewayFor(adapter, CachePolicy.fromEnv({
      JEV_PROMPT_CACHE: "on", JEV_PROMPT_CACHE_PROVIDERS: "anthropic"
    })).execute(req);
    expect(seen).toEqual([undefined]);
    expect((await rows(req.requestId))[0]).toMatchObject({ cache_status: "DISABLED" });
  });

  it("with the switch on, marks the cache for an explicit adapter and keeps the observed status", async () => {
    const { adapter, seen } = explicitAdapter([() => undefined]);
    const req = request();
    await gatewayFor(adapter, on(), withCachePricing).execute(req);
    expect(seen).toEqual([true]);
    expect((await rows(req.requestId))[0]).toMatchObject({ outcome: "SUCCESS", cache_status: null });
  });

  it("retries ONCE without cache after a cache-attributable 400, records ERROR and both attempts", async () => {
    const { adapter, seen } = explicitAdapter([
      reject(400, "cache_control: invalid ttl for breakpoint"), () => undefined
    ]);
    const req = { ...request(), maxRetries: 0 };
    const result = await gatewayFor(adapter, on(), withCachePricing).execute(req);
    expect(seen).toEqual([true, false]);
    expect(result.attempts).toBe(2);
    const recorded = await rows(req.requestId);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({
      outcome: "FAILED", attempt_count: 1, error_code: "PROVIDER_HTTP_ERROR",
      cache_status: "ERROR", estimated_cost_chf: null
    });
    expect(recorded[0].cache_reason).toMatch(/rejected the cache marks \(HTTP 400\)/);
    expect(recorded[1]).toMatchObject({ outcome: "SUCCESS", attempt_count: 2, cache_status: "ERROR" });
    expect(recorded[1].cache_reason).toMatch(/retried once without cache/);
    // Only the billed (second) attempt has a cost event: exactly one, never duplicated.
    expect(await costs(req.requestId)).toHaveLength(1);
  });

  it("propagates the second failure and never retries without cache twice", async () => {
    const { adapter, seen } = explicitAdapter([
      reject(400, "cache_control rejected"), reject(400, "cache_control rejected again")
    ]);
    const req = { ...request(), maxRetries: 3 };
    await expect(gatewayFor(adapter, on(), withCachePricing).execute(req))
      .rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
    expect(seen).toEqual([true, false]);
    const recorded = await rows(req.requestId);
    expect(recorded.map(r => r.outcome)).toEqual(["FAILED", "FAILED"]);
    expect(recorded.every(r => r.cache_status === "ERROR")).toBe(true);
    expect(await costs(req.requestId)).toHaveLength(0);
  });

  it.each([
    ["401", 401, "invalid cache credentials", false],
    ["429", 429, "cache rate limit", true],
    ["500", 500, "cache backend error", true],
    ["unrelated 400", 400, "max_tokens is too large", false]
  ])("does not retry without cache on %s", async (_name, status, message, retryable) => {
    const { adapter, seen } = explicitAdapter([reject(status, message, retryable)]);
    const req = { ...request(), maxRetries: 0 };
    await expect(gatewayFor(adapter, on(), withCachePricing).execute(req))
      .rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
    expect(seen).toEqual([true]);
    const recorded = await rows(req.requestId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].cache_status).toBeNull();
  });

  it("does not retry without cache on a timeout", async () => {
    const { adapter, seen } = explicitAdapter([() => {
      throw new ModelGatewayError("PROVIDER_TIMEOUT", "cache request timed out", true);
    }]);
    const req = { ...request(), maxRetries: 0 };
    await expect(gatewayFor(adapter, on(), withCachePricing).execute(req))
      .rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
    expect(seen).toEqual([true]);
    expect((await rows(req.requestId))[0]).toMatchObject({ outcome: "TIMEOUT", cache_status: null });
  });

  it("never falls back without cache when the cache was not marked (switch off)", async () => {
    const { adapter, seen } = explicitAdapter([reject(400, "cache_control rejected")]);
    const req = { ...request(), maxRetries: 0 };
    await expect(gatewayFor(adapter, CachePolicy.disabled(), withCachePricing).execute(req))
      .rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
    expect(seen).toEqual([undefined]);
  });

  it("after the retry without cache there are no more retries, even with maxRetries left (503)", async () => {
    const { adapter, seen } = explicitAdapter([
      reject(400, "cache_control rejected"), reject(503, "unavailable", true)
    ]);
    const req = { ...request(), maxRetries: 1 }; // the default value
    await expect(gatewayFor(adapter, on(), withCachePricing).execute(req))
      .rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
    expect(seen).toEqual([true, false]);
    const recorded = await rows(req.requestId);
    expect(recorded.map(r => r.attempt_count)).toEqual([1, 2]);
    expect(recorded[1]).toMatchObject({ outcome: "FAILED", cache_status: "ERROR" });
  });

  it("after the retry without cache there are no more retries on a timeout either", async () => {
    const { adapter, seen } = explicitAdapter([
      reject(400, "cache_control rejected"),
      () => { throw new ModelGatewayError("PROVIDER_TIMEOUT", "timed out", true); }
    ]);
    const req = { ...request(), maxRetries: 3 };
    await expect(gatewayFor(adapter, on(), withCachePricing).execute(req)).rejects.toBeDefined();
    expect(seen).toEqual([true, false]);
    expect((await rows(req.requestId))[1]).toMatchObject({ outcome: "TIMEOUT", cache_status: "ERROR" });
  });

  it("the cache retries consume the shared 8-attempt budget (no ninth call)", async () => {
    // 4 targets, maxRetries 2. A: cache 400 + no-cache 503 (2). B: 503 x3 (3).
    // C: cache 400 + no-cache 503 (2). D: only 1 attempt is left (8th) although
    // maxRetries would allow 3; without the cache retries counting, D would run more.
    const { adapter, seen } = explicitAdapter([
      reject(400, "cache_control rejected"), reject(503, "boom", true),
      reject(503, "boom", true), reject(503, "boom", true), reject(503, "boom", true),
      reject(400, "cache_control rejected"), reject(503, "boom", true),
      reject(503, "boom", true)
    ]);
    const req = {
      ...request(), maxRetries: 2,
      targets: ["m1", "m2", "m3", "m4"].map(model => ({ provider: "openai" as const, model }))
    };
    await expect(gatewayFor(adapter, on(), withCachePricing).execute(req))
      .rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
    expect(seen).toHaveLength(8);
    expect(seen).toEqual([true, false, true, true, true, true, false, true]);
  });

  it("records DISABLED on a provider failure with the switch off or the provider outside the list", async () => {
    for (const policy of [
      CachePolicy.disabled(),
      CachePolicy.fromEnv({ JEV_PROMPT_CACHE: "on", JEV_PROMPT_CACHE_PROVIDERS: "anthropic" })
    ]) {
      const { adapter, seen } = explicitAdapter([reject(500, "boom")]);
      const req = { ...request(), maxRetries: 0 };
      await expect(gatewayFor(adapter, policy, withCachePricing).execute(req)).rejects.toBeDefined();
      expect(seen).toEqual([undefined]);
      const [row] = await rows(req.requestId);
      expect(row).toMatchObject({ outcome: "FAILED", cache_status: "DISABLED" });
      expect(row.cache_reason).toBeTruthy();
    }
  });

  it("with the cache on and no cache error, a provider failure keeps cache_status NULL (design does not fix it)", async () => {
    const { adapter } = explicitAdapter([reject(500, "boom")]);
    const req = { ...request(), maxRetries: 0 };
    await expect(gatewayFor(adapter, on(), withCachePricing).execute(req)).rejects.toBeDefined();
    expect((await rows(req.requestId))[0].cache_status).toBeNull();
  });

  it("missing prices still block before any call, with the cache off or on", async () => {
    for (const policy of [CachePolicy.disabled(), on()]) {
      const { adapter, seen } = explicitAdapter([() => undefined]);
      const req = request();
      // Cache read rate missing (openai needs it even with the cache off).
      await expect(gatewayFor(adapter, policy, {
        "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 }
      }).execute(req)).rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
      expect(seen).toEqual([]);
      expect((await rows(req.requestId))[0]).toMatchObject({
        outcome: "BLOCKED", error_code: "PRICING_REQUIRED"
      });
    }
    // With the cache on for an explicit adapter, the read rate is required too.
    const { adapter, seen } = explicitAdapter([() => undefined]);
    const req = request();
    await expect(gatewayFor(adapter, on(), {
      "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 }
    }).execute(req)).rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
    expect(seen).toEqual([]);
  });
});
