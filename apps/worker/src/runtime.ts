import type { QueueJob } from "@jev/queue";
import { QueueService } from "@jev/queue";

export interface JobContext {
  /** Aborted when the job times out or the worker stops waiting for it. */
  signal: AbortSignal;
}

export type JobHandler = (job: QueueJob, context: JobContext) => Promise<unknown>;

export interface WorkerRuntimeOptions {
  workerId: string;
  queue?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  /** Maximum duration of one job handler. Default: 60 minutes. */
  jobTimeoutMs?: number;
  /** Maximum time `stop()` waits for the in-flight job. Default: 30 seconds. */
  stopTimeoutMs?: number;
  /** A RUNNING job whose worker has no heartbeat for this long is recovered. Default: 60 seconds. */
  staleWorkerAfterMs?: number;
  /** How often orphaned jobs are recovered. Default: 30 seconds. */
  recoveryIntervalMs?: number;
  handlers?: Record<string, JobHandler>;
}

export class WorkerRuntime {
  private running = false;
  private pollTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  private inFlight?: Promise<boolean>;
  private inFlightAbort?: AbortController;
  private readonly jobTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly staleWorkerAfterMs: number;
  private readonly recoveryIntervalMs: number;
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
    this.jobTimeoutMs = options.jobTimeoutMs ?? 60 * 60 * 1000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 30_000;
    this.staleWorkerAfterMs = options.staleWorkerAfterMs ?? 60_000;
    this.recoveryIntervalMs = options.recoveryIntervalMs ?? 30_000;
    this.handlers = options.handlers ?? {
      NOOP: async (job) => ({ processedJobId: job.id })
    };
  }

  get isRunning(): boolean {
    return this.running;
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

    this.recoveryTimer = setInterval(() => {
      void this.recoverOnce();
    }, this.recoveryIntervalMs);
    void this.recoverOnce();
  }

  async recoverOnce(): Promise<number> {
    try {
      return await this.queue.recoverStaleJobs(this.staleWorkerAfterMs);
    } catch {
      return 0;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);

    const inFlight = this.inFlight;
    if (inFlight) {
      let waitTimer: NodeJS.Timeout | undefined;
      const finished = await Promise.race([
        inFlight.then(
          () => true,
          () => true
        ),
        new Promise<boolean>((resolve) => {
          waitTimer = setTimeout(() => resolve(false), this.stopTimeoutMs);
        })
      ]);
      if (waitTimer) clearTimeout(waitTimer);
      // The job stays RUNNING; stale-job recovery requeues it later.
      if (!finished) this.inFlightAbort?.abort(new Error("worker_stopping"));
    }

    await this.queue.stopWorker(this.options.workerId);
  }

  async pollOnce(): Promise<boolean> {
    if (!this.running || this.inFlight) return false;

    const run = this.runOnce();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  private async runOnce(): Promise<boolean> {
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

    const abort = new AbortController();
    this.inFlightAbort = abort;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.jobTimeoutMs);
    });

    try {
      const outcome = await Promise.race([
        handler(job, { signal: abort.signal }).then((result) => ({ result })),
        timeout
      ]);
      if (outcome === "timeout") {
        abort.abort(new Error("job_timeout"));
        await this.queue.fail(this.options.workerId, job, new Error("job_timeout"));
      } else {
        await this.queue.complete(this.options.workerId, job.id, outcome.result);
      }
    } catch (error) {
      await this.queue.fail(this.options.workerId, job, error);
    } finally {
      if (timer) clearTimeout(timer);
      this.inFlightAbort = undefined;
    }

    return true;
  }
}
