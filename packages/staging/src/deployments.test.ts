import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { ensureStagingEnvironment, PgDeploymentRegistry } from "./deployments.js";
import { StagingConfigError, loadIntegratedRevision, loadProjectStagingConfig, type StagingDeploymentSettings } from "./project-config.js";
import { STAGING_STAGES, StagingOrchestrator, type StagingStage } from "./orchestrator.js";
import type { StagingDeploymentRequest, StagingProviderAdapter, StagingStepResult } from "./policy.js";

const pool: Pool = createDatabasePool({ application_name: "jev-staging-deployments-" + randomUUID() });
const organizationId = randomUUID(), projectId = randomUUID(), repositoryId = randomUUID(), foreignProjectId = randomUUID(), foreignRepositoryId = randomUUID();
const STAGING_URL = "https://espacore.staging.example.test";
const REVISION = "b".repeat(40);
let orderId: string;

type Stages = Partial<Record<StagingStage, (r: StagingDeploymentRequest) => Promise<StagingStepResult>>>;
const adapterOf = (overrides: Stages = {}): StagingProviderAdapter => {
  const adapter = {} as Record<StagingStage, (r: StagingDeploymentRequest) => Promise<StagingStepResult>>;
  for (const stage of STAGING_STAGES) adapter[stage] = async (r) => overrides[stage] ? overrides[stage]!(r) : { ok: true, detail: `${stage}_ok` };
  return adapter as unknown as StagingProviderAdapter;
};

/** A task in STAGING (the state before a staging deployment is reviewed). */
async function stagingTask(): Promise<string> {
  const task = (await pool.query("SELECT jev_create_task($1,$2,$3,'Staging task','R1','[]'::jsonb) AS id", [projectId, orderId, repositoryId])).rows[0].id as string;
  await pool.query("SELECT jev_transition_task($1,'READY','SYSTEM',NULL,'test','{}'::jsonb)", [task]);
  await pool.query("SELECT jev_transition_task($1,'RUNNING','SYSTEM',NULL,'test','{}'::jsonb)", [task]);
  await pool.query("SELECT jev_transition_task($1,'VERIFYING','SYSTEM',NULL,'test','{}'::jsonb)", [task]);
  await pool.query("SELECT jev_transition_task($1,'VERIFIED','AGENT','independent-qa-process','test',$2::jsonb)", [task, JSON.stringify({ technicalVerification: { passed: true } })]);
  await pool.query("SELECT jev_transition_task($1,'STAGING','SYSTEM',NULL,'test','{}'::jsonb)", [task]);
  return task;
}
const requestFor = (taskId: string): StagingDeploymentRequest => ({
  projectId, repositoryId, taskId, repository: "novo34/espacore", sourceBranch: `feat/jev-${taskId}`, stagingBranch: "staging",
  stagingUrl: STAGING_URL, databaseRef: "espacore_staging", environmentKind: "PERMANENT_STAGING", secretRefs: []
});
const run = (taskId: string, adapter: StagingProviderAdapter, signal?: AbortSignal) =>
  new StagingOrchestrator(adapter, new PgDeploymentRegistry(pool)).run({ request: requestFor(taskId), revision: REVISION, signal });
const latest = async (taskId: string) => (await pool.query(
  "SELECT d.id, d.status, d.url, d.revision, d.provider, e.kind FROM deployments d JOIN environments e ON e.id=d.environment_id WHERE d.task_id=$1 ORDER BY d.insertion_seq DESC LIMIT 1", [taskId])).rows[0];
const toAwaitingHuman = (taskId: string, deployment: { id: string; revision: string; url: string }) => pool.query(
  "SELECT jev_transition_task($1,'AWAITING_HUMAN','SYSTEM',NULL,'ready-for-review',$2::jsonb)",
  [taskId, JSON.stringify({ stagingDeploymentId: deployment.id, revision: deployment.revision, url: deployment.url })]);

beforeAll(async () => {
  await migrate(pool);
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Staging Org')", [organizationId]);
  await pool.query("INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'Staging Project'),($3,$2,'Other Project')", [projectId, organizationId, foreignProjectId]);
  await pool.query(
    "INSERT INTO repositories(id,project_id,full_name,role,staging_branch,staging_url,staging_database_enabled) VALUES($1,$2,'novo34/espacore','other','staging',$3,true),($4,$5,'novo34/other','other',NULL,NULL,false)",
    [repositoryId, projectId, STAGING_URL, foreignRepositoryId, foreignProjectId]);
  orderId = (await pool.query("INSERT INTO orders(project_id,objective) VALUES($1,'staging order') RETURNING id", [projectId])).rows[0].id;
});
afterAll(async () => { await pool.end(); });

describe("controlled staging deployments (PostgreSQL)", () => {
  it("creates the staging environment once through the controlled writer and reuses it", async () => {
    const first = await ensureStagingEnvironment(pool, { projectId, repositoryId, stagingUrl: STAGING_URL });
    const second = await ensureStagingEnvironment(pool, { projectId, repositoryId, stagingUrl: STAGING_URL });
    expect(second).toBe(first);
    const rows = await pool.query("SELECT kind, url FROM environments WHERE project_id=$1 AND repository_id=$2 AND kind='staging'", [projectId, repositoryId]);
    expect(rows.rows).toEqual([{ kind: "staging", url: STAGING_URL }]);
  });

  it("a successful run leaves a READY staging deployment with the exact url and revision, and the task can reach AWAITING_HUMAN", async () => {
    const taskId = await stagingTask();
    let during: string | undefined;
    const adapter = adapterOf({ deploy: async () => { during = (await latest(taskId)).status; return { ok: true }; } });
    const result = await run(taskId, adapter);
    expect(during).toBe("RUNNING");
    expect(result.outcome).toBe("READY");
    const deployment = await latest(taskId);
    expect(deployment).toMatchObject({ id: result.deploymentId, status: "READY", url: STAGING_URL, revision: REVISION, kind: "staging", provider: "dokploy" });
    await expect(toAwaitingHuman(taskId, deployment)).resolves.toBeDefined();
    expect((await pool.query("SELECT status FROM tasks WHERE id=$1", [taskId])).rows[0].status).toBe("AWAITING_HUMAN");
  });

  it("a failed run leaves the latest deployment FAILED and the task cannot reach AWAITING_HUMAN", async () => {
    const taskId = await stagingTask();
    const result = await run(taskId, adapterOf({ healthCheck: async () => ({ ok: false, detail: "health_status_503" }) }));
    expect(result).toMatchObject({ outcome: "FAILED", failedStage: "healthCheck" });
    const deployment = await latest(taskId);
    expect(deployment).toMatchObject({ status: "FAILED", url: STAGING_URL, revision: REVISION });
    await expect(toAwaitingHuman(taskId, deployment)).rejects.toMatchObject({ code: "23514" });
    expect((await pool.query("SELECT status FROM tasks WHERE id=$1", [taskId])).rows[0].status).toBe("STAGING");
  });

  it("a later failed run supersedes an earlier READY one (latest by insertion order decides)", async () => {
    const taskId = await stagingTask();
    const ok = await run(taskId, adapterOf());
    const bad = await run(taskId, adapterOf({ runOnlineE2E: async () => ({ ok: false }) }));
    expect([ok.outcome, bad.outcome]).toEqual(["READY", "FAILED"]);
    const deployment = await latest(taskId);
    expect(deployment).toMatchObject({ id: bad.deploymentId, status: "FAILED" });
    // Binding the evidence to the old READY deployment is rejected too.
    await expect(toAwaitingHuman(taskId, { id: ok.deploymentId, revision: REVISION, url: STAGING_URL })).rejects.toMatchObject({ code: "23514" });
  });

  it("unknown, degraded and aborted runs are BLOCKED and never allow AWAITING_HUMAN", async () => {
    const cases: Array<[string, StagingProviderAdapter, AbortSignal | undefined]> = [
      ["exception", adapterOf({ healthCheck: async () => { throw new Error("boom"); } }), undefined],
      ["degraded", adapterOf({ seedTestData: async () => ({ ok: true, metadata: { degraded: true } }) }), undefined],
      ["aborted", adapterOf(), (() => { const c = new AbortController(); c.abort(); return c.signal; })()]
    ];
    for (const [name, adapter, signal] of cases) {
      const taskId = await stagingTask();
      const result = await run(taskId, adapter, signal);
      expect(result.outcome, name).toBe("BLOCKED");
      const deployment = await latest(taskId);
      expect(deployment.status, name).toBe("BLOCKED");
      await expect(toAwaitingHuman(taskId, deployment), name).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("rejects a deployment whose repository is outside the project (controlled writer scope)", async () => {
    const taskId = await stagingTask();
    const request = { ...requestFor(taskId), repositoryId: foreignRepositoryId };
    await expect(new StagingOrchestrator(adapterOf(), new PgDeploymentRegistry(pool)).run({ request, revision: REVISION })).rejects.toBeDefined();
  });
});

describe("loadProjectStagingConfig", () => {
  const settings: StagingDeploymentSettings = { stagingBaseDomain: "example.test", dokployEnvironmentId: "env_1", secretRefs: ["SMTP_PASSWORD"] };

  it("reads staging_url, staging_branch and the task branch and derives the database reference", async () => {
    const taskId = await stagingTask();
    const config = await loadProjectStagingConfig(pool, { projectId, repositoryId, taskId }, settings);
    expect(config.defaultBranch).toBe("main");
    expect(config.request).toMatchObject({
      repository: "novo34/espacore", stagingBranch: "staging", stagingUrl: STAGING_URL, databaseRef: "espacore_staging",
      environmentKind: "PERMANENT_STAGING", secretRefs: ["SMTP_PASSWORD"], sourceBranch: `feat/jev-${taskId}`
    });
  });

  it("fails closed when the repository has no staging database, branch or URL, or the task is foreign", async () => {
    const taskId = await stagingTask();
    await expect(loadProjectStagingConfig(pool, { projectId: foreignProjectId, repositoryId: foreignRepositoryId, taskId }, settings))
      .rejects.toMatchObject({ code: "repository_or_task_not_found" });
    await pool.query("UPDATE repositories SET staging_database_enabled=false WHERE id=$1", [repositoryId]);
    await expect(loadProjectStagingConfig(pool, { projectId, repositoryId, taskId }, settings)).rejects.toMatchObject({ code: "staging_database_not_enabled" });
    await pool.query("UPDATE repositories SET staging_database_enabled=true, staging_url=NULL WHERE id=$1", [repositoryId]);
    await expect(loadProjectStagingConfig(pool, { projectId, repositoryId, taskId }, settings)).rejects.toBeInstanceOf(StagingConfigError);
    await pool.query("UPDATE repositories SET staging_url=$2 WHERE id=$1", [repositoryId, STAGING_URL]);
  });
});

describe("loadIntegratedRevision (github_operations ledger, SELECT only)", () => {
  const userId = randomUUID();
  const record = async (taskId: string, status: "SUCCESS" | "FAILED", sha: string | null, action = "GITHUB_INTEGRATE_STAGING"): Promise<void> => {
    const commandId = randomUUID();
    await pool.query(
      "INSERT INTO github_operations(organization_id,project_id,repository_id,task_id,actor_id,command_id,action,request_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING')",
      [organizationId, projectId, repositoryId, taskId, userId, commandId, action, "a".repeat(64)]);
    if (status === "SUCCESS") await pool.query("UPDATE github_operations SET status='SUCCESS', result=$3::jsonb WHERE organization_id=$1 AND command_id=$2", [organizationId, commandId, JSON.stringify({ merged: true, sha })]);
    else await pool.query("UPDATE github_operations SET status='FAILED' WHERE organization_id=$1 AND command_id=$2", [organizationId, commandId]);
  };
  const ids = (taskId: string) => ({ projectId, repositoryId, taskId });

  it("returns the latest successful integration sha for the task, and null otherwise", async () => {
    await pool.query("INSERT INTO users(id,organization_id,email,display_name,role,password_hash) VALUES($1,$2,'integrator@staging.test','Admin','ADMIN','x')", [userId, organizationId]);
    const taskId = await stagingTask();
    expect(await loadIntegratedRevision(pool, ids(taskId))).toBeNull();
    await record(taskId, "FAILED", null);
    await record(taskId, "SUCCESS", null, "GITHUB_CREATE_PR");
    expect(await loadIntegratedRevision(pool, ids(taskId))).toBeNull();
    await record(taskId, "SUCCESS", "1".repeat(40));
    expect(await loadIntegratedRevision(pool, ids(taskId))).toBe("1".repeat(40));
    await record(taskId, "SUCCESS", "2".repeat(40).toUpperCase());
    expect(await loadIntegratedRevision(pool, ids(taskId))).toBe("2".repeat(40));
    expect(await loadIntegratedRevision(pool, { ...ids(taskId), projectId: foreignProjectId })).toBeNull();
    expect(await loadIntegratedRevision(pool, ids(await stagingTask()))).toBeNull();
  });
});
