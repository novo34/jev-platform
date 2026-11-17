# Queue and worker runtime

PLT-006 moves long-running work out of the API request thread into a PostgreSQL-backed queue consumed by the dedicated worker process.

## Persistence

The queue uses two canonical tables:

- `jobs` stores queue, type, payload, status, attempt count, retry limit, idempotency key, lock ownership, result/error, correlation ID and optional project/order/task references.
- `worker_instances` stores worker status, heartbeat and current claimed job.

## Idempotency

Callers may provide an `idempotencyKey`. The database enforces uniqueness so repeated enqueue operations return the existing job instead of creating duplicate work.

## Claiming and concurrency

Workers claim jobs transactionally with `FOR UPDATE SKIP LOCKED`. A claimed job moves from `QUEUED` to `RUNNING`, increments its attempt counter and records the worker lock.

## Retry

On handler failure:

- if `attempt_count < max_attempts`, the job returns to `QUEUED` with a delayed `available_at`;
- otherwise it becomes `FAILED` and persists `last_error`.

A worker crash cannot mark a job `SUCCEEDED`; completion only occurs after the handler returns successfully and the worker persists the terminal state.

## Worker robustness (PLT-011)

- One job in flight per worker: `pollOnce` does not claim another job while a handler runs. `stop()` stops claiming and waits (up to `stopTimeoutMs`, default 30 s) for the handler; on expiry it aborts the handler signal and leaves the job `RUNNING` for recovery.
- Per-job timeout (`jobTimeoutMs`, default 60 min): the job fails with `last_error = job_timeout` (retried while attempts remain) and the handler receives an `AbortSignal` via `handler(job, { signal })`. The worker slot is released even if the handler ignores the signal.
- Orphan recovery: `QueueService.recoverStaleJobs(staleAfterMs)` atomically returns `RUNNING` jobs whose `locked_by` worker has no heartbeat within the threshold (or no worker row) to `QUEUED`, or `FAILED` when attempts are exhausted, with `last_error = worker_lost`. The runtime runs it every `recoveryIntervalMs` (30 s) with `staleWorkerAfterMs` (60 s). Jobs of live workers are untouched. Handlers must be idempotent, since a recovered job may re-run.
- Stop sequence: after the first `stopTimeoutMs` the handler is aborted and `stop()` waits a second `stopTimeoutMs` for the handler's cleanup and the final `queue.fail`/`complete`, so the caller can close the pool safely. If even that expires, `stop()` returns and the job stays `RUNNING`; orphan recovery requeues it once the heartbeat lapses.
- Restart with the same `WORKER_ID`: `start()` first calls `QueueService.releaseWorkerJobs(workerId)`, which atomically returns `RUNNING` jobs still locked by that id (necessarily from the previous process) to `QUEUED`, or `FAILED` when attempts are exhausted, with `last_error = worker_restarted`. `WORKER_ID` must therefore be unique among live processes.
- `complete`/`fail` only clear the worker's `current_job_id` if it points to that job.

## Workspace job (PLT-011, not active)

`apps/worker/src/workspace-job.ts` implements `jobType` `WORKSPACE_RUN`. `server.ts` does **not** register it: activation needs a dedicated server (the executor needs Docker and is not enabled in JEV Staging). To activate, merge `workspaceHandlers({ executor, tokenProvider })` into `WorkerRuntimeOptions.handlers`.

- Payload (strict, extra fields rejected): `{ taskId, projectId, repoFullName, branch, commands }`; `commands` has 1 to 10 entries of the executor allowlist. `npm ci` is never requested: `install()` always runs first. `branch` must be `feat|fix|chore/...`; if the job row carries `task_id`/`project_id` they must match the payload.
- `TokenProvider = (projectId, repoFullName) => Promise<{ token, expiresAt }>` is injected. The worker does not import `@jev/control` nor hold the GitHub App key; the activation task wires `GitHubOperations.cloneToken` (read-only, one repository) behind it. Provider errors are replaced by a fixed `token_unavailable` message.
- The workspace is created with `withWorkspace` (always destroyed) and receives the runtime `AbortSignal`, so the job timeout or a stopping worker aborts and destroys it.
- State is stored in `jobs.result` (written by `queue.complete`), not in `task_runs`: `jev_runtime` has no DML on `task_runs` and PLT-008 limits its writers. Result: `{ workspaceId, branch, status: "PASSED" | "FAILED", commands: [{ command, exitCode, durationMs, timedOut, output }] }`, sanitized and without the token.
- A command that exits non-zero or times out is a task outcome, not an infrastructure error: execution stops there, the job is `COMPLETED` with `status: "FAILED"` and the detail (`queue.fail` stores only a message and would retry a deterministic failure). Infrastructure errors (invalid payload, token, clone, Docker, abort, timeout) throw and the runtime calls `queue.fail` with a sanitized message.

## Staging job (PLT-012, not active)

`apps/worker/src/staging-job.ts` implements `jobType` `STAGING_DEPLOY`. `server.ts` does **not** register it: activation needs the Dokploy API key and the staging base domain (R4, PLT-012 step 6). To activate, merge `stagingHandlers({ configProvider, adapterFactory, registry, redact })` into `WorkerRuntimeOptions.handlers`, with a `DokployClient` built from the worker environment, `createDokployAdapterFactory(client)`, `new PgDeploymentRegistry(pool)` and a `configProvider` based on `loadProjectStagingConfig` (all from `@jev/staging`).

- Payload (strict): `{ projectId, repositoryId, taskId, revision }` (UUIDs and a 40-hex SHA); if the job row carries `task_id`/`project_id` they must match.
- The orchestrator runs deploy, verifyDatabase, applyMigrations, seedTestData, healthCheck and runOnlineE2E, stops at the first failure and records the deployment through the controlled writers (RUNNING, then READY, FAILED or BLOCKED). The Dokploy API key is injected, never read from the database.
- `READY` and `FAILED` complete the job; `jobs.result` holds `{ outcome, deploymentId, environmentId, revision, url, stages, failedStage? }` with sanitized per-stage evidence. `BLOCKED` (abort, exception, unknown or degraded result) and infrastructure errors throw, so the runtime calls `queue.fail` with a sanitized message. The `AbortSignal` is honored before and during each stage.

## Runtime boundary

`apps/worker` owns the polling/runtime loop. The API process does not execute queued handlers. PLT-006 intentionally does not implement Docker workspaces or GitHub execution; those remain later tasks.
