import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { QueueService } from "@jev/queue";
import { WorkerRuntime } from "./runtime.js";

const pool = createDatabasePool();
const queue = new QueueService(pool);
const workerId = `runtime-worker-${randomUUID()}`;
const queueName = `worker-queue-${randomUUID()}`;
const runtime = new WorkerRuntime(queue, {
  workerId,
  queue: queueName,
  pollIntervalMs: 60_000,
  heartbeatIntervalMs: 60_000,
  handlers: {
    LONG_TASK: async (job) => ({
      executedByWorker: true,
      value: job.payload.value
    }),
    FAIL_TASK: async () => {
      throw new Error("handler failed");
    }
  }
});

beforeAll(async () => {
  await migrate(pool);
  await runtime.start();
});

afterAll(async () => {
  await runtime.stop();
  await pool.query("DELETE FROM jobs WHERE correlation_id LIKE 'worker-test-%'");
  await pool.query("DELETE FROM worker_instances WHERE worker_id = $1", [workerId]);
  await pool.end();
});

describe("WorkerRuntime", () => {
  it("executes queued work in the worker runtime and persists completion", async () => {
    const job = await queue.enqueue({
      queue: queueName,
      jobType: "LONG_TASK",
      correlationId: `worker-test-${randomUUID()}`,
      payload: { value: 42 }
    });

    expect(await runtime.pollOnce()).toBe(true);

    const persisted = await pool.query(
      "SELECT status, result FROM jobs WHERE id = $1",
      [job.id]
    );
    expect(persisted.rows[0].status).toBe("SUCCEEDED");
    expect(persisted.rows[0].result).toEqual({
      executedByWorker: true,
      value: 42
    });
  });

  it("persists retry state when a handler fails", async () => {
    const job = await queue.enqueue({
      queue: queueName,
      jobType: "FAIL_TASK",
      correlationId: `worker-test-${randomUUID()}`,
      maxAttempts: 2
    });

    await runtime.pollOnce();

    const persisted = await pool.query(
      "SELECT status, attempt_count, last_error FROM jobs WHERE id = $1",
      [job.id]
    );
    expect(persisted.rows[0].status).toBe("QUEUED");
    expect(persisted.rows[0].attempt_count).toBe(1);
    expect(persisted.rows[0].last_error).toBe("handler failed");
  });

  it("persists worker heartbeat/state outside request processing", async () => {
    await queue.heartbeat(workerId);
    const state = await pool.query(
      "SELECT status, last_heartbeat_at FROM worker_instances WHERE worker_id = $1",
      [workerId]
    );
    expect(state.rows[0].status).toBe("RUNNING");
    expect(state.rows[0].last_heartbeat_at).toBeTruthy();
  });

  describe("robustness", () => {
    const extraWorkers: string[] = [];
    const make = (options: Partial<ConstructorParameters<typeof WorkerRuntime>[1]>) => {
      const id = `runtime-worker-${randomUUID()}`;
      extraWorkers.push(id);
      return new WorkerRuntime(queue, {
        workerId: id,
        pollIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        recoveryIntervalMs: 60_000,
        ...options
      });
    };
    const enqueue = (q: string, extra: { maxAttempts?: number } = {}) =>
      queue.enqueue({ queue: q, jobType: "SLOW", correlationId: `worker-test-${randomUUID()}`, ...extra });
    afterAll(async () => {
      await pool.query("DELETE FROM worker_instances WHERE worker_id = ANY($1)", [extraWorkers]);
    });

    it("does not claim a second job while one is in flight", async () => {
      const q = `worker-queue-${randomUUID()}`;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const rt = make({ queue: q, handlers: { SLOW: async () => { await gate; return {}; } } });
      await rt.start();
      const first = await enqueue(q);
      const second = await enqueue(q);

      const running = rt.pollOnce();
      await new Promise((r) => setTimeout(r, 100));
      expect(await rt.pollOnce()).toBe(false);
      const states = await pool.query("SELECT id, status FROM jobs WHERE queue = $1", [q]);
      expect(states.rows.find((r) => r.id === first.id).status).toBe("RUNNING");
      expect(states.rows.find((r) => r.id === second.id).status).toBe("QUEUED");

      release();
      expect(await running).toBe(true);
      await rt.stop();
    });

    it("marks job_timeout, aborts the signal and respects retries", async () => {
      const q = `worker-queue-${randomUUID()}`;
      let aborted = false;
      const rt = make({
        queue: q,
        jobTimeoutMs: 50,
        handlers: {
          SLOW: (_job, { signal }) =>
            new Promise((resolve) => {
              signal.addEventListener("abort", () => { aborted = true; resolve(null); });
            })
        }
      });
      await rt.start();
      const retry = await enqueue(q, { maxAttempts: 2 });
      await rt.pollOnce();
      expect(aborted).toBe(true);
      let row = (await pool.query("SELECT status, last_error FROM jobs WHERE id = $1", [retry.id])).rows[0];
      expect(row).toMatchObject({ status: "QUEUED", last_error: "job_timeout" });

      await pool.query("UPDATE jobs SET available_at = NOW() WHERE id = $1", [retry.id]);
      await rt.pollOnce();
      row = (await pool.query("SELECT status, last_error FROM jobs WHERE id = $1", [retry.id])).rows[0];
      expect(row).toMatchObject({ status: "FAILED", last_error: "job_timeout" });
      await rt.stop();
    });

    it("stop() waits for the in-flight handler", async () => {
      const q = `worker-queue-${randomUUID()}`;
      const rt = make({
        queue: q,
        handlers: { SLOW: async () => { await new Promise((r) => setTimeout(r, 300)); return { done: true }; } }
      });
      await rt.start();
      const job = await enqueue(q);
      void rt.pollOnce();
      await new Promise((r) => setTimeout(r, 100));
      await rt.stop();
      const row = (await pool.query("SELECT status FROM jobs WHERE id = $1", [job.id])).rows[0];
      expect(row.status).toBe("SUCCEEDED");
    });

    it("recovers orphaned jobs through the runtime", async () => {
      const q = `worker-queue-${randomUUID()}`;
      const rt = make({ queue: q, staleWorkerAfterMs: 1_000, handlers: { SLOW: async () => ({}) } });
      await rt.start();
      const deadId = `runtime-worker-${randomUUID()}`;
      extraWorkers.push(deadId);
      await queue.registerWorker(deadId);
      const job = await enqueue(q);
      await queue.claimNext(deadId, q);
      await pool.query(
        "UPDATE worker_instances SET last_heartbeat_at = NOW() - INTERVAL '1 hour' WHERE worker_id = $1",
        [deadId]
      );
      expect(await rt.recoverOnce()).toBeGreaterThanOrEqual(1);
      const row = (await pool.query("SELECT status FROM jobs WHERE id = $1", [job.id])).rows[0];
      expect(row.status).toBe("QUEUED");
      await rt.stop();
    });
  });
});
