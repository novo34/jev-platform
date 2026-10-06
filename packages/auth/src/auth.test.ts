import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "@jev/db";
import { migrate } from "@jev/db/migrations";
import {
  AuthError,
  authenticateToken,
  authorizeProject,
  hashPassword,
  login,
  logout
} from "./index.js";

const pool = createDatabasePool();
const password = "correct-horse-battery-staple";
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const adminId = randomUUID();
const developerId = randomUUID();
const clientId = randomUUID();
const projectA = randomUUID();
const projectB = randomUUID();
const otherProject = randomUUID();

beforeAll(async () => {
  await migrate(pool);

  const hash = hashPassword(password);

  await pool.query(
    "INSERT INTO organizations (id, name) VALUES ($1, $2), ($3, $4)",
    [organizationId, "Auth Org", otherOrganizationId, "Other Org"]
  );
  await pool.query(
    `INSERT INTO users
      (id, organization_id, email, display_name, role, password_hash)
     VALUES
      ($1, $2, 'admin@test.local', 'Admin', 'ADMIN', $3),
      ($4, $2, 'dev@test.local', 'Developer', 'DEVELOPER', $3),
      ($5, $2, 'client@test.local', 'Client', 'CLIENT', $3)`,
    [adminId, organizationId, hash, developerId, clientId]
  );
  await pool.query(
    `INSERT INTO projects (id, organization_id, name)
     VALUES ($1, $2, 'Project A'), ($3, $2, 'Project B'), ($4, $5, 'Other Project')`,
    [projectA, organizationId, projectB, otherProject, otherOrganizationId]
  );
  await pool.query(
    `INSERT INTO project_memberships (project_id, user_id, role)
     VALUES ($1, $2, 'DEVELOPER'), ($1, $3, 'CLIENT')`,
    [projectA, developerId, clientId]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM organizations WHERE id IN ($1, $2)", [
    organizationId,
    otherOrganizationId
  ]);
  await pool.end();
});

describe("human authentication", () => {
  it("authenticates a human user and resolves an opaque session token", async () => {
    const result = await login(pool, {
      organizationId,
      email: "admin@test.local",
      password
    });

    expect(result.token.length).toBeGreaterThan(30);
    expect(result.user.role).toBe("ADMIN");

    const authenticated = await authenticateToken(pool, result.token);
    expect(authenticated.id).toBe(adminId);

    await logout(pool, authenticated.sessionId);

    await expect(authenticateToken(pool, result.token)).rejects.toMatchObject({
      code: "UNAUTHENTICATED"
    });
  });

  it("rejects invalid credentials", async () => {
    await expect(
      login(pool, {
        organizationId,
        email: "admin@test.local",
        password: "wrong-password"
      })
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });
});

describe("server-side project RBAC", () => {
  it("allows admin only inside its organization", async () => {
    const { user } = await login(pool, {
      organizationId,
      email: "admin@test.local",
      password
    });

    await expect(authorizeProject(pool, user, projectA, "project:admin")).resolves.toBeUndefined();
    await expect(authorizeProject(pool, user, otherProject, "project:read")).rejects.toMatchObject({
      code: "FORBIDDEN"
    });
  });

  it("requires explicit project membership for developer scope", async () => {
    const { user } = await login(pool, {
      organizationId,
      email: "dev@test.local",
      password
    });

    await expect(authorizeProject(pool, user, projectA, "project:write")).resolves.toBeUndefined();
    await expect(authorizeProject(pool, user, projectB, "project:read")).rejects.toMatchObject({
      code: "FORBIDDEN"
    });
  });

  it("gives clients read-only access only to explicitly assigned projects", async () => {
    const { user } = await login(pool, {
      organizationId,
      email: "client@test.local",
      password
    });

    await expect(authorizeProject(pool, user, projectA, "project:read")).resolves.toBeUndefined();
    await expect(authorizeProject(pool, user, projectA, "project:write")).rejects.toBeInstanceOf(AuthError);
    await expect(authorizeProject(pool, user, projectB, "project:read")).rejects.toMatchObject({
      code: "FORBIDDEN"
    });
  });
});
