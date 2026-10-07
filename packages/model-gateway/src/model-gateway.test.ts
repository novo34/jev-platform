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
    `INSERT INTO orders (id, project_id, author_user_id, objective)
     VALUES ($1, $2, $3, 'Gateway order')`,
    [orderId, projectId, userId]
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, order_id, title)
     VALUES ($1, $2, $3, 'Gateway task')`,
    [taskId, projectId, orderId]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM model_provider_calls WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM cost_events WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM audit_events WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM provider_credentials WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM tasks WHERE project_id = $1", [projectId]);
  await pool.query("DELETE FROM orders WHERE project_id = $1", [projectId]);
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

describe("ModelGateway", () => {
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
