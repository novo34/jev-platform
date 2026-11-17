import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DokployStagingAdapter, type DokployStagingConfig } from "./adapter.js";
import { DokployClient, type FetchLike } from "./client.js";
import { MockDokploy } from "./mock-dokploy.js";
import {
  decideOutcome, STAGING_STAGES, StagingOrchestrator,
  type DeploymentRegistry, type OrchestratorOutcome, type StageEvidence, type StagingStage
} from "./orchestrator.js";
import type { StagingDeploymentRequest, StagingProviderAdapter, StagingReferencePolicy, StagingStepResult } from "./policy.js";

const API_KEY = "dk_live_SuperSecretKey1234567890abcdef";
const SECRET = "smtp-super-secret-value-123";
const REVISION = "a".repeat(40);

const policy: StagingReferencePolicy = {
  databaseRefs: new Set(["espacore_staging"]),
  secretRefs: new Set(["SMTP_PASSWORD"]),
  stagingBaseDomain: "example.test"
};
const request = (overrides: Partial<StagingDeploymentRequest> = {}): StagingDeploymentRequest => ({
  projectId: "proj-1", taskId: "task-1", repositoryId: "repo-1", repository: "novo34/espacore",
  sourceBranch: "jev/task-1", stagingBranch: "staging", stagingUrl: "https://espacore.staging.example.test",
  databaseRef: "espacore_staging", environmentKind: "PERMANENT_STAGING", secretRefs: [], ...overrides
});

/** In-memory registry that records every status the orchestrator writes. */
class FakeRegistry implements DeploymentRegistry {
  begun: Array<{ revision: string; url: string }> = [];
  finished: Array<{ deploymentId: string; status: OrchestratorOutcome }> = [];
  async begin({ request: r, revision }: Parameters<DeploymentRegistry["begin"]>[0]) {
    this.begun.push({ revision, url: r.stagingUrl });
    return { deploymentId: `dep-${this.begun.length}`, environmentId: "env-1" };
  }
  async finish({ deploymentId, status }: Parameters<DeploymentRegistry["finish"]>[0]) {
    this.finished.push({ deploymentId, status });
  }
  get statuses(): OrchestratorOutcome[] { return this.finished.map((entry) => entry.status); }
}

type StageFns = Partial<Record<StagingStage, (r: StagingDeploymentRequest) => Promise<StagingStepResult>>>;
/** Adapter with scripted stages; `calls` records the order of invocation. */
function scripted(overrides: StageFns = {}): { adapter: StagingProviderAdapter; calls: StagingStage[] } {
  const calls: StagingStage[] = [];
  const adapter = {} as Record<StagingStage, (r: StagingDeploymentRequest) => Promise<StagingStepResult>>;
  for (const stage of STAGING_STAGES) {
    adapter[stage] = async (r) => { calls.push(stage); return overrides[stage] ? overrides[stage]!(r) : { ok: true, detail: `${stage}_ok` }; };
  }
  return { adapter: adapter as unknown as StagingProviderAdapter, calls };
}

describe("StagingOrchestrator (scripted adapter)", () => {
  it("runs the FND-026 stages in order and records RUNNING then READY with url and revision", async () => {
    const registry = new FakeRegistry();
    const { adapter, calls } = scripted();
    const result = await new StagingOrchestrator(adapter, registry).run({ request: request(), revision: REVISION });
    expect(calls).toEqual([...STAGING_STAGES]);
    expect(result).toMatchObject({ outcome: "READY", revision: REVISION, url: "https://espacore.staging.example.test", deploymentId: "dep-1" });
    expect(result.stages.map((s) => s.status)).toEqual(Array(6).fill("passed"));
    expect(registry.begun).toEqual([{ revision: REVISION, url: "https://espacore.staging.example.test" }]);
    expect(registry.statuses).toEqual(["READY"]);
  });

  it.each(STAGING_STAGES.map((stage, index) => [stage, index] as const))("stops at a failure in %s: FAILED, later stages not run, never READY", async (stage, index) => {
    const registry = new FakeRegistry();
    const { adapter, calls } = scripted({ [stage]: async () => ({ ok: false, detail: `${stage}_broke` }) });
    const result = await new StagingOrchestrator(adapter, registry).run({ request: request(), revision: REVISION });
    expect(result).toMatchObject({ outcome: "FAILED", failedStage: stage });
    expect(calls).toEqual(STAGING_STAGES.slice(0, index + 1));
    expect(result.stages.map((s) => s.status)).toEqual(STAGING_STAGES.map((_, i) => (i < index ? "passed" : i === index ? "failed" : "not_run")));
    expect(result.stages[index].detail).toBe(`${stage}_broke`);
    expect(registry.statuses).toEqual(["FAILED"]);
  });

  it("only writes READY when every stage passed (rule over many scenarios)", async () => {
    const scenarios: StageFns[] = [
      {}, { deploy: async () => ({ ok: false }) }, { healthCheck: async () => { throw new Error("boom"); } },
      { seedTestData: async () => ({ ok: true, metadata: { degraded: true } }) },
      { runOnlineE2E: async () => undefined as unknown as StagingStepResult }, { applyMigrations: async () => ({ ok: false }) }
    ];
    for (const overrides of scenarios) {
      const registry = new FakeRegistry();
      const result = await new StagingOrchestrator(scripted(overrides).adapter, registry).run({ request: request(), revision: REVISION });
      const allPassed = result.stages.every((s) => s.status === "passed");
      expect(registry.statuses[0] === "READY").toBe(allPassed);
      expect(result.outcome === "READY").toBe(allPassed);
    }
  });

  it("maps an exception, an invalid result and a degraded result to BLOCKED (never READY)", async () => {
    const thrown = new FakeRegistry();
    const r1 = await new StagingOrchestrator(scripted({ healthCheck: async () => { throw new Error(`socket ${SECRET}`); } }).adapter, thrown)
      .run({ request: request(), revision: REVISION, secrets: [SECRET] });
    expect(r1).toMatchObject({ outcome: "BLOCKED", blockedReason: "stage_error", failedStage: "healthCheck" });
    expect(JSON.stringify(r1)).not.toContain(SECRET);
    expect(thrown.statuses).toEqual(["BLOCKED"]);

    const invalid = new FakeRegistry();
    const r2 = await new StagingOrchestrator(scripted({ deploy: async () => ({ ok: "yes" }) as unknown as StagingStepResult }).adapter, invalid).run({ request: request(), revision: REVISION });
    expect(r2).toMatchObject({ outcome: "BLOCKED", blockedReason: "unknown_result", failedStage: "deploy" });

    const degraded = new FakeRegistry();
    const r3 = await new StagingOrchestrator(scripted({ runOnlineE2E: async () => ({ ok: true, metadata: { degraded: true } }) }).adapter, degraded).run({ request: request(), revision: REVISION });
    expect(r3).toMatchObject({ outcome: "BLOCKED", blockedReason: "degraded", failedStage: "runOnlineE2E" });
    expect(r3.stages[5].status).toBe("degraded");
    expect([invalid.statuses, degraded.statuses]).toEqual([["BLOCKED"], ["BLOCKED"]]);
  });

  it("blocks without calling the adapter when already aborted, and abandons a stage in flight on abort", async () => {
    const registry = new FakeRegistry();
    const pre = scripted();
    const controller = new AbortController();
    controller.abort();
    const r1 = await new StagingOrchestrator(pre.adapter, registry).run({ request: request(), revision: REVISION, signal: controller.signal });
    expect(r1).toMatchObject({ outcome: "BLOCKED", blockedReason: "aborted" });
    expect(pre.calls).toEqual([]);

    const live = new AbortController();
    const mid = scripted({ applyMigrations: () => new Promise<StagingStepResult>(() => undefined), });
    const pending = new StagingOrchestrator(mid.adapter, registry).run({ request: request(), revision: REVISION, signal: live.signal });
    setTimeout(() => live.abort(), 20);
    const r2 = await pending;
    expect(r2).toMatchObject({ outcome: "BLOCKED", blockedReason: "aborted" });
    expect(mid.calls).toEqual(["deploy", "verifyDatabase", "applyMigrations"]);
    expect(registry.statuses).toEqual(["BLOCKED", "BLOCKED"]);
  });

  it("propagates a registry failure at the end and, if the pipeline itself breaks, still tries BLOCKED", async () => {
    const registry = new FakeRegistry();
    registry.finish = async () => { throw new Error("db down"); };
    await expect(new StagingOrchestrator(scripted().adapter, registry).run({ request: request(), revision: REVISION })).rejects.toThrow("db down");
    const noBegin = new FakeRegistry();
    noBegin.begin = async () => { throw new Error("no environment"); };
    const { adapter, calls } = scripted();
    await expect(new StagingOrchestrator(adapter, noBegin).run({ request: request(), revision: REVISION })).rejects.toThrow("no environment");
    expect(calls).toEqual([]);
  });

  it("sanitizes detail and metadata of every stage", async () => {
    const registry = new FakeRegistry();
    const { adapter } = scripted({
      deploy: async () => ({ ok: true, detail: `ok x-api-key: ${API_KEY} ${SECRET}`, metadata: { nested: { url: `postgres://u:${SECRET}@db/x`, list: [SECRET] } } })
    });
    const result = await new StagingOrchestrator(adapter, registry).run({ request: request(), revision: REVISION, secrets: [SECRET] });
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(API_KEY);
    expect(result.stages[0].detail).toContain("[REDACTED]");
  });
});

describe("decideOutcome", () => {
  const stage = (name: StagingStage, status: StageEvidence["status"], detail = ""): StageEvidence => ({ stage: name, status, detail, metadata: {}, durationMs: 0 });
  const all = (status: StageEvidence["status"] = "passed") => STAGING_STAGES.map((name) => stage(name, status));

  it("is READY only for six passed stages", () => {
    expect(decideOutcome(all()).outcome).toBe("READY");
    expect(decideOutcome(all().slice(0, 5)).outcome).toBe("BLOCKED");
    expect(decideOutcome([...all().slice(0, 5), stage("runOnlineE2E", "not_run")]).outcome).toBe("BLOCKED");
    expect(decideOutcome(all(), true)).toEqual({ outcome: "BLOCKED", blockedReason: "aborted" });
    expect(decideOutcome([stage("deploy", "failed"), ...all("not_run").slice(1)])).toEqual({ outcome: "FAILED", failedStage: "deploy" });
  });
});

describe("StagingOrchestrator with the simulated Dokploy", () => {
  let mock: MockDokploy;
  beforeEach(async () => { mock = new MockDokploy(API_KEY); await mock.start(); });
  afterEach(async () => { await mock.stop(); });

  const toMockPublic: FetchLike = (input, init) => {
    const url = new URL(input);
    return fetch(`${mock.url}/public${url.pathname}${url.search}`, init);
  };
  const adapter = (overrides: Partial<DokployStagingConfig> = {}) => new DokployStagingAdapter({
    client: new DokployClient({ baseUrl: mock.url, apiKey: API_KEY }), environmentId: "env_1", policy,
    pollIntervalMs: 5, deployTimeoutMs: 1_000, httpTimeoutMs: 500, fetchImpl: toMockPublic,
    migrationCommand: "npm run db:migrate", seedCommand: "npm run db:seed", ...overrides
  });
  const run = (a: DokployStagingAdapter, registry: DeploymentRegistry, req = request()) =>
    new StagingOrchestrator(a, registry).run({ request: req, revision: REVISION, secrets: [API_KEY] });
  const posts = (path: string): number => mock.calls.filter((c) => c.method === "POST" && c.path === path).length;

  it("succeeds end to end, with evidence per stage and no secrets", async () => {
    const registry = new FakeRegistry();
    const result = await run(adapter(), registry);
    expect(result.outcome).toBe("READY");
    expect(result.stages.map((s) => [s.stage, s.status])).toEqual(STAGING_STAGES.map((s) => [s, "passed"]));
    expect(result.stages[0].detail).toBe("created_and_deployed");
    expect(result.stages[2].metadata).toMatchObject({ skipped: false });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(registry.statuses).toEqual(["READY"]);
  });

  it("is idempotent on the second run: one compose, redeploy, two READY deployments", async () => {
    const registry = new FakeRegistry();
    const a = adapter();
    const first = await run(a, registry);
    const second = await run(a, registry);
    expect([first.outcome, second.outcome]).toEqual(["READY", "READY"]);
    expect(posts("compose.create")).toBe(1);
    expect(posts("domain.create")).toBe(1);
    expect(posts("compose.deploy")).toBe(1);
    expect(posts("compose.redeploy")).toBe(1);
    expect(mock.composes.size).toBe(1);
    expect(second.stages[0].detail).toBe("reused_and_redeployed");
    expect(registry.begun).toHaveLength(2);
    expect(registry.statuses).toEqual(["READY", "READY"]);
  });

  it("fails at deploy when Dokploy reports an error deployment", async () => {
    mock.deployStatuses = ["running", "error"];
    const registry = new FakeRegistry();
    const result = await run(adapter(), registry);
    expect(result).toMatchObject({ outcome: "FAILED", failedStage: "deploy" });
    expect(result.stages[0].detail).toBe("deployment_failed");
    expect(registry.statuses).toEqual(["FAILED"]);
  });

  it("fails at deploy on a Dokploy API error and on a policy violation (no Dokploy calls for the latter)", async () => {
    mock.fail({ path: "compose.create", status: 500 });
    const registry = new FakeRegistry();
    const r1 = await run(adapter(), registry);
    expect(r1).toMatchObject({ outcome: "FAILED", failedStage: "deploy" });
    expect(r1.stages[0].detail).toBe("dokploy_upstream");

    const before = mock.calls.length;
    const r2 = await run(adapter(), registry, request({ stagingBranch: "main" }));
    expect(r2).toMatchObject({ outcome: "FAILED", failedStage: "deploy" });
    expect(r2.stages[0].detail).toBe("staging_branch_must_not_be_production");
    expect(mock.calls.length).toBe(before);
    expect(registry.statuses).toEqual(["FAILED", "FAILED"]);
  });

  it("fails at healthCheck and at runOnlineE2E on the public URL", async () => {
    mock.publicResponses.set("/health", { status: 503, body: "down" });
    const registry = new FakeRegistry();
    const r1 = await run(adapter({ healthPath: "/health" }), registry);
    expect(r1).toMatchObject({ outcome: "FAILED", failedStage: "healthCheck" });
    expect(r1.stages.slice(0, 4).every((s) => s.status === "passed")).toBe(true);

    mock.publicResponses.set("/health", { status: 200, body: "ok" });
    mock.publicResponses.set("/login", { status: 200, body: "error page" });
    const r2 = await run(adapter({ healthPath: "/health", e2eRoutes: [{ path: "/login", bodyIncludes: "Sign in" }] }), registry);
    expect(r2).toMatchObject({ outcome: "FAILED", failedStage: "runOnlineE2E" });
    expect(r2.stages[5].detail).toBe("e2e_body_mismatch");
    expect(registry.statuses).toEqual(["FAILED", "FAILED"]);
  });

  it("fails at verifyDatabase, applyMigrations and seedTestData with the real adapter against a mutated compose", async () => {
    const a = adapter();
    const original = a.deploy.bind(a);
    const cases: Array<[StagingStage, (file: string) => string]> = [
      ["verifyDatabase", (file) => `${file}\n    ports:\n      - "5432:5432"\n`],
      ["applyMigrations", (file) => file.replace(/^ {2}migrate:/m, "  migrate_removed:")],
      ["seedTestData", (file) => file.replace(/^ {2}seed:/m, "  seed_removed:")]
    ];
    for (const [stage, change] of cases) {
      const registry = new FakeRegistry();
      a.deploy = async (req) => {
        const result = await original(req);
        for (const compose of mock.composes.values()) compose.composeFile = change(compose.composeFile);
        return result;
      };
      const result = await run(a, registry);
      expect(result, stage).toMatchObject({ outcome: "FAILED", failedStage: stage });
      expect(registry.statuses).toEqual(["FAILED"]);
      mock.composes.clear();
      mock.domains.clear();
    }
  });

  it("blocks and stops calling Dokploy when aborted", async () => {
    const registry = new FakeRegistry();
    const controller = new AbortController();
    controller.abort();
    const result = await new StagingOrchestrator(adapter(), registry).run({ request: request(), revision: REVISION, signal: controller.signal });
    expect(result).toMatchObject({ outcome: "BLOCKED", blockedReason: "aborted" });
    expect(mock.calls).toHaveLength(0);
    expect(registry.statuses).toEqual(["BLOCKED"]);
  });
});
