import type { Pool, PoolClient } from "pg";
import {
  ProjectRegistryError,
  ProjectRegistryService
} from "@jev/projects";
import type { IntentAcceptanceService } from "./intent-service.js";
import {
  DEFAULT_AMBIGUITY_BLOCK_THRESHOLD,
  isImplementationBlocked
} from "./intent-validation.js";
import {
  WorkOrderError,
  type CreateTaskInput,
  type ImplementationBlock,
  type CreateWorkOrderInput,
  type OrderStatus,
  type RequirementRecord,
  type StateHistoryEntry,
  type TaskRecord,
  type TaskStatus,
  type TransitionContext,
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
    actorType: row.actor_type,
    actorId: row.actor_id,
    cause: row.cause,
    evidence: row.evidence ?? {},
    createdAt: new Date(row.created_at).toISOString()
  }));
}

async function applyTransitionContext(
  client: PoolClient,
  context: TransitionContext
): Promise<void> {
  assertNonEmpty(context.cause, "transition cause");
  if (
    context.actorType !== "SYSTEM" &&
    (typeof context.actorId !== "string" || !context.actorId.trim())
  ) {
    throw new WorkOrderError(
      "INVALID_ORDER",
      "transition actor ID is required for USER and AGENT actors"
    );
  }
  await client.query(
    "SELECT set_config('jev.transition_actor_type', $1, true)",
    [context.actorType]
  );
  await client.query(
    "SELECT set_config('jev.transition_actor_id', $1, true)",
    [context.actorId ?? ""]
  );
  await client.query(
    "SELECT set_config('jev.transition_cause', $1, true)",
    [context.cause.trim()]
  );
  await client.query(
    "SELECT set_config('jev.transition_evidence', $1, true)",
    [JSON.stringify(context.evidence ?? {})]
  );
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof ProjectRegistryError) {
    if (error.code === "AMBIGUOUS_REPOSITORY_TARGET") {
      throw new WorkOrderError(
        "AMBIGUOUS_REPOSITORY_TARGET",
        error.message
      );
    }
    if (error.code === "REPOSITORY_NOT_FOUND") {
      throw new WorkOrderError("REPOSITORY_NOT_FOUND", error.message);
    }
    if (error.code === "PROJECT_NOT_FOUND") {
      throw new WorkOrderError("INVALID_ORDER", "project not found");
    }
  }
  throw error;
}

export interface WorkOrderServiceOptions {
  /**
   * When set, createTask blocks new tasks of orders whose latest IntentBrief is
   * materially ambiguous (PLT-040 PR 2). Without it behaviour is unchanged.
   */
  intentService?: IntentAcceptanceService;
  /** Ambiguity threshold in [0,1]; default env JEV_AMBIGUITY_BLOCK_THRESHOLD or 0.5. */
  ambiguityThreshold?: number;
}

function resolveAmbiguityThreshold(explicit?: number): number {
  let value: number = DEFAULT_AMBIGUITY_BLOCK_THRESHOLD;
  if (explicit !== undefined) {
    value = explicit;
  } else {
    const raw = process.env.JEV_AMBIGUITY_BLOCK_THRESHOLD;
    if (raw !== undefined && raw.trim() !== "") value = Number(raw);
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("ambiguity threshold must be a number between 0 and 1");
  }
  return value;
}

export class WorkOrderService {
  private readonly projects: ProjectRegistryService;
  private readonly intentService?: IntentAcceptanceService;
  private readonly ambiguityThreshold: number;

  constructor(
    private readonly pool: Pool,
    projects?: ProjectRegistryService,
    options: WorkOrderServiceOptions = {}
  ) {
    this.projects = projects ?? new ProjectRegistryService(pool);
    this.intentService = options.intentService;
    this.ambiguityThreshold = resolveAmbiguityThreshold(options.ambiguityThreshold);
  }

  /**
   * Material ambiguity gate. Returns the block description, or null when the
   * task may proceed: no intent service, unknown order, legacy order (no
   * behaviour change) or order without IntentBrief (IntentBrief becomes
   * mandatory for new orders in PLT-040 PR 3). Always uses the latest version,
   * so a later clarified IntentBrief unblocks new tasks. Read before BEGIN, so
   * an IntentBrief saved concurrently after this read is not seen.
   */
  private async evaluateImplementationBlock(
    input: CreateTaskInput
  ): Promise<ImplementationBlock | null> {
    if (!this.intentService) return null;
    const scope = await this.pool.query(
      `SELECT o.intent_legacy, p.organization_id
         FROM orders o JOIN projects p ON p.id = o.project_id
        WHERE o.id = $1 AND o.project_id = $2`,
      [input.orderId, input.projectId]
    );
    const row = scope.rows[0];
    if (!row || row.intent_legacy === true) return null;
    const intent = await this.intentService.getLatestIntentBriefForOrder(
      row.organization_id,
      input.orderId
    );
    if (!intent) return null;
    if (!isImplementationBlocked(intent.document, this.ambiguityThreshold)) {
      return null;
    }
    return {
      code: "AMBIGUOUS_INTENT",
      intentId: intent.id,
      intentVersion: intent.version,
      ambiguityScore: intent.ambiguityScore,
      clarificationRequired: intent.clarificationRequired,
      threshold: this.ambiguityThreshold
    };
  }

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
    let orderId: string;
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

      orderId = orderResult.rows[0].id as string;
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
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.getOrder(orderId);
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    assertNonEmpty(input.title, "task title");
    const requirementIds = [...new Set(input.requirementIds ?? [])];

    let repositoryId: string;
    try {
      const repository = await this.projects.resolveRepository(
        input.projectId,
        input.repositoryId
      );
      repositoryId = repository.id;
    } catch (error) {
      mapRepositoryError(error);
    }

    const block = await this.evaluateImplementationBlock(input);
    const client = await this.pool.connect();
    let taskId: string;

    try {
      await client.query("BEGIN");
      // Only read here: the SECURITY DEFINER writer acquires the canonical
      // project-first locks. The restricted role intentionally has no UPDATE
      // privilege on projects and cannot SELECT ... FOR NO KEY UPDATE.
      const projectScope = await client.query(
        "SELECT id FROM projects WHERE id = $1",
        [input.projectId]
      );
      if (!projectScope.rows[0]) {
        throw new WorkOrderError("INVALID_ORDER", "project not found");
      }
      const orderResult = await client.query(
        "SELECT id, project_id FROM orders WHERE id = $1",
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
        "SELECT jev_create_task($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::jsonb) AS id",
        [
          input.projectId,
          input.orderId,
          repositoryId,
          input.title.trim(),
          input.risk ?? "R0",
          JSON.stringify(input.acceptanceCriteria ?? [])
        ]
      );

      taskId = taskResult.rows[0].id as string;
      for (const requirementId of requirementIds) {
        await client.query(
          "INSERT INTO task_requirements (task_id, requirement_id) VALUES ($1, $2)",
          [taskId, requirementId]
        );
      }

      if (block) {
        // Same transaction as creation: the task is never observable as PLANNED.
        // The creation trigger requires PLANNED, so it is moved to BLOCKED here.
        // Unblocking (BLOCKED -> READY, already legal) requires a newer
        // IntentBrief version with clarification resolved; not implemented yet.
        const context: TransitionContext = {
          actorType: "SYSTEM",
          cause: "implementation blocked: material ambiguity in IntentBrief",
          evidence: {
            code: block.code,
            intent_id: block.intentId,
            intent_version: block.intentVersion,
            ambiguity_score: block.ambiguityScore,
            clarification_required: block.clarificationRequired,
            threshold: block.threshold
          }
        };
        await applyTransitionContext(client, context);
        await client.query(
          "SELECT jev_transition_task($1::uuid,$2::text,$3::text,$4::text,$5::text,$6::jsonb) AS id",
          [taskId, "BLOCKED", "SYSTEM", null, context.cause,
           JSON.stringify(context.evidence)]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const task = await this.getTask(taskId);
    return block ? { ...task, implementationBlock: block } : task;
  }

  async transitionOrder(
    orderId: string,
    toStatus: OrderStatus,
    context: TransitionContext
  ): Promise<WorkOrderRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await applyTransitionContext(client, context);
      const result = await client.query(
        "UPDATE orders SET status = $2 WHERE id = $1 RETURNING id",
        [orderId, toStatus]
      );
      if (!result.rows[0]) {
        throw new WorkOrderError("ORDER_NOT_FOUND");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (isConstraintViolation(error)) {
        throw new WorkOrderError("ILLEGAL_TRANSITION", "illegal order state transition");
      }
      throw error;
    } finally {
      client.release();
    }

    return this.getOrder(orderId);
  }

  async transitionTask(
    taskId: string,
    toStatus: TaskStatus,
    context: TransitionContext
  ): Promise<TaskRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Preserve service-level validation and typed errors for invalid actor context.
      await applyTransitionContext(client, context);
      const result = await client.query(
        "SELECT jev_transition_task($1::uuid,$2::text,$3::text,$4::text,$5::text,$6::jsonb) AS id",
        [taskId, toStatus, context.actorType, context.actorId ?? null,
         context.cause, JSON.stringify(context.evidence ?? {})]
      );
      if (!result.rows[0]?.id) {
        throw new WorkOrderError("TASK_NOT_FOUND");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (isConstraintViolation(error)) {
        throw new WorkOrderError("ILLEGAL_TRANSITION", "illegal task state transition");
      }
      throw error;
    } finally {
      client.release();
    }

    return this.getTask(taskId);
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
        `SELECT from_status, to_status, actor_type, actor_id, cause, evidence, created_at
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
        `SELECT from_status, to_status, actor_type, actor_id, cause, evidence, created_at
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
