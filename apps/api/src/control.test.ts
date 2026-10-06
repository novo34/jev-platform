import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { hashPassword } from "@jev/auth";
import { buildApi } from "./app.js";

const pool = createDatabasePool();
const organizationId = randomUUID();
const userId = randomUUID();
const projectId = randomUUID();
const password = "api-control-password-123";

beforeAll(async () => {
  await migrate(pool);
  await pool.query(
    "INSERT INTO organizations (id, name) VALUES ($1, 'API Control Org')",
    [organizationId]
  );
  await pool.query(
    `INSERT INTO users
      (id, organization_id, email, display_name, role, password_hash)
     VALUES ($1, $2, 'api-control@test.local', 'API Control', 'ADMIN', $3)`,
    [userId, organizationId, hashPassword(password)]
  );
  await pool.query(
    "INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'API Project')",
    [projectId, organizationId]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_events WHERE organization_id = $1", [
    organizationId
  ]);
  await pool.query("DELETE FROM orders WHERE project_id = $1", [projectId]);
  await pool.query("DELETE FROM auth_sessions WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
  await pool.end();
});

async function authenticatedApp() {
  const app = buildApi({ pool });

  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      organizationId,
      email: "api-control@test.local",
      password
    }
  });

  return {
    app,
    token: response.json().token as string
  };
}

describe("control API", () => {
  it("maps an authenticated API request to a Control Layer command", async () => {
    const { app, token } = await authenticatedApp();
    const commandId = randomUUID();

    const response = await app.inject({
      method: "POST",
      url: "/control/commands",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        commandId,
        action: "CREATE_ORDER",
        projectId,
        payload: {
          objective: "API to control layer",
          acceptanceCriteria: ["mapped"]
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      commandId,
      action: "CREATE_ORDER"
    });

    const audit = await pool.query(
      "SELECT result FROM audit_events WHERE evidence->>'commandId' = $1",
      [commandId]
    );
    expect(audit.rows[0].result).toBe("SUCCESS");

    await app.close();
  });

  it("returns a stable unauthenticated error contract", async () => {
    const app = buildApi({ pool });

    const response = await app.inject({
      method: "POST",
      url: "/control/commands",
      payload: {
        action: "GET_PROJECT_STATUS",
        projectId
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "UNAUTHENTICATED",
        message: "authentication required"
      }
    });

    await app.close();
  });
});
