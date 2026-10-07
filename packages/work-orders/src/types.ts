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
  | "IN_PROGRESS"
  | "BLOCKED"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

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
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  orderId: string;
  repositoryId: string | null;
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
      | "ILLEGAL_TRANSITION",
    message: string = code
  ) {
    super(message);
    this.name = "WorkOrderError";
  }
}
