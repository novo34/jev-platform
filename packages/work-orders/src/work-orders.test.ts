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
                 jsonb_build_object(
                   'verified', true,
                   'stagingDeploymentId', $3::text
                 ))`,
      [task.id, userId, deployment.rows[0].id]
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
      evidence: {
        stagingDeploymentId: deployment.rows[0].id,
        revision: "rev-plt008",
        url: "https://staging.example.test"
      }
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

  it("allows human review without staging when the task repository has no staging environment", async () => {
    const noStagingProjectId = randomUUID();
    const noStagingRepositoryId = randomUUID();

    await pool.query(
      "INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'No Staging Project')",
      [noStagingProjectId, organizationId]
    );
    await pool.query(
      `INSERT INTO repositories (
         id, project_id, full_name, role, primary_repository, default_branch, staging_branch
       ) VALUES ($1, $2, 'novo34/no-staging', 'backend', TRUE, 'main', 'staging')`,
      [noStagingRepositoryId, noStagingProjectId]
    );

    const noStagingService = new WorkOrderService(pool);
    const order = await noStagingService.createOrder({
      projectId: noStagingProjectId,
      objective: "No staging workflow"
    });
    let task = await noStagingService.createTask({
      projectId: noStagingProjectId,
      orderId: order.id,
      repositoryId: noStagingRepositoryId,
      title: "No staging task"
    });

    const context = {
      actorType: "USER" as const,
      actorId: userId,
      cause: "no staging review"
    };

    for (const status of ["READY", "RUNNING", "VERIFYING", "VERIFIED", "STAGING", "AWAITING_HUMAN"] as const) {
      task = await noStagingService.transitionTask(task.id, status, context);
    }

    await pool.query(
      `INSERT INTO approvals (
         task_id, actor_user_id, decision, revision, commit_sha,
         pull_request_url, evidence
       ) VALUES ($1, $2, 'APPROVED', 'rev-no-staging', 'abcdef0123456789',
                 'https://github.com/novo34/example/pull/2',
                 '{"verified":true}'::jsonb)`,
      [task.id, userId]
    );

    task = await noStagingService.transitionTask(task.id, "APPROVED", context);
    expect(task.status).toBe("APPROVED");

    await pool.query("DELETE FROM approvals WHERE task_id = $1", [task.id]);
    await pool.query("DELETE FROM tasks WHERE project_id = $1", [noStagingProjectId]);
    await pool.query("DELETE FROM orders WHERE project_id = $1", [noStagingProjectId]);
    await pool.query("DELETE FROM repositories WHERE project_id = $1", [noStagingProjectId]);
    await pool.query("DELETE FROM projects WHERE id = $1", [noStagingProjectId]);
  });

  it("rejects deployments whose project or repository does not match the task", async () => {
    const order = await service.createOrder({ projectId, objective: "Deployment scope" });
    const task = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Scoped deployment task"
    });

    await expect(
      pool.query(
        `INSERT INTO deployments (
           project_id, repository_id, environment_id, task_id,
           provider, revision, status, url
         ) VALUES ($1, $2, $3, $4, 'test', 'wrong-repo', 'READY',
                   'https://staging.example.test')`,
        [projectId, secondRepositoryId, environmentId, task.id]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("invalidates approval when an identical revision/url is redeployed under a new deployment id", async () => {
    const order = await service.createOrder({ projectId, objective: "Redeploy invalidation" });
    let task = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Redeploy task"
    });
    const context = {
      actorType: "USER" as const,
      actorId: userId,
      cause: "redeploy test"
    };

    for (const status of ["READY", "RUNNING", "VERIFYING", "VERIFIED", "STAGING"] as const) {
      task = await service.transitionTask(task.id, status, context);
    }

    const firstDeployment = await pool.query<{ id: string }>(
      `INSERT INTO deployments (
         project_id, repository_id, environment_id, task_id,
         provider, revision, status, url
       ) VALUES ($1, $2, $3, $4, 'test', 'rev-same', 'READY',
                 'https://staging.example.test/same')
       RETURNING id`,
      [projectId, repositoryId, environmentId, task.id]
    );

    task = await service.transitionTask(task.id, "AWAITING_HUMAN", {
      ...context,
      evidence: {
        stagingDeploymentId: firstDeployment.rows[0].id,
        revision: "rev-same",
        url: "https://staging.example.test/same"
      }
    });

    await pool.query(
      `INSERT INTO approvals (
         task_id, actor_user_id, decision, revision, commit_sha,
         pull_request_url, staging_url, evidence
       ) VALUES ($1, $2, 'APPROVED', 'rev-same', 'abcdef0123456789',
                 'https://github.com/novo34/example/pull/3',
                 'https://staging.example.test/same',
                 jsonb_build_object('stagingDeploymentId', $3::text, 'verified', true))`,
      [task.id, userId, firstDeployment.rows[0].id]
    );

    await pool.query(
      `INSERT INTO deployments (
         project_id, repository_id, environment_id, task_id,
         provider, revision, status, url
       ) VALUES ($1, $2, $3, $4, 'test', 'rev-same', 'READY',
                 'https://staging.example.test/same')`,
      [projectId, repositoryId, environmentId, task.id]
    );

    const approval = await pool.query(
      "SELECT stale FROM approvals WHERE task_id = $1 AND revision = 'rev-same'",
      [task.id]
    );
    expect(approval.rows[0].stale).toBe(true);
  });

  it("invalidates a non-staging approval when review requests changes before APPROVED", async () => {
    const noStagingProjectId = randomUUID();
    const noStagingRepositoryId = randomUUID();

    await pool.query(
      "INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'No Staging Rework Project')",
      [noStagingProjectId, organizationId]
    );
    await pool.query(
      `INSERT INTO repositories (
         id, project_id, full_name, role, primary_repository, default_branch, staging_branch
       ) VALUES ($1, $2, 'novo34/no-staging-rework', 'backend', TRUE, 'main', 'staging')`,
      [noStagingRepositoryId, noStagingProjectId]
    );

    const noStagingService = new WorkOrderService(pool);
    const order = await noStagingService.createOrder({
      projectId: noStagingProjectId,
      objective: "Rework approval invalidation"
    });
    let task = await noStagingService.createTask({
      projectId: noStagingProjectId,
      orderId: order.id,
      repositoryId: noStagingRepositoryId,
      title: "Rework task"
    });
    const context = {
      actorType: "USER" as const,
      actorId: userId,
      cause: "review rework"
    };

    for (const status of ["READY", "RUNNING", "VERIFYING", "VERIFIED", "STAGING", "AWAITING_HUMAN"] as const) {
      task = await noStagingService.transitionTask(task.id, status, context);
    }

    await pool.query(
      `INSERT INTO approvals (
         task_id, actor_user_id, decision, revision, commit_sha,
         pull_request_url, evidence
       ) VALUES ($1, $2, 'APPROVED', 'rev-old', 'abcdef0123456789',
                 'https://github.com/novo34/example/pull/4',
                 '{"verified":true}'::jsonb)`,
      [task.id, userId]
    );

    task = await noStagingService.transitionTask(task.id, "CHANGES_REQUESTED", context);
    expect(task.status).toBe("CHANGES_REQUESTED");

    const approval = await pool.query(
      "SELECT stale FROM approvals WHERE task_id = $1 AND revision = 'rev-old'",
      [task.id]
    );
    expect(approval.rows[0].stale).toBe(true);

    await pool.query("DELETE FROM approvals WHERE task_id = $1", [task.id]);
    await pool.query("DELETE FROM tasks WHERE project_id = $1", [noStagingProjectId]);
    await pool.query("DELETE FROM orders WHERE project_id = $1", [noStagingProjectId]);
    await pool.query("DELETE FROM repositories WHERE project_id = $1", [noStagingProjectId]);
    await pool.query("DELETE FROM projects WHERE id = $1", [noStagingProjectId]);
  });

  it("does not stale the current approval when an older deployment is edited", async () => {
    const order = await service.createOrder({ projectId, objective: "Historical deployment edit" });
    let task = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Historical deployment task"
    });
    const context = {
      actorType: "USER" as const,
      actorId: userId,
      cause: "historical deployment test"
    };

    for (const status of ["READY", "RUNNING", "VERIFYING", "VERIFIED", "STAGING"] as const) {
      task = await service.transitionTask(task.id, status, context);
    }

    const first = await pool.query<{ id: string }>(
      `INSERT INTO deployments (
         project_id, repository_id, environment_id, task_id,
         provider, revision, status, url, created_at
       ) VALUES ($1, $2, $3, $4, 'test', 'rev-old-deploy', 'READY',
                 'https://staging.example.test/history', NOW() - INTERVAL '1 minute')
       RETURNING id`,
      [projectId, repositoryId, environmentId, task.id]
    );

    const second = await pool.query<{ id: string }>(
      `INSERT INTO deployments (
         project_id, repository_id, environment_id, task_id,
         provider, revision, status, url
       ) VALUES ($1, $2, $3, $4, 'test', 'rev-current-deploy', 'READY',
                 'https://staging.example.test/current')
       RETURNING id`,
      [projectId, repositoryId, environmentId, task.id]
    );

    task = await service.transitionTask(task.id, "AWAITING_HUMAN", {
      ...context,
      evidence: {
        stagingDeploymentId: second.rows[0].id,
        revision: "rev-current-deploy",
        url: "https://staging.example.test/current"
      }
    });

    await pool.query(
      `INSERT INTO approvals (
         task_id, actor_user_id, decision, revision, commit_sha,
         pull_request_url, staging_url, evidence
       ) VALUES ($1, $2, 'APPROVED', 'rev-current-deploy', 'abcdef0123456789',
                 'https://github.com/novo34/example/pull/5',
                 'https://staging.example.test/current',
                 jsonb_build_object('stagingDeploymentId', $3::text, 'verified', true))`,
      [task.id, userId, second.rows[0].id]
    );

    await pool.query(
      "UPDATE deployments SET status = 'FAILED' WHERE id = $1",
      [first.rows[0].id]
    );

    const approval = await pool.query(
      "SELECT stale FROM approvals WHERE task_id = $1 AND revision = 'rev-current-deploy'",
      [task.id]
    );
    expect(approval.rows[0].stale).toBe(false);
  });

  it("stales an approval when its staging deployment is reassigned to another task", async () => {
    const order = await service.createOrder({ projectId, objective: "Deployment reassignment" });
    let task = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Approved task"
    });
    const secondTask = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Replacement task"
    });
    const context = {
      actorType: "USER" as const,
      actorId: userId,
      cause: "deployment reassignment test"
    };

    for (const status of ["READY", "RUNNING", "VERIFYING", "VERIFIED", "STAGING"] as const) {
      task = await service.transitionTask(task.id, status, context);
    }

    const deployment = await pool.query<{ id: string }>(
      `INSERT INTO deployments (
         project_id, repository_id, environment_id, task_id,
         provider, revision, status, url
       ) VALUES ($1, $2, $3, $4, 'test', 'rev-reassign', 'READY',
                 'https://staging.example.test/reassign')
       RETURNING id`,
      [projectId, repositoryId, environmentId, task.id]
    );

    task = await service.transitionTask(task.id, "AWAITING_HUMAN", {
      ...context,
      evidence: {
        stagingDeploymentId: deployment.rows[0].id,
        revision: "rev-reassign",
        url: "https://staging.example.test/reassign"
      }
    });

    await pool.query(
      `INSERT INTO approvals (
         task_id, actor_user_id, decision, revision, commit_sha,
         pull_request_url, staging_url, evidence
       ) VALUES ($1, $2, 'APPROVED', 'rev-reassign', 'abcdef0123456789',
                 'https://github.com/novo34/example/pull/6',
                 'https://staging.example.test/reassign',
                 jsonb_build_object('stagingDeploymentId', $3::text, 'verified', true))`,
      [task.id, userId, deployment.rows[0].id]
    );

    await pool.query(
      "UPDATE deployments SET task_id = $2 WHERE id = $1",
      [deployment.rows[0].id, secondTask.id]
    );

    const approval = await pool.query(
      "SELECT stale FROM approvals WHERE task_id = $1 AND revision = 'rev-reassign'",
      [task.id]
    );
    expect(approval.rows[0].stale).toBe(true);
  });

  it("honors the latest persisted human decision instead of an older approval", async () => {
    const noStagingProjectId = randomUUID();
    const noStagingRepositoryId = randomUUID();

    await pool.query(
      "INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Latest Decision Project')",
      [noStagingProjectId, organizationId]
    );
    await pool.query(
      `INSERT INTO repositories (
         id, project_id, full_name, role, primary_repository, default_branch, staging_branch
       ) VALUES ($1, $2, 'novo34/latest-decision', 'backend', TRUE, 'main', 'staging')`,
      [noStagingRepositoryId, noStagingProjectId]
    );

    const noStagingService = new WorkOrderService(pool);
    const order = await noStagingService.createOrder({
      projectId: noStagingProjectId,
      objective: "Latest human decision"
    });
    let task = await noStagingService.createTask({
      projectId: noStagingProjectId,
      orderId: order.id,
      repositoryId: noStagingRepositoryId,
      title: "Decision task"
    });
    const context = {
      actorType: "USER" as const,
      actorId: userId,
      cause: "decision test"
    };

    for (const status of ["READY", "RUNNING", "VERIFYING", "VERIFIED", "STAGING", "AWAITING_HUMAN"] as const) {
      task = await noStagingService.transitionTask(task.id, status, context);
    }

    await pool.query(
      `INSERT INTO approvals (
         task_id, actor_user_id, decision, revision, commit_sha,
         pull_request_url, evidence
       ) VALUES ($1, $2, 'APPROVED', 'rev-approved', 'aaaaaaaaaaaaaaaa',
                 'https://github.com/novo34/example/pull/7',
                 '{"verified":true}'::jsonb)`,
      [task.id, userId]
    );
    await pool.query(
      `INSERT INTO approvals (
         task_id, actor_user_id, decision, revision, commit_sha,
         pull_request_url, evidence
       ) VALUES ($1, $2, 'CHANGES_REQUESTED', 'rev-changes', 'bbbbbbbbbbbbbbbb',
                 'https://github.com/novo34/example/pull/7',
                 '{"reason":"changes"}'::jsonb)`,
      [task.id, userId]
    );

    const decisions = await pool.query(
      "SELECT decision, stale FROM approvals WHERE task_id = $1 ORDER BY created_at, id",
      [task.id]
    );
    expect(decisions.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ decision: "APPROVED", stale: true }),
        expect.objectContaining({ decision: "CHANGES_REQUESTED", stale: false })
      ])
    );

    await expect(
      noStagingService.transitionTask(task.id, "APPROVED", context)
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });

    await pool.query("DELETE FROM approvals WHERE task_id = $1", [task.id]);
    await pool.query("DELETE FROM tasks WHERE project_id = $1", [noStagingProjectId]);
    await pool.query("DELETE FROM orders WHERE project_id = $1", [noStagingProjectId]);
    await pool.query("DELETE FROM repositories WHERE project_id = $1", [noStagingProjectId]);
    await pool.query("DELETE FROM projects WHERE id = $1", [noStagingProjectId]);
  });

  it("stales approval when its exact staging deployment is deleted", async () => {
    const order = await service.createOrder({ projectId, objective: "Deployment deletion" });
    let task = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Deletion task"
    });
    const context = {
      actorType: "USER" as const,
      actorId: userId,
      cause: "deployment delete test"
    };

    for (const status of ["READY", "RUNNING", "VERIFYING", "VERIFIED", "STAGING"] as const) {
      task = await service.transitionTask(task.id, status, context);
    }

    const deployment = await pool.query<{ id: string }>(
      `INSERT INTO deployments (
         project_id, repository_id, environment_id, task_id,
         provider, revision, status, url
       ) VALUES ($1, $2, $3, $4, 'test', 'rev-delete', 'READY',
                 'https://staging.example.test/delete')
       RETURNING id`,
      [projectId, repositoryId, environmentId, task.id]
    );

    task = await service.transitionTask(task.id, "AWAITING_HUMAN", {
      ...context,
      evidence: {
        stagingDeploymentId: deployment.rows[0].id,
        revision: "rev-delete",
        url: "https://staging.example.test/delete"
      }
    });

    await pool.query(
      `INSERT INTO approvals (
         task_id, actor_user_id, decision, revision, commit_sha,
         pull_request_url, staging_url, evidence
       ) VALUES ($1, $2, 'APPROVED', 'rev-delete', 'cccccccccccccccc',
                 'https://github.com/novo34/example/pull/8',
                 'https://staging.example.test/delete',
                 jsonb_build_object('stagingDeploymentId', $3::text, 'verified', true))`,
      [task.id, userId, deployment.rows[0].id]
    );

    await pool.query("DELETE FROM deployments WHERE id = $1", [deployment.rows[0].id]);

    const approval = await pool.query(
      "SELECT stale FROM approvals WHERE task_id = $1 AND revision = 'rev-delete'",
      [task.id]
    );
    expect(approval.rows[0].stale).toBe(true);
  });

  it("stales the destination approval when a newer staging deployment is reassigned to that task", async () => {
    const order = await service.createOrder({ projectId, objective: "Destination approval invalidation" });
    let destination = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Destination task"
    });
    const source = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Source task"
    });
    const context = {
      actorType: "USER" as const,
      actorId: userId,
      cause: "destination invalidation test"
    };

    for (const status of ["READY", "RUNNING", "VERIFYING", "VERIFIED", "STAGING"] as const) {
      destination = await service.transitionTask(destination.id, status, context);
    }

    const destinationDeployment = await pool.query<{ id: string }>(
      `INSERT INTO deployments (
         project_id, repository_id, environment_id, task_id,
         provider, revision, status, url, created_at
       ) VALUES ($1, $2, $3, $4, 'test', 'rev-destination', 'READY',
                 'https://staging.example.test/destination',
                 NOW() - INTERVAL '1 minute')
       RETURNING id`,
      [projectId, repositoryId, environmentId, destination.id]
    );

    destination = await service.transitionTask(destination.id, "AWAITING_HUMAN", {
      ...context,
      evidence: {
        stagingDeploymentId: destinationDeployment.rows[0].id,
        revision: "rev-destination",
        url: "https://staging.example.test/destination"
      }
    });

    await pool.query(
      `INSERT INTO approvals (
         task_id, actor_user_id, decision, revision, commit_sha,
         pull_request_url, staging_url, evidence
       ) VALUES ($1, $2, 'APPROVED', 'rev-destination', 'dddddddddddddddd',
                 'https://github.com/novo34/example/pull/9',
                 'https://staging.example.test/destination',
                 jsonb_build_object('stagingDeploymentId', $3::text, 'verified', true))`,
      [destination.id, userId, destinationDeployment.rows[0].id]
    );

    const moved = await pool.query<{ id: string }>(
      `INSERT INTO deployments (
         project_id, repository_id, environment_id, task_id,
         provider, revision, status, url
       ) VALUES ($1, $2, $3, $4, 'test', 'rev-moved', 'READY',
                 'https://staging.example.test/moved')
       RETURNING id`,
      [projectId, repositoryId, environmentId, source.id]
    );

    await pool.query(
      "UPDATE deployments SET task_id = $2 WHERE id = $1",
      [moved.rows[0].id, destination.id]
    );

    const approval = await pool.query(
      "SELECT stale FROM approvals WHERE task_id = $1 AND revision = 'rev-destination'",
      [destination.id]
    );
    expect(approval.rows[0].stale).toBe(true);
  });

  it("prevents changing the scope of an environment referenced by deployments", async () => {
    const order = await service.createOrder({ projectId, objective: "Environment scope immutability" });
    const task = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Environment scope task"
    });

    await pool.query(
      `INSERT INTO deployments (
         project_id, repository_id, environment_id, task_id,
         provider, revision, status, url
       ) VALUES ($1, $2, $3, $4, 'test', 'rev-env-scope', 'READY',
                 'https://staging.example.test/env-scope')`,
      [projectId, repositoryId, environmentId, task.id]
    );

    await expect(
      pool.query(
        "UPDATE environments SET kind = 'production' WHERE id = $1",
        [environmentId]
      )
    ).rejects.toMatchObject({ code: "23514" });
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

  it("prevents changing a task repository after creation", async () => {
    const order = await service.createOrder({
      projectId,
      objective: "Immutable task scope"
    });
    const task = await service.createTask({
      projectId,
      orderId: order.id,
      repositoryId,
      title: "Immutable repository task"
    });

    await expect(
      pool.query(
        "UPDATE tasks SET repository_id = $2 WHERE id = $1",
        [task.id, secondRepositoryId]
      )
    ).rejects.toMatchObject({ code: "23514" });

    expect((await service.getTask(task.id)).repositoryId).toBe(repositoryId);
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
