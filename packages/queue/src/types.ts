export type JobStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export interface QueueJob {
  id: string;
  queue: string;
  jobType: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attemptCount: number;
  maxAttempts: number;
  correlationId: string;
  projectId: string | null;
  orderId: string | null;
  taskId: string | null;
}

export interface EnqueueInput {
  queue?: string;
  jobType: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  maxAttempts?: number;
  correlationId: string;
  projectId?: string;
  orderId?: string;
  taskId?: string;
}
