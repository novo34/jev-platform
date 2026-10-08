import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabasePool, DEFAULT_MIGRATIONS_DIR } from "./index.js";

async function migration(name: string): Promise<string> {
  const sql = await readFile(path.join(DEFAULT_MIGRATIONS_DIR, name), "utf8");
  if (name === "0001_canonical_persistence.sql") {
    return sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "");
  }
  return sql;
}

describe("PLT-008 remediation migration", () => {
  it("backfills the initial state when a pre-0005 row already has later history", async () => {
    const pool = createDatabasePool();
    const client = await pool.connect();
    const schema = `plt008_${randomUUID().replaceAll("-", "")}`;

    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}", public`);

      for (const file of [
        "0001_canonical_persistence.sql",
        "0002_auth_rbac.sql",
        "0003_queue_worker.sql",
        "0004_project_registry.sql"
      ]) {
        await client.query(await migration(file));
      }

      const organizationId = randomUUID();
      const projectId = randomUUID();
      const orderId = randomUUID();
      const taskId = randomUUID();

      await client.query(
        "INSERT INTO organizations (id, name) VALUES ($1, 'Upgrade Org')",
        [organizationId]
      );
      await client.query(
        "INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Upgrade Project')",
        [projectId, organizationId]
      );
      await client.query(
        `INSERT INTO repositories (
           project_id, full_name, role, primary_repository, default_branch, staging_branch
         ) VALUES ($1, 'novo34/upgrade-project', 'backend', TRUE, 'main', 'staging')`,
        [projectId]
      );
      await client.query(
        "INSERT INTO orders (id, project_id, objective) VALUES ($1, $2, 'Legacy order')",
        [orderId, projectId]
      );
      await client.query(
        "INSERT INTO tasks (id, project_id, order_id, title) VALUES ($1, $2, $3, 'Legacy task')",
        [taskId, projectId, orderId]
      );

      await client.query(await migration("0005_work_order_task_lifecycle.sql"));

      // A transition after 0005 creates a history row, but there is still no
      // creation/current-state row for entities that existed before 0005.
      await client.query("UPDATE orders SET status = 'READY' WHERE id = $1", [orderId]);
      await client.query("UPDATE tasks SET status = 'READY' WHERE id = $1", [taskId]);

      expect(
        Number(
          (await client.query(
            "SELECT COUNT(*) AS count FROM task_state_history WHERE task_id = $1",
            [taskId]
          )).rows[0].count
        )
      ).toBe(1);

      await client.query(
        await migration("0006_work_order_task_review_remediation.sql")
      );

      const orderHistory = await client.query(
        `SELECT from_status, to_status, actor_type, cause
           FROM order_state_history
          WHERE order_id = $1
          ORDER BY created_at, id`,
        [orderId]
      );
      const taskHistory = await client.query(
        `SELECT from_status, to_status, actor_type, cause
           FROM task_state_history
          WHERE task_id = $1
          ORDER BY created_at, id`,
        [taskId]
      );

      expect(orderHistory.rows).toEqual([
        {
          from_status: null,
          to_status: "PLANNED",
          actor_type: "SYSTEM",
          cause: "migration_backfill"
        },
        {
          from_status: "PLANNED",
          to_status: "READY",
          actor_type: "SYSTEM",
          cause: "legacy_transition"
        }
      ]);
      expect(taskHistory.rows).toEqual([
        {
          from_status: null,
          to_status: "PLANNED",
          actor_type: "SYSTEM",
          cause: "migration_backfill"
        },
        {
          from_status: "PLANNED",
          to_status: "READY",
          actor_type: "SYSTEM",
          cause: "legacy_transition"
        }
      ]);
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    }
  });
  it("backfills legacy repositoryless environments when the project has one repository", async () => {
    const pool = createDatabasePool();
    const client = await pool.connect();
    const schema = `plt008_env_${randomUUID().replaceAll("-", "")}`;

    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}", public`);

      for (const file of [
        "0001_canonical_persistence.sql",
        "0002_auth_rbac.sql",
        "0003_queue_worker.sql",
        "0004_project_registry.sql"
      ]) {
        await client.query(await migration(file));
      }

      const organizationId = randomUUID();
      const projectId = randomUUID();
      const repositoryId = randomUUID();
      const environmentId = randomUUID();

      await client.query(
        "INSERT INTO organizations (id, name) VALUES ($1, 'Legacy Environment Org')",
        [organizationId]
      );
      await client.query(
        "INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Legacy Environment Project')",
        [projectId, organizationId]
      );
      await client.query(
        `INSERT INTO repositories (
           id, project_id, full_name, role, primary_repository, default_branch, staging_branch
         ) VALUES ($1, $2, 'novo34/legacy-environment', 'backend', TRUE, 'main', 'staging')`,
        [repositoryId, projectId]
      );
      await client.query(
        `INSERT INTO environments (
           id, project_id, repository_id, kind, name, url
         ) VALUES ($1, $2, NULL, 'staging', 'Legacy Staging', 'https://legacy.example.test')`,
        [environmentId, projectId]
      );

      await client.query(await migration("0005_work_order_task_lifecycle.sql"));
      await client.query(await migration("0006_work_order_task_review_remediation.sql"));

      const environment = await client.query(
        "SELECT repository_id FROM environments WHERE id = $1",
        [environmentId]
      );
      expect(environment.rows[0].repository_id).toBe(repositoryId);

      await expect(
        client.query(
          "UPDATE environments SET repository_id = NULL WHERE id = $1",
          [environmentId]
        )
      ).rejects.toMatchObject({ code: "23502" });
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    }
  });

  it("repairs legacy cross-project repository IDs and enforces project-scoped repository ownership", async () => {
    const pool = createDatabasePool();
    const client = await pool.connect();
    const schema = `plt008_repo_${randomUUID().replaceAll("-", "")}`;

    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}", public`);

      for (const file of [
        "0001_canonical_persistence.sql",
        "0002_auth_rbac.sql",
        "0003_queue_worker.sql",
        "0004_project_registry.sql"
      ]) {
        await client.query(await migration(file));
      }

      const organizationId = randomUUID();
      const projectA = randomUUID();
      const projectB = randomUUID();
      const repoA = randomUUID();
      const repoB = randomUUID();
      const orderA = randomUUID();
      const taskA = randomUUID();

      await client.query(
        "INSERT INTO organizations (id, name) VALUES ($1, 'Legacy Repo Org')",
        [organizationId]
      );
      await client.query(
        `INSERT INTO projects (id, organization_id, name)
         VALUES ($1, $3, 'Project A'), ($2, $3, 'Project B')`,
        [projectA, projectB, organizationId]
      );
      await client.query(
        `INSERT INTO repositories (
           id, project_id, full_name, role, primary_repository, default_branch, staging_branch
         ) VALUES
           ($1, $3, 'novo34/project-a', 'backend', TRUE, 'main', 'staging'),
           ($2, $4, 'novo34/project-b', 'backend', TRUE, 'main', 'staging')`,
        [repoA, repoB, projectA, projectB]
      );
      await client.query(
        "INSERT INTO orders (id, project_id, objective) VALUES ($1, $2, 'Legacy repo order')",
        [orderA, projectA]
      );
      await client.query(
        `INSERT INTO tasks (id, project_id, order_id, repository_id, title)
         VALUES ($1, $2, $3, $4, 'Legacy cross-project task')`,
        [taskA, projectA, orderA, repoB]
      );

      await client.query(await migration("0005_work_order_task_lifecycle.sql"));
      await client.query(await migration("0006_work_order_task_review_remediation.sql"));

      const repaired = await client.query(
        "SELECT repository_id FROM tasks WHERE id = $1",
        [taskA]
      );
      expect(repaired.rows[0].repository_id).toBe(repoA);

      await expect(
        client.query(
          "UPDATE tasks SET repository_id = $2 WHERE id = $1",
          [taskA, repoB]
        )
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    }
  });

  it("rejects legacy deployments with mismatched environment scope", async () => {
    const pool = createDatabasePool();
    const client = await pool.connect();
    const schema = `plt008_deploy_scope_${randomUUID().replaceAll("-", "")}`;

    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}", public`);

      for (const file of [
        "0001_canonical_persistence.sql",
        "0002_auth_rbac.sql",
        "0003_queue_worker.sql",
        "0004_project_registry.sql",
        "0005_work_order_task_lifecycle.sql"
      ]) {
        await client.query(await migration(file));
      }

      const organizationId = randomUUID();
      const projectA = randomUUID();
      const projectB = randomUUID();
      const repoA = randomUUID();
      const repoB = randomUUID();
      const environmentB = randomUUID();

      await client.query(
        "INSERT INTO organizations (id, name) VALUES ($1, 'Legacy Deployment Scope Org')",
        [organizationId]
      );
      await client.query(
        `INSERT INTO projects (id, organization_id, name)
         VALUES ($1, $3, 'Deploy A'), ($2, $3, 'Deploy B')`,
        [projectA, projectB, organizationId]
      );
      await client.query(
        `INSERT INTO repositories (
           id, project_id, full_name, role, primary_repository, default_branch, staging_branch
         ) VALUES
           ($1, $3, 'novo34/deploy-a', 'backend', TRUE, 'main', 'staging'),
           ($2, $4, 'novo34/deploy-b', 'backend', TRUE, 'main', 'staging')`,
        [repoA, repoB, projectA, projectB]
      );
      await client.query(
        `INSERT INTO environments (
           id, project_id, repository_id, kind, name
         ) VALUES ($1, $2, $3, 'staging', 'Legacy B')`,
        [environmentB, projectB, repoB]
      );
      await client.query(
        `INSERT INTO deployments (
           project_id, repository_id, environment_id,
           provider, revision, status
         ) VALUES ($1, $2, $3, 'test', 'legacy-mismatch', 'READY')`,
        [projectA, repoA, environmentB]
      );

      await expect(
        client.query(await migration("0006_work_order_task_review_remediation.sql"))
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    }
  });

  it("marks every pre-remediation approval stale before enabling the new gate", async () => {
    const pool = createDatabasePool();
    const client = await pool.connect();
    const schema = `plt008_approval_${randomUUID().replaceAll("-", "")}`;

    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}", public`);

      for (const file of [
        "0001_canonical_persistence.sql",
        "0002_auth_rbac.sql",
        "0003_queue_worker.sql",
        "0004_project_registry.sql",
        "0005_work_order_task_lifecycle.sql"
      ]) {
        await client.query(await migration(file));
      }

      const organizationId = randomUUID();
      const userId = randomUUID();
      const projectId = randomUUID();
      const repositoryId = randomUUID();
      const orderId = randomUUID();
      const taskId = randomUUID();

      await client.query(
        "INSERT INTO organizations (id, name) VALUES ($1, 'Legacy Approval Org')",
        [organizationId]
      );
      await client.query(
        `INSERT INTO users (id, organization_id, email, display_name, role)
         VALUES ($1, $2, $3, 'Legacy Reviewer', 'ADMIN')`,
        [userId, organizationId, `legacy-${userId}@test.local`]
      );
      await client.query(
        "INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Legacy Approval Project')",
        [projectId, organizationId]
      );
      await client.query(
        `INSERT INTO repositories (
           id, project_id, full_name, role, primary_repository, default_branch, staging_branch
         ) VALUES ($1, $2, 'novo34/legacy-approval', 'backend', TRUE, 'main', 'staging')`,
        [repositoryId, projectId]
      );
      await client.query(
        "INSERT INTO orders (id, project_id, objective) VALUES ($1, $2, 'Legacy approval order')",
        [orderId, projectId]
      );
      await client.query(
        `INSERT INTO tasks (
           id, project_id, order_id, repository_id, title, status
         ) VALUES ($1, $2, $3, $4, 'Legacy approval task', 'READY')`,
        [taskId, projectId, orderId, repositoryId]
      );
      await client.query(
        `INSERT INTO approvals (
           task_id, actor_user_id, decision, revision, commit_sha,
           pull_request_url, evidence, stale
         ) VALUES ($1, $2, 'APPROVED', 'legacy-rev', 'abcdef0123456789',
                   'https://github.com/novo34/example/pull/legacy',
                   '{"legacy":true}'::jsonb, FALSE)`,
        [taskId, userId]
      );

      await client.query(
        await migration("0006_work_order_task_review_remediation.sql")
      );

      const approval = await client.query(
        "SELECT stale FROM approvals WHERE task_id = $1",
        [taskId]
      );
      expect(approval.rows).toHaveLength(1);
      expect(approval.rows[0].stale).toBe(true);
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    }
  });

  it("locks the task row while an approval decision is being inserted", async () => {
    const pool = createDatabasePool();
    const setup = await pool.connect();
    const blocker = await pool.connect();
    const reviewer = await pool.connect();
    const schema = `plt008_approval_lock_${randomUUID().replaceAll("-", "")}`;

    try {
      await setup.query(`CREATE SCHEMA "${schema}"`);
      await setup.query(`SET search_path TO "${schema}", public`);

      for (const file of [
        "0001_canonical_persistence.sql",
        "0002_auth_rbac.sql",
        "0003_queue_worker.sql",
        "0004_project_registry.sql",
        "0005_work_order_task_lifecycle.sql",
        "0006_work_order_task_review_remediation.sql"
      ]) {
        await setup.query(await migration(file));
      }

      const organizationId = randomUUID();
      const userId = randomUUID();
      const projectId = randomUUID();
      const repositoryId = randomUUID();
      const orderId = randomUUID();
      const taskId = randomUUID();

      await setup.query(
        "INSERT INTO organizations (id, name) VALUES ($1, 'Approval Lock Org')",
        [organizationId]
      );
      await setup.query(
        `INSERT INTO users (id, organization_id, email, display_name, role)
         VALUES ($1, $2, $3, 'Approval Lock Reviewer', 'ADMIN')`,
        [userId, organizationId, `lock-${userId}@test.local`]
      );
      await setup.query(
        "INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Approval Lock Project')",
        [projectId, organizationId]
      );
      await setup.query(
        `INSERT INTO repositories (
           id, project_id, full_name, role, primary_repository, default_branch, staging_branch
         ) VALUES ($1, $2, 'novo34/approval-lock', 'backend', TRUE, 'main', 'staging')`,
        [repositoryId, projectId]
      );
      await setup.query(
        "INSERT INTO orders (id, project_id, objective) VALUES ($1, $2, 'Approval lock order')",
        [orderId, projectId]
      );
      await setup.query(
        `INSERT INTO tasks (
           id, project_id, order_id, repository_id, title
         ) VALUES ($1, $2, $3, $4, 'Approval lock task')`,
        [taskId, projectId, orderId, repositoryId]
      );
      // This test isolates approval-row serialization rather than lifecycle promotion.
      // Move through the legal state machine to the review state.
      for (const status of ['READY', 'RUNNING', 'VERIFYING', 'VERIFIED', 'STAGING', 'AWAITING_HUMAN']) {
        await setup.query("UPDATE tasks SET status = $2 WHERE id = $1", [taskId, status]);
      }

      await blocker.query(`SET search_path TO "${schema}", public`);
      await reviewer.query(`SET search_path TO "${schema}", public`);
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);

      await reviewer.query("SET statement_timeout = '250ms'");
      await expect(
        reviewer.query(
          `INSERT INTO approvals (
             task_id, actor_user_id, decision, revision, commit_sha,
             pull_request_url, evidence
           ) VALUES ($1, $2, 'CHANGES_REQUESTED', 'lock-rev', '1234567890abcdef',
                     'https://github.com/novo34/example/pull/lock',
                     '{"reason":"serialize"}'::jsonb)`,
          [taskId, userId]
        )
      ).rejects.toMatchObject({ code: "57014" });

      await blocker.query("ROLLBACK");
    } finally {
      try {
        await blocker.query("ROLLBACK");
      } catch {}
      await setup.query("SET search_path TO public");
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      setup.release();
      blocker.release();
      reviewer.release();
      await pool.end();
    }
  });


  it("regresses the Task-to-deployment versus deployment-to-Task lock inversion", async () => {
    const pool = createDatabasePool();
    const setup = await pool.connect();
    const taskFirst = await pool.connect();
    const deploymentFirst = await pool.connect();
    const schema = `plt008_cycle_${randomUUID().replaceAll("-", "")}`;
    try {
      await setup.query(`CREATE SCHEMA "${schema}"`);
      await setup.query(`SET search_path TO "${schema}", public`);
      for (const file of [
        "0001_canonical_persistence.sql",
        "0002_auth_rbac.sql",
        "0003_queue_worker.sql",
        "0004_project_registry.sql",
        "0005_work_order_task_lifecycle.sql",
        "0006_work_order_task_review_remediation.sql"
      ]) await setup.query(await migration(file));

      const org = randomUUID(), project = randomUUID(), repository = randomUUID();
      const order = randomUUID(), task = randomUUID(), environment = randomUUID();
      await setup.query("INSERT INTO organizations (id, name) VALUES ($1, 'Cycle Org')", [org]);
      await setup.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Cycle Project')", [project, org]);
      await setup.query(`INSERT INTO repositories
        (id, project_id, full_name, role, primary_repository, default_branch, staging_branch)
        VALUES ($1, $2, 'novo34/cycle', 'backend', TRUE, 'main', 'staging')`, [repository, project]);
      await setup.query("INSERT INTO orders (id, project_id, objective) VALUES ($1, $2, 'Cycle')", [order, project]);
      await setup.query(`INSERT INTO tasks (id, project_id, order_id, repository_id, title)
        VALUES ($1, $2, $3, $4, 'Cycle Task')`, [task, project, order, repository]);
      await setup.query(`INSERT INTO environments (id, project_id, repository_id, kind, name)
        VALUES ($1, $2, $3, 'staging', 'cycle')`, [environment, project, repository]);
      for (const client of [taskFirst, deploymentFirst]) {
        await client.query(`SET search_path TO "${schema}", public`);
        await client.query("SET lock_timeout = '1500ms'");
      }
      const deploymentPid = Number((await deploymentFirst.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await taskFirst.query("BEGIN");
      await deploymentFirst.query("BEGIN");
      await taskFirst.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [task]);
      const blockedWrite = deploymentFirst.query(`INSERT INTO deployments
        (project_id, repository_id, environment_id, task_id, revision, status)
        VALUES ($1, $2, $3, $4, 'cycle-rev', 'READY')`, [project, repository, environment, task])
        .then(() => "completed", (error: { code?: string }) => error.code ?? "unknown");
      let waitingOnTask = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await setup.query(`SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE pid = $1
            AND wait_event_type = 'Lock'
            AND cardinality(pg_blocking_pids(pid)) > 0
        ) AS waiting`, [deploymentPid]);
        if (state.rows[0].waiting) { waitingOnTask = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waitingOnTask).toBe(true);
      // This unrelated deployment has no task_id; a correct lock protocol
      // must not make it wait behind another task's blocked deployment.
      await expect(taskFirst.query(`INSERT INTO deployments
        (project_id, repository_id, environment_id, revision, status)
        VALUES ($1, $2, $3, 'unrelated-rev', 'READY')`, [project, repository, environment]))
        .resolves.toBeDefined();
      await taskFirst.query("COMMIT");
      expect(await blockedWrite).toBe("completed");
      await deploymentFirst.query("COMMIT");
    } finally {
      for (const client of [taskFirst, deploymentFirst]) {
        try { await client.query("ROLLBACK"); } catch {}
        client.release();
      }
      await setup.query("SET search_path TO public");
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      setup.release();
      await pool.end();
    }
  });

  it("serializes staging creation and Task transitions in both lock directions", async () => {
    const pool = createDatabasePool();
    const setup = await pool.connect();
    const taskWriter = await pool.connect();
    const environmentWriter = await pool.connect();
    const schema = `plt008_envrace_${randomUUID().replaceAll("-", "")}`;
    try {
      await setup.query(`CREATE SCHEMA "${schema}"`);
      await setup.query(`SET search_path TO "${schema}", public`);
      for (const file of [
        "0001_canonical_persistence.sql",
        "0002_auth_rbac.sql",
        "0003_queue_worker.sql",
        "0004_project_registry.sql",
        "0005_work_order_task_lifecycle.sql",
        "0006_work_order_task_review_remediation.sql",
        "0007_staging_requirement_approved_guard.sql",
        "0008_serialize_staging_requirement.sql"
      ]) await setup.query(await migration(file));

      const org = randomUUID(), project = randomUUID();
      const repository = randomUUID(), order = randomUUID(), task = randomUUID();
      await setup.query("INSERT INTO organizations (id, name) VALUES ($1, 'Race Org')", [org]);
      await setup.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Race Project')", [project, org]);
      await setup.query(`INSERT INTO repositories
        (id, project_id, full_name, role, primary_repository, default_branch, staging_branch)
        VALUES ($1, $2, 'novo34/env-race', 'backend', TRUE, 'main', 'staging')`,
        [repository, project]);
      await setup.query("INSERT INTO orders (id, project_id, objective) VALUES ($1, $2, 'Race')", [order, project]);
      await setup.query(`INSERT INTO tasks (id, project_id, order_id, repository_id, title)
        VALUES ($1, $2, $3, $4, 'Race Task')`, [task, project, order, repository]);
      for (const client of [taskWriter, environmentWriter]) {
        await client.query(`SET search_path TO "${schema}", public`);
        await client.query("SET lock_timeout = '1500ms'");
      }
      const pid = Number((await environmentWriter.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await taskWriter.query("BEGIN");
      await taskWriter.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [task]);
      const write = environmentWriter.query(`INSERT INTO environments
        (project_id, repository_id, kind, name)
        VALUES ($1, $2, 'staging', 'Concurrent staging')`, [project, repository])
        .then(() => "completed", (error: { code?: string }) => error.code ?? "unknown");
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await setup.query(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE pid = $1 AND wait_event_type = 'Lock'
            AND cardinality(pg_blocking_pids(pid)) > 0
        ) AS waiting`, [pid]);
        if (state.rows[0].waiting) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await taskWriter.query("COMMIT");
      expect(blocked).toBe(true);
      expect(await write).toBe("completed");
      const persisted = await setup.query(
        "SELECT COUNT(*)::int AS count FROM environments WHERE project_id = $1 AND kind = 'staging'",
        [project]
      );
      expect(persisted.rows[0].count).toBe(1);
      // Reverse lock order: the Environment writer locks affected Tasks,
      // and a real Task transition must wait until that writer commits.
      await environmentWriter.query("BEGIN");
      await environmentWriter.query(`INSERT INTO environments
        (project_id, repository_id, kind, name)
        VALUES ($1, $2, 'staging', 'Second concurrent staging')`, [project, repository]);
      const taskPid = Number((await taskWriter.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const taskTransition = taskWriter.query(
        "UPDATE tasks SET status = 'READY' WHERE id = $1", [task]
      ).then(() => "completed", (error: { code?: string }) => error.code ?? "unknown");
      let taskBlocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await setup.query(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE pid = $1 AND wait_event_type = 'Lock'
            AND cardinality(pg_blocking_pids(pid)) > 0
        ) AS waiting`, [taskPid]);
        if (state.rows[0].waiting) { taskBlocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await environmentWriter.query("COMMIT");
      expect(taskBlocked).toBe(true);
      expect(await taskTransition).toBe("completed");
      const finalState = await setup.query(
        "SELECT status FROM tasks WHERE id = $1", [task]
      );
      expect(finalState.rows[0].status).toBe("READY");

    } finally {
      for (const client of [taskWriter, environmentWriter]) {
        try { await client.query("ROLLBACK"); } catch {}
        client.release();
      }
      await setup.query("SET search_path TO public");
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      setup.release();
      await pool.end();
    }
  });

});
