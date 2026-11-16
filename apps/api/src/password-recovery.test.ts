import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@jev/auth";
import { createDatabasePool, migrate } from "@jev/db";
import { buildApi } from "./app.js";

const pool = createDatabasePool();
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const userId = randomUUID();
const otherUserId = randomUUID();
const floodUserId = randomUUID();
const raceUserId = randomUUID();
const floodEmail = "flood-target@test.local";
const raceEmail = "race-target@test.local";
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
            ($3, $4, $5, 'Other admin', 'ADMIN', $6),
            ($7, $2, $8, 'Flood target', 'ADMIN', $6),
            ($9, $2, $10, 'Race target', 'ADMIN', $6)`,
    [userId, organizationId, otherUserId, otherOrganizationId, email, hashPassword(originalPassword),
      floodUserId, floodEmail, raceUserId, raceEmail]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM users WHERE id IN ($1, $2, $3, $4)", [userId, otherUserId, floodUserId, raceUserId]);
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
      await expect.poll(() => sent.length).toBe(1);
      // Deterministic one-minute throttle: a second issuance inside the window is refused.
      const throttled = await pool.query(
        "SELECT jev_issue_password_reset($1::uuid, $2::text, $3::text) AS recipient",
        [organizationId, email, "f".repeat(64)]
      );
      expect(throttled.rows[0].recipient).toBeNull();
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

  it("keeps recovery available to an account while anonymous callers flood other keys", async () => {
    const sent: Array<{ recipient: string; link: URL }> = [];
    const app = buildApi({
      pool,
      passwordRecovery: {
        origin: "https://jev.example.test",
        send: async (recipient, url) => { sent.push({ recipient, link: new URL(url) }); }
      }
    });
    try {
      // More than the former shared ceilings (60 requests, 30 resets per minute).
      for (let index = 0; index < 70; index += 1) {
        const flood = await app.inject({
          method: "POST", url: "/auth/password-recovery",
          payload: { organizationId, email: `flood-${index}@test.local` }
        });
        expect(flood.statusCode).toBe(202);
      }
      const target = await app.inject({
        method: "POST", url: "/auth/password-recovery",
        payload: { organizationId, email: floodEmail.toUpperCase() }
      });
      expect(target.statusCode).toBe(202);
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0].recipient).toBe(floodEmail);

      for (let index = 0; index < 40; index += 1) {
        const guess = await app.inject({
          method: "POST", url: "/auth/password-reset",
          payload: { token: randomBytes(32).toString("base64url"), password: replacement }
        });
        expect(guess.statusCode).toBe(400);
      }
      const token = new URLSearchParams(sent[0].link.hash.slice(1)).get("reset")!;
      const applied = await app.inject({
        method: "POST", url: "/auth/password-reset", payload: { token, password: replacement }
      });
      expect(applied.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it("refuses a login verified with the old password once a reset commits first", async () => {
    const app = buildApi({ pool });
    const holder = await pool.connect();
    try {
      const key = (await holder.query<{ high: string; low: string }>(
        `SELECT ((k >> 32) & 4294967295)::text AS high, (k & 4294967295)::text AS low
           FROM (SELECT hashtextextended($1::text, 51) AS k) AS lock_key`, [raceUserId]
      )).rows[0];
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 51))", [raceUserId]);
      const pending = app.inject({
        method: "POST", url: "/auth/login",
        payload: { organizationId, email: raceEmail, password: originalPassword }
      });
      await expect.poll(async () => (await pool.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND classid = $1::bigint::oid AND objid = $2::bigint::oid`, [key.high, key.low]
      )).rows[0].waiting, { timeout: 5_000 }).toBe(1);
      await holder.query("UPDATE users SET password_hash = $2 WHERE id = $1",
        [raceUserId, hashPassword(replacement)]);
      await holder.query("COMMIT");
      expect((await pending).statusCode).toBe(401);
      const sessions = await pool.query("SELECT 1 FROM auth_sessions WHERE user_id = $1", [raceUserId]);
      expect(sessions.rowCount).toBe(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await app.close();
    }
  });
});
