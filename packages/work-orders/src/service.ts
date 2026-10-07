import type { Pool, PoolClient } from "pg";
import {
  WorkOrderError,
  type CreateTaskInput,
  type CreateWorkOrderInput,
  type OrderStatus,
  type RequirementRecord,
  type StateHistoryEntry,
  type TaskRecord,
  type TaskStatus,
  type WorkOrderRecord
} from "./types.js";

function isConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23514"
  );
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new WorkOrderError("INVALID_ORDER", `${field} is required`);
  }
}

function parseJsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function mapHistory<TStatus extends string>(rows: any[]): StateHistoryEntry<TStatus>[] {
  return rows.map((row) => ({
    fromStatus: row.from_status as TStatus | null,
    toStatus: row.to_status as TStatus,
    createdAt: new Date(row.created_at).toISOString()
  }));
}

export class WorkOrderService {
  constructor(private readonly pool: Pool) {}

  async createOrder(input: CreateWorkOrderInput): Promise<WorkOrderRecord> {
    assertNonEmpty(input.objective, "objective");

    const requirementKeys = new Set<string>();
    for (const requirement of input.requirements ?? []) {
      assertNonEmpty(requirement.key, "requirement key");
      assertNonEmpty(requirement.title, "requirement title");
      assertNonEmpty(requirement.description, "requirement description");
      if (requirementKeys.has(requirement.key)) {
        throw new WorkOrderError("INVALID_ORDER", "duplicate requirement key");
      }
      requirementKeys.add(requirement.key);
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const orderResult = await client.query(
        `INSERT INTO orders (
           project_id, author_user_id, objective, priority, status, work_type,
           constraints, acceptance_criteria, attachments
         ) VALUES ($1, $2, $3, $4, 'PLANNED', $5, $6::jsonb, $7::jsonb, $8::jsonb)
         RETURNING id`,
        [
          input.projectId,
          input.authorUserId ?? null,
          input.objective.trim(),
          input.priority ?? "NORMAL",
          input.workType ?? "GENERAL",
          JSON.stringify(input.constraints ?? []),
          JSON.stringify(input.acceptanceCriteria ?? []),
          JSON.stringify(input.attachments ?? [])
        ]
      );

      const orderId = orderResult.rows[0].id as string;
      for (const requirement of input.requirements ?? []) {
        await client.query(
          `INSERT INTO requirements (
             project_id, order_id, requirement_key, title, description, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            input.projectId,
            orderId,
            requirement.key.trim(),
            requirement.title.trim(),
            requirement.description.trim(),
            JSON.stringify(requirement.metadata ?? {})
          ]
        );
      }

      await client.query("COMMIT");
      return await this.getOrder(orderId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    assertNonEmpty(input.title, "task title");
    const requirementIds = [...new Set(input.requirementIds ?? [])];
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const orderResult = await client.query(
        "SELECT id, project_id FROM orders WHERE id = $1 FOR UPDATE",
        [input.orderId]
      );
      const order = orderResult.rows[0];
      if (!order) {
        throw new WorkOrderError("ORDER_NOT_FOUND");
      }
      if (order.project_id !== input.projectId) {
        throw new WorkOrderError("INVALID_ORDER", "order does not belong to project");
      }

      if (requirementIds.length > 0) {
        const requirements = await client.query(
          `SELECT id
             FROM requirements
            WHERE id = ANY($1::uuid[])
              AND project_id = $2
              AND order_id = $3`,
          [requirementIds, input.projectId, input.orderId]
        );
        if (requirements.rowCount !== requirementIds.length) {
          throw new WorkOrderError(
            "REQUIREMENT_NOT_FOUND",
            "every task requirement must belong to the same work order"
          );
        }
      }

      const taskResult = await client.query(
        `INSERT INTO tasks (
           project_id, order_id, repository_id, title, status, risk, acceptance_criteria
         ) VALUES ($1, $2, $3, $4, 'PLANNED', $5, $6::jsonb)
         RETURNING id`,
        [
          input.projectId,
          input.orderId,
          input.repositoryId ?? null,
          input.title.trim(),
          input.risk ?? "R0",
          JSON.stringify(input.acceptanceCriteria ?? [])
        ]
      );

      const taskId = taskResult.rows[0].id as string;
      for (const requirementId of requirementIds) {
        await client.query(
          "INSERT INTO task_requirements (task_id, requirement_id) VALUES ($1, $2)",
          [taskId, requirementId]
        );
      }

      await client.query("COMMIT");
      return await this.getTask(taskId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async transitionOrder(orderId: string, toStatus: OrderStatus): Promise<WorkOrderRecord> {
    try {
      const result = await this.pool.query(
        "UPDATE orders SET status = $2 WHERE id = $1 RETURNING id",
        [orderId, toStatus]
      );
      if (!result.rows[0]) {
        throw new WorkOrderError("ORDER_NOT_FOUND");
      }
      return await this.getOrder(orderId);
    } catch (error) {
      if (isConstraintViolation(error)) {
        throw new WorkOrderError("ILLEGAL_TRANSITION", "illegal order state transition");
      }
      throw error;
    }
  }

  async transitionTask(taskId: string, toStatus: TaskStatus): Promise<TaskRecord> {
    try {
      const result = await this.pool.query(
        "UPDATE tasks SET status = $2 WHERE id = $1 RETURNING id",
        [taskId, toStatus]
      );
      if (!result.rows[0]) {
        throw new WorkOrderError("TASK_NOT_FOUND");
      }
      return await this.getTask(taskId);
    } catch (error) {
      if (isConstraintViolation(error)) {
        throw new WorkOrderError("ILLEGAL_TRANSITION", "illegal task state transition");
      }
      throw error;
    }
  }

  async getOrder(orderId: string): Promise<WorkOrderRecord> {
    const result = await this.pool.query(
      `SELECT id, project_id, author_user_id, objective, priority, status, work_type,
              constraints, acceptance_criteria, attachments
         FROM orders
        WHERE id = $1`,
      [orderId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new WorkOrderError("ORDER_NOT_FOUND");
    }

    const [requirementsResult, tasksResult, historyResult] = await Promise.all([
      this.pool.query(
        `SELECT id, requirement_key, title, description, status, metadata
           FROM requirements
          WHERE order_id = $1
          ORDER BY requirement_key`,
        [orderId]
      ),
      this.pool.query(
        "SELECT id FROM tasks WHERE order_id = $1 ORDER BY created_at, id",
        [orderId]
      ),
      this.pool.query(
        `SELECT from_status, to_status, created_at
           FROM order_state_history
          WHERE order_id = $1
          ORDER BY created_at, id`,
        [orderId]
      )
    ]);

    const requirements: RequirementRecord[] = requirementsResult.rows.map((requirement) => ({
      id: requirement.id,
      key: requirement.requirement_key,
      title: requirement.title,
      description: requirement.description,
      status: requirement.status,
      metadata: requirement.metadata ?? {}
    }));
    const tasks = await Promise.all(
      tasksResult.rows.map((task) => this.getTask(task.id as string))
    );

    return {
      id: row.id,
      projectId: row.project_id,
      authorUserId: row.author_user_id,
      objective: row.objective,
      priority: row.priority,
      status: row.status as OrderStatus,
      workType: row.work_type,
      constraints: parseJsonArray(row.constraints),
      acceptanceCriteria: parseJsonArray<string>(row.acceptance_criteria),
      attachments: parseJsonArray(row.attachments),
      requirements,
      tasks,
      stateHistory: mapHistory<OrderStatus>(historyResult.rows)
    };
  }

  async getTask(taskId: string): Promise<TaskRecord> {
    const result = await this.pool.query(
      `SELECT id, project_id, order_id, repository_id, title, status, risk,
              acceptance_criteria
         FROM tasks
        WHERE id = $1`,
      [taskId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new WorkOrderError("TASK_NOT_FOUND");
    }

    const [requirementsResult, historyResult] = await Promise.all([
      this.pool.query(
        `SELECT requirement_id
           FROM task_requirements
          WHERE task_id = $1
          ORDER BY requirement_id`,
        [taskId]
      ),
      this.pool.query(
        `SELECT from_status, to_status, created_at
           FROM task_state_history
          WHERE task_id = $1
          ORDER BY created_at, id`,
        [taskId]
      )
    ]);

    return {
      id: row.id,
      projectId: row.project_id,
      orderId: row.order_id,
      repositoryId: row.repository_id,
      title: row.title,
      status: row.status as TaskStatus,
      risk: row.risk,
      acceptanceCriteria: parseJsonArray<string>(row.acceptance_criteria),
      requirementIds: requirementsResult.rows.map((item) => item.requirement_id),
      stateHistory: mapHistory<TaskStatus>(historyResult.rows)
    };
  }
}
