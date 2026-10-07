import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { WorkOrderError, WorkOrderService } from "./index.js";

const pool = createDatabasePool();
const service = new WorkOrderService(pool);
const organizationId = randomUUID();
const userId = randomUUID();
const projectId = randomUUID();

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
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM tasks WHERE project_id = $1",
    [projectId]
  );
  await pool.query(
    "DELETE FROM requirements WHERE project_id = $1",
    [projectId]
  );
  await pool.query(
    "DELETE FROM orders WHERE project_id = $1",
    [projectId]
  );
  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
  await pool.end();
});

describe("WorkOrderService", () => {
  it("persists acceptance criteria, requirements and task requirement IDs", async () => {
    const order = await service.createOrder({
      projectId,
      authorUserId: userId,
      objective: "Persist the PLT-008 workflow",
      priority: "P0",
      acceptanceCriteria: ["state is durable", "requirements are traceable"],
      requirements: [
        {
          key: `REQ-PLT008-${randomUUID()}`,
          title: "Durable lifecycle",
          description: "Persist work order and task lifecycle"
        },
        {
          key: `REQ-PLT008-${randomUUID()}`,
          title: "Requirement traceability",
          description: "Tasks retain requirement identifiers"
        }
      ]
    });

    expect(order.acceptanceCriteria).toEqual([
      "state is durable",
      "requirements are traceable"
    ]);
    expect(order.requirements).toHaveLength(2);
    expect(order.stateHistory).toMatchObject([
      { fromStatus: null, toStatus: "PLANNED" }
    ]);

    const requirementIds = order.requirements.map((requirement) => requirement.id);
    const task = await service.createTask({
      projectId,
      orderId: order.id,
      title: "Implement persistence",
      risk: "R2",
      acceptanceCriteria: ["migration passes", "illegal transitions fail"],
      requirementIds
    });

    expect(task.acceptanceCriteria).toEqual([
      "migration passes",
      "illegal transitions fail"
    ]);
    expect(task.requirementIds.sort()).toEqual([...requirementIds].sort());
    expect(task.stateHistory).toMatchObject([
      { fromStatus: null, toStatus: "PLANNED" }
    ]);

    const reloaded = await service.getOrder(order.id);
    expect(reloaded.tasks[0].requirementIds.sort()).toEqual([...requirementIds].sort());
  });

  it("persists complete legal order and task transition history", async () => {
    const order = await service.createOrder({
      projectId,
      objective: "Exercise lifecycle"
    });
    let task = await service.createTask({
      projectId,
      orderId: order.id,
      title: "Lifecycle task"
    });

    await service.transitionOrder(order.id, "READY");
    await service.transitionOrder(order.id, "IN_PROGRESS");
    const completedOrder = await service.transitionOrder(order.id, "COMPLETED");

    task = await service.transitionTask(task.id, "READY");
    task = await service.transitionTask(task.id, "IN_PROGRESS");
    task = await service.transitionTask(task.id, "VERIFYING");
    task = await service.transitionTask(task.id, "COMPLETED");

    expect(completedOrder.stateHistory.map((entry) => entry.toStatus)).toEqual([
      "PLANNED",
      "READY",
      "IN_PROGRESS",
      "COMPLETED"
    ]);
    expect(task.stateHistory.map((entry) => entry.toStatus)).toEqual([
      "PLANNED",
      "READY",
      "IN_PROGRESS",
      "VERIFYING",
      "COMPLETED"
    ]);
  });

  it("rejects illegal transitions in both the service and PostgreSQL", async () => {
    const order = await service.createOrder({
      projectId,
      objective: "Reject state jumps"
    });
    const task = await service.createTask({
      projectId,
      orderId: order.id,
      title: "Reject task jump"
    });

    await expect(
      service.transitionOrder(order.id, "COMPLETED")
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });

    await expect(
      service.transitionTask(task.id, "COMPLETED")
    ).rejects.toBeInstanceOf(WorkOrderError);

    await expect(
      pool.query("UPDATE tasks SET status = 'COMPLETED' WHERE id = $1", [task.id])
    ).rejects.toMatchObject({ code: "23514" });

    const persisted = await service.getTask(task.id);
    expect(persisted.status).toBe("PLANNED");
    expect(persisted.stateHistory).toHaveLength(1);
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
    const second = await service.createOrder({
      projectId,
      objective: "Second order"
    });

    await expect(
      service.createTask({
        projectId,
        orderId: second.id,
        title: "Invalid requirement link",
        requirementIds: [first.requirements[0].id]
      })
    ).rejects.toMatchObject({
      code: "REQUIREMENT_NOT_FOUND"
    });
  });
});
