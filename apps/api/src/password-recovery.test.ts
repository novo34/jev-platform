import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@jev/auth";
import { createDatabasePool, migrate } from "@jev/db";
import { buildApi } from "./app.js";

const pool = createDatabasePool();
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const userId = randomUUID();
const otherUserId = randomUUID();
const email = "recovery@test.local";
const originalPassword = "original-test-password";
const replacement = "different-test-password";

beforeAll(async () => {
  await migrate(pool);
  await pool.query("INSERT INTO organizations (id, name) VALUES ($1, 'Recovery test'), ($2, 'Other recovery test')",
    [organizationId, otherOrganizationId]);
  await pool.query(
    `INSERT INTO users (id, organization_id, email, display_name, role, password_hash)
     VALUES ($1, $2, $5, 'Recovery admin', 'ADMIN', $6),
            ($3, $4, $5, 'Other admin', 'ADMIN', $6)`,
    [userId, organizationId, otherUserId, otherOrganizationId, email, hashPassword(originalPassword)]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM users WHERE id IN ($1, $2)", [userId, otherUserId]);
  await pool.query("DELETE FROM organizations WHERE id IN ($1, $2)", [organizationId, otherOrganizationId]);
  await pool.end();
});

describe("password recovery routes", () => {
  it("returns uniform responses, limits delivery, expires links and consumes one link atomically", async () => {
    const sent: Array<{ recipient: string; link: URL }> = [];
    const app = buildApi({
      pool,
      passwordRecovery: {
        origin: "https://jev.example.test",
        send: async (recipient, url) => { sent.push({ recipient, link: new URL(url) }); }
      }
    });
    const request = (requestedEmail: string) => app.inject({
      method: "POST", url: "/auth/password-recovery",
      payload: { organizationId, email: requestedEmail }
    });
    const login = (password: string, org = organizationId) => app.inject({
      method: "POST", url: "/auth/login", payload: { organizationId: org, email, password }
    });
    const reset = (token: string) => app.inject({
      method: "POST", url: "/auth/password-reset", payload: { token, password: replacement }
    });
    try {
      const session = (await login(originalPassword)).json().token;
      const otherSession = (await login(originalPassword, otherOrganizationId)).json().token;
      expect(session).toBeTruthy();
      expect(otherSession).toBeTruthy();

      const missing = await request("missing@test.local");
      const known = await request(email);
      expect(known.statusCode).toBe(202);
      expect(missing.statusCode).toBe(known.statusCode);
      expect(missing.body).toBe(known.body);
      await request(email);
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0].recipient).toBe(email);
      expect(sent[0].link.origin).toBe("https://jev.example.test");
      expect(sent[0].link.search).toBe("");
      const expired = new URLSearchParams(sent[0].link.hash.slice(1)).get("reset")!;
      const tokenHash = createHash("sha256").update(expired).digest("hex");
      const stored = await pool.query("SELECT token_hash FROM password_reset_tokens WHERE user_id = $1", [userId]);
      expect(stored.rows).toEqual([{ token_hash: tokenHash }]);

      expect((await reset("a".repeat(43))).statusCode).toBe(400);
      await pool.query(
        "UPDATE password_reset_tokens SET expires_at = clock_timestamp() - interval '1 second', created_at = clock_timestamp() - interval '2 minutes' WHERE token_hash = $1",
        [tokenHash]
      );
      expect((await reset(expired)).statusCode).toBe(400);
      await request(email);
      await expect.poll(() => sent.length).toBe(2);
      const valid = new URLSearchParams(sent[1].link.hash.slice(1)).get("reset")!;
      const results = await Promise.all([reset(valid), reset(valid)]);
      expect(results.map((response) => response.statusCode).sort()).toEqual([204, 400]);
      expect((await reset(valid)).statusCode).toBe(400);

      const me = (token: string) => app.inject({
        method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` }
      });
      expect((await me(session)).statusCode).toBe(401);
      expect((await me(otherSession)).statusCode).toBe(200);
      expect((await login(originalPassword)).statusCode).toBe(401);
      expect((await login(replacement)).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
