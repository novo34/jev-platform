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
const environmentId = randomUUID();
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
    `INSERT INTO environments (
       id, project_id, repository_id, kind, name, url
     ) VALUES ($1, $2, $3, 'staging', 'Staging', 'https://staging.example.test')`,
    [environmentId, projectId, repositoryId]
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
    "DELETE FROM deployments WHERE task_id IN (SELECT id FROM tasks WHERE project_id IN ($1, $2))",
    [projectId, foreignProjectId]
  );
  await pool.query(
    "DELETE FROM approvals WHERE task_id IN (SELECT id FROM tasks WHERE project_id IN ($1, $2))",
    [projectId, foreignProjectId]
  );
  await pool.query("DELETE FROM tasks WHERE project_id IN ($1, $2)", [projectId, foreignProjectId]);
  await pool.query("DELETE FROM requirements WHERE project_id IN ($1, $2)", [projectId, foreignProjectId]);
  await pool.query("DELETE FROM orders WHERE project_id IN ($1, $2)", [projectId, foreignProjectId]);
  await pool.query("DELETE FROM environments WHERE project_id IN ($1, $2)", [projectId, foreignProjectId]);
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
      "STAGING"
    ] as const) {
      task = await service.transitionTask(task.id, status, context);
    }

    const deployment = await pool.query<{ id: string }>(
      `INSERT INTO deployments (
         project_id, repository_id, environment_id, task_id,
         provider, revision, status, url
       ) VALUES ($1, $2, $3, $4, 'test', 'rev-plt008', 'READY',
                 'https://staging.example.test')
       RETURNING id`,
      [projectId, repositoryId, environmentId, task.id]
    );

    const reviewContext = {
      ...context,
      evidence: {
        stagingDeploymentId: deployment.rows[0].id,
        revision: "rev-plt008",
        url: "https://staging.example.test"
      }
    };

    task = await service.transitionTask(task.id, "AWAITING_HUMAN", reviewContext);

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

    task = await service.transitionTask(task.id, "APPROVED", reviewContext);

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

    await pool.query(
      "UPDATE deployments SET status = 'FAILED' WHERE id = $1",
      [deployment.rows[0].id]
    );

    let approval = await pool.query(
      "SELECT stale FROM approvals WHERE task_id = $1 AND revision = 'rev-plt008'",
      [task.id]
    );
    expect(approval.rows[0].stale).toBe(true);

    await pool.query(
      `INSERT INTO deployments (
         project_id, repository_id, environment_id, task_id,
         provider, revision, status, url
       ) VALUES ($1, $2, $3, $4, 'test', 'rev-plt008-new', 'READY',
                 'https://staging.example.test/new')`,
      [projectId, repositoryId, environmentId, task.id]
    );

    approval = await pool.query(
      "SELECT stale FROM approvals WHERE task_id = $1 AND revision = 'rev-plt008'",
      [task.id]
    );
    expect(approval.rows[0].stale).toBe(true);
  });

  it("rejects APPROVED without a persisted non-stale approval", async () => {
    const order = await service.createOrder({ projectId, objective: "Approval gate" });
    let task = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Approval-gated task"
    });
    const context = {
      actorType: "USER" as const,
      actorId: userId,
      cause: "advance",
      evidence: { readiness: true }
    };

    for (const status of [
      "READY",
      "RUNNING",
      "VERIFYING",
      "VERIFIED",
      "STAGING"
    ] as const) {
      task = await service.transitionTask(task.id, status, context);
    }

    const deployment = await pool.query<{ id: string }>(
      `INSERT INTO deployments (
         project_id, repository_id, environment_id, task_id,
         provider, revision, status, url
       ) VALUES ($1, $2, $3, $4, 'test', 'rev-no-approval', 'READY',
                 'https://staging.example.test')
       RETURNING id`,
      [projectId, repositoryId, environmentId, task.id]
    );

    task = await service.transitionTask(task.id, "AWAITING_HUMAN", {
      ...context,
      evidence: {
        stagingDeploymentId: deployment.rows[0].id,
        revision: "rev-no-approval",
        url: "https://staging.example.test"
      }
    });

    await expect(
      service.transitionTask(task.id, "APPROVED", context)
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
  });

  it("rejects human review without a ready staging deployment", async () => {
    const order = await service.createOrder({ projectId, objective: "Staging gate" });
    let task = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Staging-gated task"
    });
    const context = {
      actorType: "SYSTEM" as const,
      cause: "staging readiness",
      evidence: { readiness: true }
    };

    for (const status of ["READY", "RUNNING", "VERIFYING", "VERIFIED", "STAGING"] as const) {
      task = await service.transitionTask(task.id, status, context);
    }

    await expect(
      service.transitionTask(task.id, "AWAITING_HUMAN", context)
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

  it("releases the transition client before reloading with a single-connection pool", async () => {
    const singlePool = createDatabasePool({ max: 1 });
    const singleService = new WorkOrderService(singlePool);

    try {
      const order = await singleService.createOrder({
        projectId,
        objective: "Single pool transition"
      });
      const task = await singleService.createTask({
        projectId,
        orderId: order.id,
        repositoryId,
        title: "Single pool task"
      });

      const transitioned = await singleService.transitionTask(
        task.id,
        "READY",
        {
          actorType: "SYSTEM",
          cause: "single connection regression"
        }
      );

      expect(transitioned.status).toBe("READY");
    } finally {
      await singlePool.end();
    }
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
