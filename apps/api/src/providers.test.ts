import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { hashPassword } from "@jev/auth";
import { ProviderRegistry } from "@jev/model-gateway";
import { buildApi } from "./app.js";

const pool = createDatabasePool();
const organizationId = randomUUID();
const adminId = randomUUID();
const developerId = randomUUID();
const password = "provider-admin-password-123";
const encryptionKey = randomBytes(32).toString("base64");

const registry = new ProviderRegistry()
  .register({
    provider: "openai",
    async execute() {
      return {
        content: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
      };
    },
    async health(apiKey) {
      return { ok: apiKey.endsWith("ABCD"), latencyMs: 1 };
    }
  })
  .register({
    provider: "deepseek",
    async execute() {
      return {
        content: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
      };
    },
    async health() {
      return { ok: true };
    }
  });

beforeAll(async () => {
  await migrate(pool);
  await pool.query(
    "INSERT INTO organizations (id, name) VALUES ($1, 'Provider API Org')",
    [organizationId]
  );
  const passwordHash = hashPassword(password);
  await pool.query(
    `INSERT INTO users
      (id, organization_id, email, display_name, role, password_hash)
     VALUES
      ($1, $3, 'provider-admin@test.local', 'Provider Admin', 'ADMIN', $4),
      ($2, $3, 'provider-dev@test.local', 'Provider Developer', 'DEVELOPER', $4)`,
    [adminId, developerId, organizationId, passwordHash]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_events WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM provider_credentials WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM auth_sessions WHERE user_id IN ($1, $2)", [adminId, developerId]);
  await pool.query("DELETE FROM users WHERE id IN ($1, $2)", [adminId, developerId]);
  await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
  await pool.end();
});

async function tokenFor(email: string): Promise<string> {
  const app = buildApi({
    pool,
    providerEncryptionKey: encryptionKey,
    providerRegistry: registry
  });
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { organizationId, email, password }
  });
  await app.close();
  return response.json().token as string;
}

describe("provider credential API", () => {
  it("returns 401 when provider metadata is requested without authentication", async () => {
    const app = buildApi({
      pool,
      providerEncryptionKey: encryptionKey,
      providerRegistry: registry
    });

    const response = await app.inject({ method: "GET", url: "/providers" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "UNAUTHENTICATED" });
    await app.close();
  });

  it("allows ADMIN lifecycle operations without exposing the secret", async () => {
    const token = await tokenFor("provider-admin@test.local");
    const app = buildApi({
      pool,
      providerEncryptionKey: encryptionKey,
      providerRegistry: registry
    });

    const configured = await app.inject({
      method: "PUT",
      url: "/providers/openai/credential",
      headers: { authorization: `Bearer ${token}` },
      payload: { apiKey: "sk-secret-value-ABCD" }
    });
    expect(configured.statusCode).toBe(200);
    expect(JSON.stringify(configured.json())).not.toContain("sk-secret-value-ABCD");
    expect(configured.json()).toMatchObject({
      provider: "openai",
      configured: true,
      lastFour: "ABCD"
    });

    const listed = await app.inject({
      method: "GET",
      url: "/providers",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.json())).not.toContain("sk-secret-value-ABCD");

    const tested = await app.inject({
      method: "POST",
      url: "/providers/openai/test",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ provider: "openai", ok: true });

    const replaced = await app.inject({
      method: "PUT",
      url: "/providers/openai/credential",
      headers: { authorization: `Bearer ${token}` },
      payload: { apiKey: "sk-rotated-value-ABCD" }
    });
    expect(replaced.statusCode).toBe(200);

    const removed = await app.inject({
      method: "DELETE",
      url: "/providers/openai/credential",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(removed.statusCode).toBe(204);

    await app.close();
  });

  it("rejects non-admin credential changes", async () => {
    const token = await tokenFor("provider-dev@test.local");
    const app = buildApi({
      pool,
      providerEncryptionKey: encryptionKey,
      providerRegistry: registry
    });

    const response = await app.inject({
      method: "PUT",
      url: "/providers/openai/credential",
      headers: { authorization: `Bearer ${token}` },
      payload: { apiKey: "sk-forbidden-value-ABCD" }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "FORBIDDEN" });
    await app.close();
  });
});
