import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { QueueService } from "./index.js";

const pool = createDatabasePool();
const queue = new QueueService(pool);
const workerId = `test-worker-${randomUUID()}`;

beforeAll(async () => {
  await migrate(pool);
  await queue.registerWorker(workerId);
});

afterAll(async () => {
  await pool.query("DELETE FROM worker_instances WHERE worker_id = $1", [workerId]);
  await pool.query("DELETE FROM jobs WHERE correlation_id LIKE 'queue-test-%'");
  await pool.end();
});

describe("QueueService", () => {
  it("deduplicates enqueue by idempotency key", async () => {
    const key = `idem-${randomUUID()}`;
    const correlationId = `queue-test-${randomUUID()}`;
    const queueName = `queue-${randomUUID()}`;

    const first = await queue.enqueue({
      queue: queueName,
      jobType: "NOOP",
      idempotencyKey: key,
      correlationId,
      payload: { value: 1 }
    });
    const second = await queue.enqueue({
      queue: queueName,
      jobType: "NOOP",
      idempotencyKey: key,
      correlationId,
      payload: { value: 2 }
    });

    expect(second.id).toBe(first.id);

    const count = await pool.query(
      "SELECT COUNT(*)::int AS count FROM jobs WHERE idempotency_key = $1",
      [key]
    );
    expect(count.rows[0].count).toBe(1);
  });

  it("claims one persisted job and marks worker state", async () => {
    const correlationId = `queue-test-${randomUUID()}`;
    const queueName = `queue-${randomUUID()}`;
    const enqueued = await queue.enqueue({
      queue: queueName,
      jobType: "NOOP",
      correlationId
    });

    const claimed = await queue.claimNext(workerId, queueName);
    expect(claimed?.id).toBe(enqueued.id);
    expect(claimed?.status).toBe("RUNNING");
    expect(claimed?.attemptCount).toBe(1);

    const worker = await pool.query(
      "SELECT status, current_job_id FROM worker_instances WHERE worker_id = $1",
      [workerId]
    );
    expect(worker.rows[0]).toMatchObject({
      status: "RUNNING",
      current_job_id: enqueued.id
    });

    await queue.complete(workerId, enqueued.id, { ok: true });
  });

  it("requeues retryable failures and permanently fails at max attempts", async () => {
    const correlationId = `queue-test-${randomUUID()}`;
    const queueName = `queue-${randomUUID()}`;
    const enqueued = await queue.enqueue({
      queue: queueName,
      jobType: "FAIL",
      correlationId,
      maxAttempts: 2
    });

    const first = await queue.claimNext(workerId, queueName);
    expect(first?.id).toBe(enqueued.id);
    await queue.fail(workerId, first!, new Error("first failure"));

    await pool.query("UPDATE jobs SET available_at = NOW() WHERE id = $1", [enqueued.id]);

    const second = await queue.claimNext(workerId, queueName);
    expect(second?.attemptCount).toBe(2);
    await queue.fail(workerId, second!, new Error("second failure"));

    const persisted = await pool.query(
      "SELECT status, attempt_count, last_error FROM jobs WHERE id = $1",
      [enqueued.id]
    );
    expect(persisted.rows[0]).toMatchObject({
      status: "FAILED",
      attempt_count: 2,
      last_error: "second failure"
    });
  });
});
