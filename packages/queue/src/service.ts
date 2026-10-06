import type { Pool, PoolClient } from "pg";
import type { EnqueueInput, QueueJob } from "./types.js";

function rowToJob(row: any): QueueJob {
  return {
    id: row.id,
    queue: row.queue,
    jobType: row.job_type,
    payload: row.payload ?? {},
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    correlationId: row.correlation_id,
    projectId: row.project_id,
    orderId: row.order_id,
    taskId: row.task_id
  };
}

export class QueueService {
  constructor(private readonly pool: Pool) {}

  async enqueue(input: EnqueueInput): Promise<QueueJob> {
    const values = [
      input.queue ?? "default",
      input.jobType,
      JSON.stringify(input.payload ?? {}),
      input.idempotencyKey ?? null,
      input.maxAttempts ?? 3,
      input.correlationId,
      input.projectId ?? null,
      input.orderId ?? null,
      input.taskId ?? null
    ];

    const result = await this.pool.query(
      `INSERT INTO jobs (
         queue, job_type, payload, idempotency_key, max_attempts,
         correlation_id, project_id, order_id, task_id
       ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING *`,
      values
    );

    return rowToJob(result.rows[0]);
  }

  async claimNext(workerId: string, queue = "default"): Promise<QueueJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `WITH candidate AS (
           SELECT id
             FROM jobs
            WHERE queue = $1
              AND status = 'QUEUED'
              AND available_at <= NOW()
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE jobs j
            SET status = 'RUNNING',
                locked_by = $2,
                locked_at = NOW(),
                attempt_count = attempt_count + 1,
                updated_at = NOW()
           FROM candidate
          WHERE j.id = candidate.id
         RETURNING j.*`,
        [queue, workerId]
      );

      const row = result.rows[0];
      if (row) {
        await client.query(
          `UPDATE worker_instances
              SET current_job_id = $2,
                  status = 'RUNNING',
                  last_heartbeat_at = NOW()
            WHERE worker_id = $1`,
          [workerId, row.id]
        );
      }
      await client.query("COMMIT");
      return row ? rowToJob(row) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(workerId: string, jobId: string, result: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE jobs
          SET status = 'SUCCEEDED',
              result = $2::jsonb,
              finished_at = NOW(),
              updated_at = NOW(),
              locked_by = NULL,
              locked_at = NULL
        WHERE id = $1 AND status = 'RUNNING' AND locked_by = $3`,
      [jobId, JSON.stringify(result ?? null), workerId]
    );
    await this.clearWorkerJob(workerId);
  }

  async fail(workerId: string, job: QueueJob, error: unknown): Promise<void> {
    const retry = job.attemptCount < job.maxAttempts;
    await this.pool.query(
      `UPDATE jobs
          SET status = $2,
              available_at = CASE WHEN $2 = 'QUEUED' THEN NOW() + INTERVAL '1 second' ELSE available_at END,
              last_error = $3,
              finished_at = CASE WHEN $2 = 'FAILED' THEN NOW() ELSE NULL END,
              updated_at = NOW(),
              locked_by = NULL,
              locked_at = NULL
        WHERE id = $1 AND locked_by = $4`,
      [
        job.id,
        retry ? "QUEUED" : "FAILED",
        error instanceof Error ? error.message : String(error),
        workerId
      ]
    );
    await this.clearWorkerJob(workerId);
  }

  async registerWorker(workerId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO worker_instances (worker_id, status)
       VALUES ($1, 'RUNNING')
       ON CONFLICT (worker_id)
       DO UPDATE SET
         status = 'RUNNING',
         last_heartbeat_at = NOW()`,
      [workerId]
    );
  }

  async heartbeat(workerId: string): Promise<void> {
    await this.pool.query(
      "UPDATE worker_instances SET last_heartbeat_at = NOW() WHERE worker_id = $1",
      [workerId]
    );
  }

  async stopWorker(workerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE worker_instances
          SET status = 'STOPPED', current_job_id = NULL, last_heartbeat_at = NOW()
        WHERE worker_id = $1`,
      [workerId]
    );
  }

  private async clearWorkerJob(workerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE worker_instances
          SET current_job_id = NULL, last_heartbeat_at = NOW()
        WHERE worker_id = $1`,
      [workerId]
    );
  }
}
