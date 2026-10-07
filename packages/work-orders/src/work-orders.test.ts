import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { WorkOrderError, WorkOrderService } from "./index.js";

const pool = createDatabasePool();
const service = new WorkOrderService(pool);
const organizationId = randomUUID();
const userId = randomUUID();
const projectId = randomUUID();
const repositoryId = randomUUID();
const secondRepositoryId = randomUUID();
const foreignProjectId = randomUUID();
const foreignRepositoryId = randomUUID();

beforeAll(async () => {
  await migrate(pool);
  await pool.query(
    "INSERT INTO organizations (id, name) VALUES ($1, 'Workflow Org')",
    [organizationId]
  );
  await pool.query(
    `INSERT INTO users (id, organization_id, email, display_name, role)
     VALUES ($1, $2, $3, 'Workflow Owner', 'ADMIN')`,
    [userId, organizationId, `workflow-${userId}@test.local`]
  );
  await pool.query(
    "INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Workflow Project')",
    [projectId, organizationId]
  );
  await pool.query(
    `INSERT INTO repositories (
       id, project_id, full_name, role, primary_repository, default_branch, staging_branch
     ) VALUES
       ($1, $3, 'novo34/workflow-main', 'backend', TRUE, 'main', 'staging'),
       ($2, $3, 'novo34/workflow-ui', 'frontend', FALSE, 'main', 'staging')`,
    [repositoryId, secondRepositoryId, projectId]
  );
  await pool.query(
    "INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Foreign Project')",
    [foreignProjectId, organizationId]
  );
  await pool.query(
    `INSERT INTO repositories (
       id, project_id, full_name, role, primary_repository, default_branch, staging_branch
     ) VALUES ($1, $2, 'novo34/foreign', 'backend', TRUE, 'main', 'staging')`,
    [foreignRepositoryId, foreignProjectId]
  );
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM approvals WHERE task_id IN (SELECT id FROM tasks WHERE project_id IN ($1, $2))",
    [projectId, foreignProjectId]
  );
  await pool.query("DELETE FROM tasks WHERE project_id IN ($1, $2)", [projectId, foreignProjectId]);
  await pool.query("DELETE FROM requirements WHERE project_id IN ($1, $2)", [projectId, foreignProjectId]);
  await pool.query("DELETE FROM orders WHERE project_id IN ($1, $2)", [projectId, foreignProjectId]);
  await pool.query("DELETE FROM repositories WHERE project_id IN ($1, $2)", [projectId, foreignProjectId]);
  await pool.query("DELETE FROM projects WHERE id IN ($1, $2)", [projectId, foreignProjectId]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
  await pool.end();
});

describe("WorkOrderService", () => {
  it("persists acceptance criteria, requirements and explicit repository resolution", async () => {
    const order = await service.createOrder({
      projectId,
      authorUserId: userId,
      objective: "Persist the PLT-008 workflow",
      priority: "P0",
      acceptanceCriteria: ["state is durable", "requirements are traceable"],
      requirements: [{
        key: `REQ-PLT008-${randomUUID()}`,
        title: "Durable lifecycle",
        description: "Persist work order and task lifecycle"
      }]
    });

    const requirementIds = order.requirements.map((requirement) => requirement.id);
    const task = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Implement persistence",
      risk: "R2",
      acceptanceCriteria: ["migration passes", "illegal transitions fail"],
      requirementIds
    });

    expect(task.repositoryId).toBe(repositoryId);
    expect(task.requirementIds).toEqual(requirementIds);
    expect(task.stateHistory[0]).toMatchObject({
      fromStatus: null,
      toStatus: "PLANNED",
      actorType: "SYSTEM",
      cause: "unspecified"
    });
  });

  it("persists canonical task lifecycle with actor, cause and evidence", async () => {
    const order = await service.createOrder({ projectId, objective: "Exercise lifecycle" });
    let task = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Lifecycle task"
    });

    const context = {
      actorType: "USER" as const,
      actorId: userId,
      cause: "operator advancement",
      evidence: { source: "test" }
    };

    for (const status of [
      "READY",
      "RUNNING",
      "VERIFYING",
      "VERIFIED",
      "STAGING",
      "AWAITING_HUMAN"
    ] as const) {
      task = await service.transitionTask(task.id, status, context);
    }

    await pool.query(
      `INSERT INTO approvals (
         task_id, actor_user_id, decision, revision, commit_sha,
         pull_request_url, staging_url, evidence
       ) VALUES ($1, $2, 'APPROVED', 'rev-plt008', '0123456789abcdef',
                 'https://github.com/novo34/example/pull/1',
                 'https://staging.example.test',
                 '{"verified":true}'::jsonb)`,
      [task.id, userId]
    );

    task = await service.transitionTask(task.id, "APPROVED", context);

    expect(task.stateHistory.map((entry) => entry.toStatus)).toEqual([
      "PLANNED",
      "READY",
      "RUNNING",
      "VERIFYING",
      "VERIFIED",
      "STAGING",
      "AWAITING_HUMAN",
      "APPROVED"
    ]);
    expect(task.stateHistory.at(-1)).toMatchObject({
      actorType: "USER",
      actorId: userId,
      cause: "operator advancement",
      evidence: { source: "test" }
    });

    await expect(
      service.transitionTask(task.id, "DONE", {
        actorType: "SYSTEM",
        cause: "promotion not implemented"
      })
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
  });

  it("rejects APPROVED without a persisted non-stale approval", async () => {
    const order = await service.createOrder({ projectId, objective: "Approval gate" });
    let task = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Approval-gated task"
    });
    const context = { actorType: "USER" as const, actorId: userId, cause: "advance" };

    for (const status of [
      "READY",
      "RUNNING",
      "VERIFYING",
      "VERIFIED",
      "STAGING",
      "AWAITING_HUMAN"
    ] as const) {
      task = await service.transitionTask(task.id, status, context);
    }

    await expect(
      service.transitionTask(task.id, "APPROVED", context)
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
  });

  it("rejects illegal transitions in both the service and PostgreSQL", async () => {
    const order = await service.createOrder({ projectId, objective: "Reject state jumps" });
    const task = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Reject task jump"
    });
    const context = { actorType: "SYSTEM" as const, cause: "test invalid jump" };

    await expect(
      service.transitionTask(task.id, "DONE", context)
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });

    await expect(
      pool.query("UPDATE tasks SET status = 'DONE' WHERE id = $1", [task.id])
    ).rejects.toMatchObject({ code: "23514" });

    expect((await service.getTask(task.id)).status).toBe("PLANNED");
  });

  it("requires an explicit repository for multi-repository projects", async () => {
    const order = await service.createOrder({ projectId, objective: "Ambiguous repository" });

    await expect(
      service.createTask({
        projectId,
        orderId: order.id,
        title: "Ambiguous task"
      })
    ).rejects.toMatchObject({ code: "AMBIGUOUS_REPOSITORY_TARGET" });
  });

  it("rejects repositories that belong to a different project", async () => {
    const order = await service.createOrder({ projectId, objective: "Foreign repository" });

    await expect(
      service.createTask({
        projectId,
        orderId: order.id,
        repositoryId: foreignRepositoryId,
        title: "Foreign repository task"
      })
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
  });

  it("rejects requirement links outside the selected work order", async () => {
    const first = await service.createOrder({
      projectId,
      objective: "First order",
      requirements: [{
        key: `REQ-FIRST-${randomUUID()}`,
        title: "First",
        description: "First order requirement"
      }]
    });
    const second = await service.createOrder({ projectId, objective: "Second order" });

    await expect(
      service.createTask({
        projectId,
        orderId: second.id,
        repositoryId,
        title: "Invalid requirement link",
        requirementIds: [first.requirements[0].id]
      })
    ).rejects.toMatchObject({ code: "REQUIREMENT_NOT_FOUND" });
  });
});
