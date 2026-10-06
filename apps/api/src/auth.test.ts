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
