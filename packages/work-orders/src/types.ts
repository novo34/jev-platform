export type OrderStatus =
  | "PLANNED"
  | "READY"
  | "IN_PROGRESS"
  | "BLOCKED"
  | "COMPLETED"
  | "CANCELLED";

export type TaskStatus =
  | "PLANNED"
  | "READY"
  | "RUNNING"
  | "VERIFYING"
  | "VERIFIED"
  | "STAGING"
  | "AWAITING_HUMAN"
  | "APPROVED"
  | "DONE"
  | "BLOCKED"
  | "FAILED"
  | "CHANGES_REQUESTED"
  | "REJECTED";

export type TransitionContext =
  | {
      actorType: "SYSTEM";
      actorId?: never;
      cause: string;
      evidence?: Record<string, unknown>;
    }
  | {
      actorType: "USER" | "AGENT";
      actorId: string;
      cause: string;
      evidence?: Record<string, unknown>;
    };

export type TransitionActorType = TransitionContext["actorType"];

export interface RequirementInput {
  key: string;
  title: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface CreateWorkOrderInput {
  projectId: string;
  authorUserId?: string;
  objective: string;
  priority?: string;
  workType?: string;
  constraints?: unknown[];
  acceptanceCriteria?: string[];
  attachments?: unknown[];
  requirements?: RequirementInput[];
}

export interface CreateTaskInput {
  projectId: string;
  orderId: string;
  repositoryId?: string;
  title: string;
  risk?: "R0" | "R1" | "R2" | "R3" | "R4";
  acceptanceCriteria?: string[];
  requirementIds?: string[];
}

export interface RequirementRecord {
  id: string;
  key: string;
  title: string;
  description: string;
  status: string;
  metadata: Record<string, unknown>;
}

export interface StateHistoryEntry<TStatus extends string> {
  fromStatus: TStatus | null;
  toStatus: TStatus;
  actorType: TransitionActorType;
  actorId: string | null;
  cause: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  orderId: string;
  repositoryId: string;
  title: string;
  status: TaskStatus;
  risk: string;
  acceptanceCriteria: string[];
  requirementIds: string[];
  stateHistory: StateHistoryEntry<TaskStatus>[];
}

export interface WorkOrderRecord {
  id: string;
  projectId: string;
  authorUserId: string | null;
  objective: string;
  priority: string;
  status: OrderStatus;
  workType: string;
  constraints: unknown[];
  acceptanceCriteria: string[];
  attachments: unknown[];
  requirements: RequirementRecord[];
  tasks: TaskRecord[];
  stateHistory: StateHistoryEntry<OrderStatus>[];
}

export class WorkOrderError extends Error {
  constructor(
    public readonly code:
      | "INVALID_ORDER"
      | "ORDER_NOT_FOUND"
      | "TASK_NOT_FOUND"
      | "REQUIREMENT_NOT_FOUND"
      | "REPOSITORY_NOT_FOUND"
      | "AMBIGUOUS_REPOSITORY_TARGET"
      | "ILLEGAL_TRANSITION",
    message: string = code
  ) {
    super(message);
    this.name = "WorkOrderError";
  }
}
