import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@jev/auth";
import { createDatabasePool, migrate } from "@jev/db";
import { buildApi } from "./app.js";

const pool = createDatabasePool();
const organizationId = randomUUID();
const userId = randomUUID();
const password = "api-auth-password-123";

beforeAll(async () => {
  await migrate(pool);
  await pool.query(
    "INSERT INTO organizations (id, name) VALUES ($1, $2)",
    [organizationId, "API Auth Org"]
  );
  await pool.query(
    `INSERT INTO users
      (id, organization_id, email, display_name, role, password_hash)
     VALUES ($1, $2, $3, $4, 'ADMIN', $5)`,
    [
      userId,
      organizationId,
      "api-owner@test.local",
      "API Owner",
      hashPassword(password)
    ]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM auth_sessions WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
  await pool.end();
});

describe("auth HTTP routes", () => {
  it("logs in, authenticates bearer token and logs out", async () => {
    const app = buildApi({ pool });

    const loginResponse = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        organizationId,
        email: "api-owner@test.local",
        password
      }
    });

    expect(loginResponse.statusCode).toBe(200);
    const loginBody = loginResponse.json();
    expect(loginBody.user.id).toBe(userId);

    const meResponse = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: {
        authorization: `Bearer ${loginBody.token}`
      }
    });

    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json().user.role).toBe("ADMIN");

    const logoutResponse = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        authorization: `Bearer ${loginBody.token}`
      }
    });

    expect(logoutResponse.statusCode).toBe(204);

    const expiredResponse = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: {
        authorization: `Bearer ${loginBody.token}`
      }
    });

    expect(expiredResponse.statusCode).toBe(401);

    await app.close();
  });

  it("restores browser sessions, rejects CSRF and revokes access on logout", async () => {
    const app = buildApi({ pool });
    try {
      const login = await app.inject({
        method: "POST", url: "/auth/login",
        headers: { "x-jev-browser-session": "1", "sec-fetch-site": "same-origin" },
        payload: { organizationId, email: "api-owner@test.local", password }
      });
      expect(login.statusCode).toBe(200);
      expect(login.json()).toEqual({ user: expect.objectContaining({ id: userId }) });
      const setCookie = String(login.headers["set-cookie"]);
      expect(setCookie).toMatch(/^__Host-jev_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
      const cookie = setCookie.split(";")[0];
      const me = () => app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
      expect((await me()).statusCode).toBe(200);

      for (const headers of [
        { cookie: `${cookie}; ${cookie}` },
        { cookie: "__Host-jev_session=short" },
        { cookie, authorization: "Bearer invalid" }
      ]) {
        expect((await app.inject({ method: "GET", url: "/auth/me", headers })).statusCode).toBe(401);
      }

      for (const headers of [
        { cookie },
        { cookie, "x-jev-browser-session": "1" },
        { cookie, "x-jev-browser-session": "1", "sec-fetch-site": "same-site" }
      ]) {
        for (const url of ["/auth/logout", "/control/commands"]) {
          const denied = await app.inject({
            method: "POST", url, headers,
            ...(url === "/control/commands" ? { payload: { action: "GET_PROJECT_STATUS", projectId: randomUUID() } } : {})
          });
          expect(denied.statusCode).toBe(403);
        }
      }
      expect((await me()).statusCode).toBe(200);

      const logout = await app.inject({
        method: "POST", url: "/auth/logout",
        headers: { cookie, "x-jev-browser-session": "1", "sec-fetch-site": "same-origin" }
      });
      expect(logout.statusCode).toBe(204);
      expect(String(logout.headers["set-cookie"])).toBe("__Host-jev_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
      expect((await me()).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("rejects expired browser cookies through the existing session lookup", async () => {
    const app = buildApi({ pool });
    try {
      const login = await app.inject({
        method: "POST", url: "/auth/login",
        headers: { "x-jev-browser-session": "1", "sec-fetch-site": "same-origin" },
        payload: { organizationId, email: "api-owner@test.local", password }
      });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers["set-cookie"]).split(";")[0];
      await pool.query("UPDATE auth_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [login.json().user.sessionId]);
      expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("rejects invalid credentials without leaking user existence", async () => {
    const app = buildApi({ pool });

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        organizationId,
        email: "api-owner@test.local",
        password: "not-the-password"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "INVALID_CREDENTIALS" });

    await app.close();
  });
});
