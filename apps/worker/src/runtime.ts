import type { QueueJob } from "@jev/queue";
import { QueueService } from "@jev/queue";

export type JobHandler = (job: QueueJob) => Promise<unknown>;

export interface WorkerRuntimeOptions {
  workerId: string;
  queue?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  handlers?: Record<string, JobHandler>;
}

export class WorkerRuntime {
  private running = false;
  private pollTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly queueName: string;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly handlers: Record<string, JobHandler>;

  constructor(
    private readonly queue: QueueService,
    private readonly options: WorkerRuntimeOptions
  ) {
    this.queueName = options.queue ?? "default";
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
    this.handlers = options.handlers ?? {
      NOOP: async (job) => ({ processedJobId: job.id })
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.queue.registerWorker(this.options.workerId);

    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);

    this.heartbeatTimer = setInterval(() => {
      void this.queue.heartbeat(this.options.workerId);
    }, this.heartbeatIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.queue.stopWorker(this.options.workerId);
  }

  async pollOnce(): Promise<boolean> {
    if (!this.running) return false;

    const job = await this.queue.claimNext(
      this.options.workerId,
      this.queueName
    );

    if (!job) return false;

    const handler = this.handlers[job.jobType];

    if (!handler) {
      await this.queue.fail(
        this.options.workerId,
        job,
        new Error(`unsupported_job_type:${job.jobType}`)
      );
      return true;
    }

    try {
      const result = await handler(job);
      await this.queue.complete(this.options.workerId, job.id, result);
    } catch (error) {
      await this.queue.fail(this.options.workerId, job, error);
    }

    return true;
  }
}
