import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabasePool, DEFAULT_MIGRATIONS_DIR } from "./index.js";

async function migration(name: string): Promise<string> {
  return readFile(path.join(DEFAULT_MIGRATIONS_DIR, name), "utf8");
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
});
