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
  /** Set only by createTask when the task was born BLOCKED by material ambiguity (PLT-040). */
  implementationBlock?: ImplementationBlock;
}

export interface ImplementationBlock {
  code: "AMBIGUOUS_INTENT";
  intentId: string;
  intentVersion: number;
  ambiguityScore: number;
  clarificationRequired: boolean;
  threshold: number;
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

export type ChangeRadius =
  | "LOCAL"
  | "COMPONENT"
  | "CROSS_LAYER"
  | "ARCHITECTURAL"
  | "PRODUCT";

export type DocumentationDepth = "L0" | "L1" | "L2" | "L3" | "L4";

/** Document shape of Foundation schemas/intent-brief.schema.json. */
export interface IntentBriefDocument {
  goal: string;
  requested_change: string;
  in_scope: string[];
  out_of_scope: string[];
  observed_context: string[];
  assumptions: string[];
  open_questions: string[];
  ambiguity_score: number;
  change_radius: ChangeRadius;
  risk_signals: string[];
  documentation_depth: DocumentationDepth;
  clarification_required: boolean;
  evidence_needed: string[];
}

export interface AcceptanceCriterion {
  criterion: string;
  verification: string;
}

/**
 * Document shape of Foundation schemas/acceptance-contract.schema.json.
 * `intent_id` is the Platform-assigned id of the stored IntentBrief.
 */
export interface AcceptanceContractDocument {
  intent_id: string;
  acceptance_criteria: AcceptanceCriterion[];
  constraints: string[];
  assumptions: string[];
  non_goals: string[];
  affected_requirements: string[];
  compatibility_requirements: string[];
  required_evidence: string[];
  unresolved_decisions: string[];
  specification_depth: DocumentationDepth;
}

export interface IntentBriefRecord {
  id: string;
  organizationId: string;
  orderId: string | null;
  version: number;
  document: IntentBriefDocument;
  ambiguityScore: number;
  changeRadius: ChangeRadius;
  documentationDepth: DocumentationDepth;
  clarificationRequired: boolean;
  createdAt: string;
}

export interface AcceptanceContractRecord {
  id: string;
  organizationId: string;
  intentId: string;
  orderId: string | null;
  version: number;
  document: AcceptanceContractDocument;
  specificationDepth: DocumentationDepth;
  createdAt: string;
}

export class IntentAcceptanceError extends Error {
  constructor(
    public readonly code:
      | "INVALID_DOCUMENT"
      | "INVALID_ORGANIZATION"
      | "ORDER_NOT_FOUND"
      | "INTENT_NOT_FOUND"
      | "CONFLICT",
    message: string = code,
    public readonly details: string[] = []
  ) {
    super(message);
    this.name = "IntentAcceptanceError";
  }
}
