import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import {
  ModelGateway,
  ModelGatewayError,
  PricingCatalog,
  ProviderCredentialStore,
  ProviderRegistry,
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
      "openai:*": { inputPerMillionChf: 1_000_000, outputPerMillionChf: 0 }
    });
    expect(() => priced.estimateChf("openai", "test", {
      inputTokens: 100_000_000, outputTokens: 0, totalTokens: 100_000_000
    })).toThrowError(ModelGatewayError);
    expect(new PricingCatalog({ "openai:*": { inputPerMillionChf: 0, outputPerMillionChf: 0 } })
      .has("openai", "gpt-test")).toBe(true);
  });
});

describe("ModelGateway", () => {
  it("rejects excessive or duplicate targets before contacting a provider", async () => {
    const gateway = new ModelGateway(pool, credentials, new ProviderRegistry(),
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 } }));
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
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 } }));
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
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 } }));
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
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 } }));
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
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }
        };
      },
      async health() { return { ok: true }; }
    });
    const gateway = new ModelGateway(pool, credentials, registry,
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 } }));
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
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 } }));
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
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 } }));
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
      new PricingCatalog({ "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 } })
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
          usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
          finishReason: "completed"
        };
      },
      async health() {
        return { ok: true };
      }
    };

    const registry = new ProviderRegistry().register(deepseek).register(openai);
    const pricing = new PricingCatalog({
      "deepseek:*": { inputPerMillionChf: 1, outputPerMillionChf: 2 },
      "openai:*": { inputPerMillionChf: 2, outputPerMillionChf: 4 }
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
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
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
        "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 }
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
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
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
        "openai:*": { inputPerMillionChf: 1, outputPerMillionChf: 1 }
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
