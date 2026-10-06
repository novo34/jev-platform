import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { QueueService } from "@jev/queue";
import { WorkerRuntime } from "./runtime.js";

const pool = createDatabasePool();
const queue = new QueueService(pool);
const workerId = `runtime-worker-${randomUUID()}`;
const runtime = new WorkerRuntime(queue, {
  workerId,
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
});
