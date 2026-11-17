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

  it("does not clear the worker pointer of a different job on complete", async () => {
    const queueName = `queue-${randomUUID()}`;
    const a = await queue.enqueue({ queue: queueName, jobType: "NOOP", correlationId: `queue-test-${randomUUID()}` });
    const b = await queue.enqueue({ queue: queueName, jobType: "NOOP", correlationId: `queue-test-${randomUUID()}` });
    await queue.claimNext(workerId, queueName);
    await queue.claimNext(workerId, queueName);

    await queue.complete(workerId, a.id, { ok: true });
    const worker = await pool.query(
      "SELECT current_job_id FROM worker_instances WHERE worker_id = $1",
      [workerId]
    );
    expect(worker.rows[0].current_job_id).toBe(b.id);

    await queue.complete(workerId, b.id, { ok: true });
    const cleared = await pool.query(
      "SELECT current_job_id FROM worker_instances WHERE worker_id = $1",
      [workerId]
    );
    expect(cleared.rows[0].current_job_id).toBeNull();
  });

  it("recovers RUNNING jobs of workers without heartbeat but not of live workers", async () => {
    const deadWorker = `dead-worker-${randomUUID()}`;
    const liveWorker = `live-worker-${randomUUID()}`;
    await queue.registerWorker(deadWorker);
    await queue.registerWorker(liveWorker);
    const queueName = `queue-${randomUUID()}`;
    const mk = (maxAttempts: number) =>
      queue.enqueue({ queue: queueName, jobType: "NOOP", correlationId: `queue-test-${randomUUID()}`, maxAttempts });

    const retryable = await mk(3);
    const exhausted = await mk(1);
    const alive = await mk(3);
    const claimedDead1 = await queue.claimNext(deadWorker, queueName);
    const claimedDead2 = await queue.claimNext(deadWorker, queueName);
    const claimedLive = await queue.claimNext(liveWorker, queueName);
    expect([claimedDead1?.id, claimedDead2?.id, claimedLive?.id]).toEqual([retryable.id, exhausted.id, alive.id]);

    await pool.query(
      "UPDATE worker_instances SET last_heartbeat_at = NOW() - INTERVAL '10 minutes' WHERE worker_id = $1",
      [deadWorker]
    );

    expect(await queue.recoverStaleJobs(60_000)).toBeGreaterThanOrEqual(2);

    const rows = await pool.query(
      "SELECT id, status, locked_by, last_error FROM jobs WHERE queue = $1",
      [queueName]
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));
    expect(byId[retryable.id]).toMatchObject({ status: "QUEUED", locked_by: null, last_error: "worker_lost" });
    expect(byId[exhausted.id]).toMatchObject({ status: "FAILED", locked_by: null, last_error: "worker_lost" });
    expect(byId[alive.id]).toMatchObject({ status: "RUNNING", locked_by: liveWorker });

    await queue.complete(liveWorker, alive.id, {});
    await pool.query("DELETE FROM worker_instances WHERE worker_id = ANY($1)", [[deadWorker, liveWorker]]);
  });

  it("releases RUNNING jobs locked by a restarted worker id, only that id", async () => {
    const restarted = `restart-worker-${randomUUID()}`;
    const other = `other-worker-${randomUUID()}`;
    await queue.registerWorker(restarted);
    await queue.registerWorker(other);
    const queueName = `queue-${randomUUID()}`;
    const mk = (maxAttempts: number) =>
      queue.enqueue({ queue: queueName, jobType: "NOOP", correlationId: `queue-test-${randomUUID()}`, maxAttempts });
    const retryable = await mk(3);
    const exhausted = await mk(1);
    const foreign = await mk(3);
    await queue.claimNext(restarted, queueName);
    await queue.claimNext(restarted, queueName);
    await queue.claimNext(other, queueName);

    // The heartbeat of the restarted id is fresh, so stale recovery cannot see these jobs.
    expect(await queue.recoverStaleJobs(60_000)).toBe(0);
    expect(await queue.releaseWorkerJobs(restarted)).toBe(2);

    const rows = await pool.query("SELECT id, status, locked_by, last_error FROM jobs WHERE queue = $1", [queueName]);
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));
    expect(byId[retryable.id]).toMatchObject({ status: "QUEUED", locked_by: null, last_error: "worker_restarted" });
    expect(byId[exhausted.id]).toMatchObject({ status: "FAILED", locked_by: null, last_error: "worker_restarted" });
    expect(byId[foreign.id]).toMatchObject({ status: "RUNNING", locked_by: other });

    await queue.complete(other, foreign.id, {});
    await pool.query("DELETE FROM worker_instances WHERE worker_id = ANY($1)", [[restarted, other]]);
  });
});
