import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "./index.js";
import { migrate } from "./migrations.js";

const pool = createDatabasePool();

beforeAll(async () => {
  await migrate(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("canonical PostgreSQL persistence", () => {
  it("creates the canonical tables and persists one connected record graph", async () => {
    const organizationId = randomUUID();
    const userId = randomUUID();
    const clientId = randomUUID();
    const projectId = randomUUID();
    const repositoryId = randomUUID();
    const environmentId = randomUUID();
    const orderId = randomUUID();
    const requirementId = randomUUID();
    const taskId = randomUUID();
    const taskRunId = randomUUID();
    const auditEventId = randomUUID();
    const costEventId = randomUUID();
    const notificationId = randomUUID();
    const deploymentId = randomUUID();

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        "INSERT INTO organizations (id, name) VALUES ($1, $2)",
        [organizationId, "JEV Test Organization"]
      );
      await client.query(
        `INSERT INTO users (id, organization_id, email, display_name, role)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, organizationId, "owner@example.test", "Owner", "ADMIN"]
      );
      await client.query(
        "INSERT INTO clients (id, organization_id, name) VALUES ($1, $2, $3)",
        [clientId, organizationId, "Test Client"]
      );
      await client.query(
        `INSERT INTO projects (id, organization_id, client_id, name)
         VALUES ($1, $2, $3, $4)`,
        [projectId, organizationId, clientId, "Test Project"]
      );
      await client.query(
        `INSERT INTO repositories (
           id, project_id, full_name, role, default_branch, staging_branch
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          repositoryId,
          projectId,
          "novo34/test-project",
          "backend",
          "main",
          "staging"
        ]
      );
      await client.query(
        `INSERT INTO environments (
           id, project_id, repository_id, kind, name, url
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          environmentId,
          projectId,
          repositoryId,
          "staging",
          "Staging",
          "https://staging.example.test"
        ]
      );
      await client.query(
        `INSERT INTO orders (
           id, project_id, author_user_id, objective, priority, status
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          orderId,
          projectId,
          userId,
          "Create canonical persistence",
          "P0",
          "READY"
        ]
      );
      await client.query(
        `INSERT INTO requirements (
           id, project_id, order_id, requirement_key, title, description
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          requirementId,
          projectId,
          orderId,
          "REQ-TEST-001",
          "Persistence",
          "Persist canonical records"
        ]
      );
      await client.query(
        `INSERT INTO tasks (
           id, project_id, order_id, repository_id, title, status, risk
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [taskId, projectId, orderId, repositoryId, "Task", "PLANNED", "R2"]
      );
      await client.query(
        `INSERT INTO task_runs (
           id, task_id, status, correlation_id, provider, model
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [taskRunId, taskId, "RUNNING", "corr-test", "openai", "test-model"]
      );
      // A canonical persistence graph must not manufacture an approval outside
      // AWAITING_HUMAN. Approval insertion is exercised by lifecycle tests.
      await client.query(
        `INSERT INTO audit_events (
           id, organization_id, project_id, task_id, actor_type,
           actor_id, action, target_type, target_id, result, risk
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          auditEventId,
          organizationId,
          projectId,
          taskId,
          "USER",
          userId,
          "TASK_CREATED",
          "TASK",
          taskId,
          "SUCCESS",
          "R2"
        ]
      );
      await client.query(
        `INSERT INTO cost_events (
           id, organization_id, project_id, order_id, task_id,
           provider, model, amount
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          costEventId,
          organizationId,
          projectId,
          orderId,
          taskId,
          "openai",
          "test-model",
          0.25
        ]
      );
      await client.query(
        `INSERT INTO notifications (
           id, organization_id, project_id, task_id, user_id,
           kind, title, body
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          notificationId,
          organizationId,
          projectId,
          taskId,
          userId,
          "APPROVAL_REQUIRED",
          "Approval required",
          "Review the task"
        ]
      );
      await client.query(
        `INSERT INTO deployments (
           id, project_id, repository_id, environment_id, task_id,
           provider, revision, status, url
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          deploymentId,
          projectId,
          repositoryId,
          environmentId,
          taskId,
          "test-provider",
          "rev-1",
          "READY",
          "https://staging.example.test"
        ]
      );

      const tables = [
        "organizations",
        "users",
        "clients",
        "projects",
        "repositories",
        "environments",
        "orders",
        "requirements",
        "tasks",
        "task_runs",
        "audit_events",
        "cost_events",
        "notifications",
        "deployments"
      ];

      for (const table of tables) {
        const result = await client.query(
          `SELECT COUNT(*)::int AS count FROM ${table}`
        );
        expect(result.rows[0].count).toBeGreaterThan(0);
      }

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("tracks versioned migrations and is idempotent", async () => {
    const secondRun = await migrate(pool);
    expect(secondRun).toEqual([]);

    const result = await pool.query(
      "SELECT version FROM schema_migrations ORDER BY version"
    );
    expect(result.rows.map((row) => row.version)).toEqual([
      "0001_canonical_persistence.sql",
      "0002_auth_rbac.sql",
      "0003_queue_worker.sql",
      "0004_project_registry.sql",
      "0005_work_order_task_lifecycle.sql",
      "0006_work_order_task_review_remediation.sql",
      "0007_staging_requirement_approved_guard.sql"
    ]);
  });
});
