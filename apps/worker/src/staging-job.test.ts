import { describe, expect, it } from "vitest";
import {
  STAGING_STAGES,
  type DeploymentRegistry, type OrchestratorOutcome, type ProjectStagingConfig, type StagingProviderAdapter, type StagingStage, type StagingStepResult
} from "@jev/staging";
import type { QueueJob } from "@jev/queue";
import { STAGING_JOB_TYPE, createStagingJobHandler, parseStagingPayload, stagingHandlers, type StagingJobDeps } from "./staging-job.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const REPO = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";
const SHA = "c".repeat(40);
const API_KEY = "dk_live_WorkerSecretKey1234567890abcdef";
const SECRET = "smtp-secret-value-xyz-987";

const payload = (over: Record<string, unknown> = {}) => ({ projectId: PROJECT, repositoryId: REPO, taskId: TASK, revision: SHA, ...over });
const job = (p: unknown, over: Partial<QueueJob> = {}): QueueJob => ({
  id: "job-1", queue: "default", jobType: STAGING_JOB_TYPE, payload: p as Record<string, unknown>, status: "RUNNING",
  attemptCount: 1, maxAttempts: 1, correlationId: "c", projectId: null, orderId: null, taskId: null, ...over
});
const ctx = (signal = new AbortController().signal) => ({ signal });

const config: ProjectStagingConfig = {
  defaultBranch: "main",
  settings: { stagingBaseDomain: "example.test", dokployEnvironmentId: "env_1", secretValues: { SMTP_PASSWORD: SECRET } },
  request: {
    projectId: PROJECT, repositoryId: REPO, taskId: TASK, repository: "novo34/espacore", sourceBranch: "feat/jev-x", stagingBranch: "staging",
    stagingUrl: "https://espacore.staging.example.test", databaseRef: "espacore_staging", environmentKind: "PERMANENT_STAGING", secretRefs: []
  }
};

function setup(stages: Partial<Record<StagingStage, () => Promise<StagingStepResult>>> = {}, over: Partial<StagingJobDeps> = {}) {
  const statuses: OrchestratorOutcome[] = [];
  const configCalls: unknown[] = [];
  const ledgerCalls: unknown[] = [];
  const registry: DeploymentRegistry = {
    begin: async () => ({ deploymentId: "dep-1", environmentId: "env-1" }),
    finish: async ({ status }) => { statuses.push(status); }
  };
  const adapter = {} as Record<StagingStage, (r: unknown) => Promise<StagingStepResult>>;
  for (const stage of STAGING_STAGES) adapter[stage] = async () => (stages[stage] ? stages[stage]!() : { ok: true, detail: `${stage}_ok` });
  const deps: StagingJobDeps = {
    integratedRevision: async (ids) => { ledgerCalls.push(ids); return SHA; },
    configProvider: async (ids) => { configCalls.push(ids); return config; },
    adapterFactory: () => adapter as unknown as StagingProviderAdapter,
    registry, redact: [API_KEY], ...over
  };
  return { handler: createStagingJobHandler(deps), statuses, configCalls, ledgerCalls };
}

describe("parseStagingPayload", () => {
  it.each([
    ["extra field", payload({ extra: 1 })],
    ["missing revision", (() => { const { revision, ...rest } = payload(); return rest; })()],
    ["bad project id", payload({ projectId: "nope" })],
    ["bad repository id", payload({ repositoryId: 5 })],
    ["bad task id", payload({ taskId: "task-1" })],
    ["short sha", payload({ revision: "abc123" })],
    ["branch instead of sha", payload({ revision: "staging" })],
    ["array payload", []],
    ["null payload", null]
  ])("rejects %s", (_name, bad) => {
    expect(() => parseStagingPayload(bad)).toThrowError(/invalid staging job payload/);
  });

  it("accepts a valid payload and normalizes the sha to lower case", () => {
    expect(parseStagingPayload(payload({ revision: SHA.toUpperCase() }))).toEqual(payload());
  });
});

describe("staging job handler", () => {
  it("rejects an invalid payload or mismatching job ids without loading configuration", async () => {
    const { handler, configCalls, statuses } = setup();
    await expect(handler(job(payload({ extra: 1 })), ctx())).rejects.toMatchObject({ code: "invalid_payload" });
    await expect(handler(job(payload(), { taskId: "other" }), ctx())).rejects.toMatchObject({ code: "invalid_payload" });
    await expect(handler(job(payload(), { projectId: "other" }), ctx())).rejects.toMatchObject({ code: "invalid_payload" });
    expect(configCalls).toHaveLength(0);
    expect(statuses).toHaveLength(0);
  });

  it("rejects a revision that is not the integration recorded for the task, before touching config or the registry", async () => {
    for (const recorded of [null, "f".repeat(40)]) {
      const { handler, configCalls, statuses } = setup({}, { integratedRevision: async () => recorded });
      await expect(handler(job(payload()), ctx())).rejects.toMatchObject({ code: "revision_not_integrated" });
      expect(configCalls).toHaveLength(0);
      expect(statuses).toHaveLength(0);
    }
    const down = setup({}, { integratedRevision: async () => { throw new Error(`db ${SECRET}`); } });
    const error: any = await down.handler(job(payload()), ctx()).catch((e: any) => e);
    expect(error).toMatchObject({ code: "config_unavailable" });
    expect(error.message).not.toContain(SECRET);
    expect(down.statuses).toHaveLength(0);
  });

  it("accepts the revision when it equals the recorded integration (case-insensitive)", async () => {
    const { handler } = setup({}, { integratedRevision: async () => SHA.toUpperCase() });
    await expect(handler(job(payload()), ctx())).resolves.toMatchObject({ outcome: "READY", revision: SHA });
  });

  it("completes with per-stage evidence on success and records READY", async () => {
    const { handler, statuses, configCalls, ledgerCalls } = setup();
    const result = await handler(job(payload(), { taskId: TASK, projectId: PROJECT }), ctx()) as any;
    expect(configCalls).toEqual([{ projectId: PROJECT, repositoryId: REPO, taskId: TASK }]);
    expect(ledgerCalls).toEqual([{ projectId: PROJECT, repositoryId: REPO, taskId: TASK }]);
    expect(result).toMatchObject({ outcome: "READY", deploymentId: "dep-1", revision: SHA, url: "https://espacore.staging.example.test" });
    expect(result.stages.map((s: any) => s.status)).toEqual(Array(6).fill("passed"));
    expect(statuses).toEqual(["READY"]);
  });

  it("returns a FAILED outcome (job completes, not retried) with the failing stage and records FAILED", async () => {
    const { handler, statuses } = setup({ applyMigrations: async () => ({ ok: false, detail: "migrate_failed" }) });
    const result = await handler(job(payload()), ctx()) as any;
    expect(result).toMatchObject({ outcome: "FAILED", failedStage: "applyMigrations" });
    expect(result.stages.map((s: any) => s.status)).toEqual(["passed", "passed", "failed", "not_run", "not_run", "not_run"]);
    expect(statuses).toEqual(["FAILED"]);
  });

  it("keeps secrets out of the result and of thrown errors", async () => {
    const leaky = { ok: false, detail: `bad ${SECRET} x-api-key: ${API_KEY}`, metadata: { token: API_KEY } };
    const { handler } = setup({ deploy: async () => leaky });
    const result = await handler(job(payload()), ctx());
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(API_KEY);

    const blocked = setup({ healthCheck: async () => { throw new Error(`conn ${SECRET} ${API_KEY}`); } });
    const error: any = await blocked.handler(job(payload()), ctx()).catch((e: any) => e);
    expect(error).toMatchObject({ code: "staging_blocked" });
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(API_KEY);
    expect(blocked.statuses).toEqual(["BLOCKED"]);
  });

  it("throws on infrastructure failures so the runtime calls queue.fail", async () => {
    const noConfig = setup({}, { configProvider: async () => { throw Object.assign(new Error(`leak ${API_KEY}`), { code: "staging_url_missing" }); } });
    const e1: any = await noConfig.handler(job(payload()), ctx()).catch((e: any) => e);
    expect(e1).toMatchObject({ code: "config_unavailable" });
    expect(e1.message).toBe("staging configuration unavailable (staging_url_missing)");

    const noDb = setup({}, { registry: { begin: async () => { throw new Error(`db ${SECRET}`); }, finish: async () => undefined } });
    const e2: any = await noDb.handler(job(payload()), ctx()).catch((e: any) => e);
    expect(e2).toMatchObject({ code: "staging_failed" });
    expect(e2.message).not.toContain(SECRET);

    const degraded = setup({ seedTestData: async () => ({ ok: true, metadata: { degraded: true } }) });
    await expect(degraded.handler(job(payload()), ctx())).rejects.toMatchObject({ code: "staging_blocked" });
    expect(degraded.statuses).toEqual(["BLOCKED"]);
  });

  it("respects the AbortSignal: before start and during a stage", async () => {
    const pre = new AbortController();
    pre.abort();
    const early = setup();
    await expect(early.handler(job(payload()), ctx(pre.signal))).rejects.toMatchObject({ code: "staging_blocked" });
    expect(early.configCalls).toHaveLength(0);

    const live = new AbortController();
    const mid = setup({ healthCheck: () => new Promise<StagingStepResult>(() => undefined) });
    const pending = mid.handler(job(payload()), ctx(live.signal)).catch((e: any) => e);
    setTimeout(() => live.abort(), 20);
    const error: any = await pending;
    expect(error).toMatchObject({ code: "staging_blocked" });
    expect(error.message).toContain("aborted");
    expect(mid.statuses).toEqual(["BLOCKED"]);
  });

  it("exposes the handler under STAGING_DEPLOY and is not registered by server.ts", async () => {
    const handlers = stagingHandlers({ integratedRevision: async () => SHA, configProvider: async () => config, adapterFactory: () => ({}) as StagingProviderAdapter, registry: { begin: async () => ({ deploymentId: "d", environmentId: "e" }), finish: async () => undefined } });
    expect(Object.keys(handlers)).toEqual(["STAGING_DEPLOY"]);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(new URL("./server.ts", import.meta.url), "utf8")).not.toMatch(/staging/i);
  });
});
