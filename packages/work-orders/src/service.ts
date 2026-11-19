import type { Pool, PoolClient } from "pg";
import {
  ProjectRegistryError,
  ProjectRegistryService
} from "@jev/projects";
import {
  lockOrderIntentVersions,
  type IntentAcceptanceService
} from "./intent-service.js";
import type { IntentBriefGenerator } from "./intent-generator.js";
import {
  DEFAULT_AMBIGUITY_BLOCK_THRESHOLD,
  isImplementationBlocked,
  validateIntentBriefDocument
} from "./intent-validation.js";
import {
  WorkOrderError,
  type CreateTaskInput,
  type ImplementationBlock,
  type CreateWorkOrderInput,
  IntentAcceptanceError,
  type IntentBriefDocument,
  type IntentBriefRecord,
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
  /** Used by createOrderWithGeneratedIntent (PLT-040 PR 4). */
  intentGenerator?: IntentBriefGenerator;
  /**
   * Max automatic clarification rounds in createOrderWithGeneratedIntent
   * (PLT-040 PR 5), integer 0..3; 0 disables. Default env
   * JEV_INTENT_CLARIFY_ROUNDS or 1.
   */
  intentClarifyRounds?: number;
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

export const DEFAULT_INTENT_CLARIFY_ROUNDS = 1;
export const MAX_INTENT_CLARIFY_ROUNDS = 3;

function resolveClarifyRounds(explicit?: number): number {
  let value: number = DEFAULT_INTENT_CLARIFY_ROUNDS;
  if (explicit !== undefined) {
    value = explicit;
  } else {
    const raw = process.env.JEV_INTENT_CLARIFY_ROUNDS;
    if (raw !== undefined && raw.trim() !== "") value = Number(raw);
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_INTENT_CLARIFY_ROUNDS) {
    throw new RangeError(
      `intent clarify rounds must be an integer between 0 and ${MAX_INTENT_CLARIFY_ROUNDS}`
    );
  }
  return value;
}

export interface ReevaluateBlockedTasksResult {
  orderId: string;
  intentId: string | null;
  intentVersion: number | null;
  /** True when the latest IntentBrief still blocks (or there is none): nothing was touched. */
  stillBlocked: boolean;
  unblockedTaskIds: string[];
}

export class WorkOrderService {
  private readonly projects: ProjectRegistryService;
  private readonly intentService?: IntentAcceptanceService;
  private readonly intentGenerator?: IntentBriefGenerator;
  private readonly ambiguityThreshold: number;
  private readonly clarifyRounds: number;

  constructor(
    private readonly pool: Pool,
    projects?: ProjectRegistryService,
    options: WorkOrderServiceOptions = {}
  ) {
    this.projects = projects ?? new ProjectRegistryService(pool);
    this.intentService = options.intentService;
    this.intentGenerator = options.intentGenerator;
    this.ambiguityThreshold = resolveAmbiguityThreshold(options.ambiguityThreshold);
    this.clarifyRounds = resolveClarifyRounds(options.intentClarifyRounds);
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

  /**
   * PLT-040 PR 4: generates the IntentBrief from the objective with the injected
   * generator, then calls createOrder with it. If generation fails (or the
   * gateway blocks/fails) the error propagates and nothing is created.
   * `gatewayTaskId` is the existing task the gateway bills the call to.
   */
  async createOrderWithGeneratedIntent(
    input: Omit<CreateWorkOrderInput, "intent">,
    gatewayTaskId: string
  ): Promise<WorkOrderRecord> {
    // Both are needed BEFORE any paid model call: without intentService the
    // generated brief would be silently dropped by createOrder.
    if (!this.intentGenerator || !this.intentService) {
      throw new WorkOrderError(
        "INVALID_ORDER",
        "createOrderWithGeneratedIntent requires an intentGenerator and an intentService"
      );
    }
    assertNonEmpty(input.objective, "objective");
    const project = await this.pool.query(
      "SELECT organization_id, name FROM projects WHERE id = $1",
      [input.projectId]
    );
    if (!project.rows.length) {
      throw new WorkOrderError("INVALID_ORDER", "project not found");
    }
    const generateInput = {
      objective: input.objective,
      organizationId: String(project.rows[0].organization_id).toLowerCase(),
      projectId: input.projectId,
      taskId: gatewayTaskId,
      projectName: String(project.rows[0].name),
      knownRequirements: (input.requirements ?? []).map(
        (r) => `${r.key}: ${r.title} - ${r.description}`
      ),
      constraints: (input.constraints ?? []).map((c) =>
        typeof c === "string" ? c : JSON.stringify(c)
      ),
      acceptanceCriteria: input.acceptanceCriteria ?? []
    };
    const generated = await this.intentGenerator.generate(generateInput);
    // PLT-040 PR 5: bounded automatic clarification. Every version is kept
    // (append-only) and saved in the SAME transaction as the order; if a round
    // fails the error propagates before anything is written.
    const versions: IntentBriefDocument[] = [generated.document];
    for (
      let round = 0;
      round < this.clarifyRounds &&
      isImplementationBlocked(versions[versions.length - 1], this.ambiguityThreshold);
      round += 1
    ) {
      const clarified = await this.intentGenerator.clarify({
        ...generateInput,
        brief: versions[versions.length - 1]
      });
      versions.push(clarified.document);
    }
    return this.insertOrder(
      { ...input, intent: versions[versions.length - 1] },
      versions.slice(0, -1)
    );
  }

  /**
   * PLT-040 PR 5: explicit unblocking. If the LATEST IntentBrief of the order no
   * longer blocks, moves to READY (SYSTEM actor, evidence with intent id and
   * previous/new version) ONLY the BLOCKED tasks whose latest BLOCKED history
   * entry has evidence.code AMBIGUOUS_INTENT. Tasks blocked for other reasons
   * are untouched. Idempotent: already unblocked tasks are no longer BLOCKED.
   * Saving a new IntentBrief never calls this; wiring it in API/worker comes later.
   */
  async reevaluateBlockedTasks(orderId: string): Promise<ReevaluateBlockedTasksResult> {
    if (!this.intentService) {
      throw new WorkOrderError(
        "INVALID_ORDER",
        "reevaluateBlockedTasks requires an intentService"
      );
    }
    const scope = await this.pool.query(
      `SELECT o.intent_legacy, p.organization_id
         FROM orders o JOIN projects p ON p.id = o.project_id
        WHERE o.id = $1`,
      [orderId]
    );
    if (!scope.rows[0]) throw new WorkOrderError("ORDER_NOT_FOUND");
    const intent = await this.intentService.getLatestIntentBriefForOrder(
      String(scope.rows[0].organization_id).toLowerCase(),
      orderId
    );
    const result: ReevaluateBlockedTasksResult = {
      orderId,
      intentId: intent?.id ?? null,
      intentVersion: intent?.version ?? null,
      stillBlocked: true,
      unblockedTaskIds: []
    };
    if (!intent || isImplementationBlocked(intent.document, this.ambiguityThreshold)) {
      return result;
    }
    result.stillBlocked = false;
    // Candidates only: every decision is re-taken inside the per-task transaction.
    const candidates = await this.pool.query(
      "SELECT id FROM tasks WHERE order_id = $1 AND status = 'BLOCKED' ORDER BY created_at, id",
      [orderId]
    );
    const organizationId = String(scope.rows[0].organization_id).toLowerCase();
    for (const row of candidates.rows) {
      const outcome = await this.unblockTaskIfStillAmbiguous(
        organizationId,
        orderId,
        row.id as string
      );
      if (outcome.kind === "order_blocked") {
        // The latest version (saved after our first read) blocks again: stop.
        result.intentId = outcome.intent?.id ?? null;
        result.intentVersion = outcome.intent?.version ?? null;
        result.stillBlocked = true;
        break;
      }
      if (outcome.kind === "unblocked") {
        result.intentId = outcome.intent.id;
        result.intentVersion = outcome.intent.version;
        result.unblockedTaskIds.push(row.id as string);
      }
    }
    return result;
  }

  /**
   * One transaction per task. Lock order (see lockOrderIntentVersions): per-order
   * advisory lock FIRST, then the project-first row locks that
   * jev_transition_task takes itself. Under the advisory lock the LATEST
   * IntentBrief is re-read, so a version saved by saveIntentBrief (which takes
   * the same lock) either commits before this read (and is honoured) or waits
   * until this transaction ends.
   *
   * Task side: the runtime role has no UPDATE privilege on tasks, so
   * SELECT ... FOR UPDATE on it is not allowed. Instead the state and the id of
   * the latest BLOCKED history entry are read first (cheap early exit), and
   * after jev_transition_task (which takes the project lock that serializes
   * every task writer, then updates the row) the latest BLOCKED entry is read
   * again: if it is not the same one (the task was released and re-blocked by
   * someone else in between, with a possibly different cause), the transaction
   * is rolled back and the newer block is preserved.
   */
  private async unblockTaskIfStillAmbiguous(
    organizationId: string,
    orderId: string,
    taskId: string
  ): Promise<
    | { kind: "unblocked"; intent: IntentBriefRecord }
    | { kind: "skipped" }
    | { kind: "order_blocked"; intent: IntentBriefRecord | null }
  > {
    const latestBlock = (client: PoolClient) =>
      client.query(
        `SELECT t.status,
                h.id AS history_id,
                h.evidence
           FROM tasks t
           LEFT JOIN LATERAL (
             SELECT id, evidence FROM task_state_history
              WHERE task_id = t.id AND to_status = 'BLOCKED'
              ORDER BY created_at DESC, id DESC LIMIT 1
           ) h ON TRUE
          WHERE t.id = $1 AND t.order_id = $2`,
        [taskId, orderId]
      );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOrderIntentVersions(client, orderId);
      const intent = await this.intentService!.getLatestIntentBriefForOrder(
        organizationId,
        orderId,
        client
      );
      if (!intent || isImplementationBlocked(intent.document, this.ambiguityThreshold)) {
        await client.query("ROLLBACK");
        return { kind: "order_blocked", intent };
      }
      const before = (await latestBlock(client)).rows[0];
      const evidence = (before?.evidence ?? {}) as Record<string, unknown>;
      if (
        !before ||
        before.status !== "BLOCKED" ||
        evidence.code !== "AMBIGUOUS_INTENT"
      ) {
        await client.query("ROLLBACK");
        return { kind: "skipped" };
      }
      const context: TransitionContext = {
        actorType: "SYSTEM",
        cause: "implementation unblocked: IntentBrief ambiguity resolved",
        evidence: {
          code: "AMBIGUOUS_INTENT_RESOLVED",
          intent_id: intent.id,
          previous_intent_id: evidence.intent_id ?? null,
          previous_intent_version: evidence.intent_version ?? null,
          intent_version: intent.version,
          ambiguity_score: intent.ambiguityScore,
          clarification_required: intent.clarificationRequired,
          threshold: this.ambiguityThreshold,
          reason: "latest IntentBrief version no longer blocks implementation"
        }
      };
      await applyTransitionContext(client, context);
      await client.query(
        "SELECT jev_transition_task($1::uuid,$2::text,$3::text,$4::text,$5::text,$6::jsonb) AS id",
        [taskId, "READY", "SYSTEM", null, context.cause, JSON.stringify(context.evidence)]
      );
      // The project lock is now held: nobody else can write this task. Verify
      // that the block we decided on is still the latest one.
      const after = (await latestBlock(client)).rows[0];
      if (!after || after.history_id !== before.history_id) {
        await client.query("ROLLBACK");
        return { kind: "skipped" };
      }
      await client.query("COMMIT");
      return { kind: "unblocked", intent };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      // A concurrent call may have moved it already: skip, stay idempotent.
      if (isConstraintViolation(error)) return { kind: "skipped" };
      throw error;
    } finally {
      client.release();
    }
  }

  async createOrder(input: CreateWorkOrderInput): Promise<WorkOrderRecord> {
    return this.insertOrder(input, []);
  }

  /** `priorIntents`: earlier (clarified-away) versions saved before the final one, same transaction. */
  private async insertOrder(
    input: CreateWorkOrderInput,
    priorIntents: IntentBriefDocument[]
  ): Promise<WorkOrderRecord> {
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

    // PLT-040 PR 3: with an IntentAcceptanceService every new order needs a valid
    // IntentBrief, checked before anything is written.
    let organizationId: string | undefined;
    if (this.intentService) {
      if (input.intent === undefined || input.intent === null) {
        throw new WorkOrderError(
          "INTENT_REQUIRED",
          "a new order requires an IntentBrief (intent)"
        );
      }
      try {
        validateIntentBriefDocument(input.intent);
      } catch (error) {
        if (error instanceof IntentAcceptanceError) {
          throw new WorkOrderError(
            "INVALID_INTENT",
            `invalid IntentBrief: ${error.message}${error.details.length ? ` (${error.details.join("; ")})` : ""}`,
            error.details
          );
        }
        throw error;
      }
      // orders carry no organization: it is that of their project.
      const project = await this.pool.query(
        "SELECT organization_id FROM projects WHERE id = $1",
        [input.projectId]
      );
      if (!project.rows.length) {
        throw new WorkOrderError("INVALID_ORDER", "project not found");
      }
      organizationId = String(project.rows[0].organization_id).toLowerCase();
    }

    const client = await this.pool.connect();
    let orderId: string;
    let intentBrief: IntentBriefRecord | undefined;
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

      if (this.intentService && organizationId) {
        // Same transaction: order and IntentBrief commit or roll back together.
        try {
          for (const prior of priorIntents) {
            await this.intentService.saveIntentBrief(
              organizationId,
              { orderId, document: prior },
              client
            );
          }
          intentBrief = await this.intentService.saveIntentBrief(
            organizationId,
            { orderId, document: input.intent },
            client
          );
        } catch (error) {
          if (error instanceof IntentAcceptanceError) {
            throw new WorkOrderError(
              "INVALID_INTENT",
              `IntentBrief could not be saved: ${error.message}`,
              error.details
            );
          }
          throw error;
        }
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const order = await this.getOrder(orderId);
    if (intentBrief) {
      order.intent = {
        id: intentBrief.id,
        version: intentBrief.version,
        brief: intentBrief
      };
    }
    return order;
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
        // Unblocking is explicit: reevaluateBlockedTasks (PLT-040 PR 5).
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
          ORDER BY created_at, (from_status IS NOT NULL), id`,
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
