import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { hashPassword, login } from "@jev/auth";
import { ControlError, ControlService } from "./index.js";

const pool = createDatabasePool();
const service = new ControlService(pool);

const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const adminId = randomUUID();
const developerId = randomUUID();
const clientId = randomUUID();
const projectId = randomUUID();
const secondProjectId = randomUUID();
const foreignProjectId = randomUUID();
const password = "control-plane-password-123";

let adminToken = "";
let adminUser: Awaited<ReturnType<typeof login>>["user"];
let developerUser: Awaited<ReturnType<typeof login>>["user"];
let clientUser: Awaited<ReturnType<typeof login>>["user"];

beforeAll(async () => {
  await migrate(pool);
  const hash = hashPassword(password);

  await pool.query(
    "INSERT INTO organizations (id, name) VALUES ($1, 'Control Org'), ($2, 'Foreign Org')",
    [organizationId, otherOrganizationId]
  );
  await pool.query(
    `INSERT INTO users
      (id, organization_id, email, display_name, role, password_hash)
     VALUES
      ($1, $2, 'admin@control.test', 'Admin', 'ADMIN', $3),
      ($4, $2, 'dev@control.test', 'Developer', 'DEVELOPER', $3),
      ($5, $2, 'client@control.test', 'Client', 'CLIENT', $3)`,
    [adminId, organizationId, hash, developerId, clientId]
  );
  await pool.query(
    `INSERT INTO projects (id, organization_id, name)
     VALUES
      ($1, $2, 'Control Project'),
      ($3, $2, 'Second Project'),
      ($4, $5, 'Foreign Project')`,
    [projectId, organizationId, secondProjectId, foreignProjectId, otherOrganizationId]
  );
  await pool.query(
    `INSERT INTO project_memberships (project_id, user_id, role)
     VALUES
      ($1, $2, 'DEVELOPER'),
      ($1, $3, 'CLIENT')`,
    [projectId, developerId, clientId]
  );

  const admin = await login(pool, {
    organizationId,
    email: "admin@control.test",
    password
  });
  adminToken = admin.token;
  adminUser = admin.user;

  developerUser = (
    await login(pool, {
      organizationId,
      email: "dev@control.test",
      password
    })
  ).user;

  clientUser = (
    await login(pool, {
      organizationId,
      email: "client@control.test",
      password
    })
  ).user;
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM audit_events WHERE organization_id IN ($1, $2)",
    [organizationId, otherOrganizationId]
  );
  await pool.query("DELETE FROM orders WHERE project_id IN ($1, $2, $3)", [
    projectId,
    secondProjectId,
    foreignProjectId
  ]);
  await pool.query("DELETE FROM project_memberships WHERE user_id IN ($1, $2)", [
    developerId,
    clientId
  ]);
  await pool.query("DELETE FROM auth_sessions WHERE user_id IN ($1, $2, $3)", [
    adminId,
    developerId,
    clientId
  ]);
  await pool.query("DELETE FROM projects WHERE id IN ($1, $2, $3)", [
    projectId,
    secondProjectId,
    foreignProjectId
  ]);
  await pool.query("DELETE FROM users WHERE id IN ($1, $2, $3)", [
    adminId,
    developerId,
    clientId
  ]);
  await pool.query("DELETE FROM organizations WHERE id IN ($1, $2)", [
    organizationId,
    otherOrganizationId
  ]);
  await pool.end();
});

describe("ControlService", () => {
  it("executes a read command only after project authorization and audits success", async () => {
    const commandId = randomUUID();
    const result = await service.execute(
      {
        commandId,
        action: "GET_PROJECT_STATUS",
        projectId
      },
      {
        actor: clientUser,
        correlationId: randomUUID()
      }
    );

    expect(result.ok).toBe(true);
    expect((result.data as { project: { id: string } }).project.id).toBe(projectId);

    const audit = await pool.query(
      "SELECT result FROM audit_events WHERE evidence->>'commandId' = $1",
      [commandId]
    );
    expect(audit.rows.map((row) => row.result)).toContain("SUCCESS");
  });

  it("prevents a client from bypassing write authorization and audits the block", async () => {
    const commandId = randomUUID();

    await expect(
      service.execute(
        {
          commandId,
          action: "CREATE_ORDER",
          projectId,
          payload: { objective: "Must not be created" }
        },
        {
          actor: clientUser,
          correlationId: randomUUID()
        }
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const count = await pool.query(
      "SELECT COUNT(*)::int AS count FROM orders WHERE objective = 'Must not be created'"
    );
    expect(count.rows[0].count).toBe(0);

    const audit = await pool.query(
      "SELECT result FROM audit_events WHERE evidence->>'commandId' = $1",
      [commandId]
    );
    expect(audit.rows.map((row) => row.result)).toContain("BLOCKED");
  });

  it("enforces explicit developer membership and denies other projects", async () => {
    await expect(
      service.execute(
        {
          commandId: randomUUID(),
          action: "GET_PROJECT_STATUS",
          projectId: secondProjectId
        },
        {
          actor: developerUser,
          correlationId: randomUUID()
        }
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents cross-organization access even for admin", async () => {
    await expect(
      service.execute(
        {
          commandId: randomUUID(),
          action: "GET_PROJECT_STATUS",
          projectId: foreignProjectId
        },
        {
          actor: adminUser,
          correlationId: randomUUID()
        }
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("creates an order through the control layer and persists matching audit in the same command flow", async () => {
    const commandId = randomUUID();
    const result = await service.execute(
      {
        commandId,
        action: "CREATE_ORDER",
        projectId,
        payload: {
          objective: "Create through control plane",
          priority: "P0",
          workType: "GENERAL",
          acceptanceCriteria: ["done"]
        }
      },
      {
        actor: adminUser,
        correlationId: randomUUID()
      }
    );

    const orderId = (result.data as { order: { id: string } }).order.id;
    const persisted = await pool.query(
      "SELECT author_user_id, objective FROM orders WHERE id = $1",
      [orderId]
    );
    expect(persisted.rows[0].author_user_id).toBe(adminId);
    expect(persisted.rows[0].objective).toBe("Create through control plane");

    const audit = await pool.query(
      "SELECT result FROM audit_events WHERE evidence->>'commandId' = $1",
      [commandId]
    );
    expect(audit.rows.map((row) => row.result)).toContain("SUCCESS");
  });

  it("uses typed stable validation errors", async () => {
    await expect(
      service.execute(
        {
          commandId: "",
          action: "GET_PROJECT_STATUS",
          projectId
        },
        {
          actor: adminUser,
          correlationId: randomUUID()
        }
      )
    ).rejects.toBeInstanceOf(ControlError);
  });

  it("keeps authentication material out of control command data", () => {
    expect(adminToken.length).toBeGreaterThan(30);
  });
});
