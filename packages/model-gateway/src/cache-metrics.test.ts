import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import {
  AnthropicAdapter, CacheMetricsReader, CachePolicy, ModelGateway, PricingCatalog,
  ProviderCredentialStore, ProviderRegistry, type GatewayAlert
} from "./index.js";

const pool = createDatabasePool();
const reader = new CacheMetricsReader(pool);

interface Tenant { org: string; user: string; project: string; repo: string; tasks: string[] }
const tenant = (): Tenant => ({
  org: randomUUID(), user: randomUUID(), project: randomUUID(), repo: randomUUID(),
  tasks: [randomUUID(), randomUUID()]
});
const A = tenant();
const B = tenant();

async function seedTenant(t: Tenant, label: string): Promise<void> {
  await pool.query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [t.org, label]);
  await pool.query(
    `INSERT INTO users (id, organization_id, email, display_name, role)
     VALUES ($1, $2, $3, $4, 'ADMIN')`, [t.user, t.org, `${t.user}@test.local`, label]
  );
  await pool.query("INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, $3)", [t.project, t.org, label]);
  await pool.query(
    "INSERT INTO repositories (id, project_id, full_name, role) VALUES ($1, $2, $3, 'backend')",
    [t.repo, t.project, `novo34/${label}`.toLowerCase().replaceAll(" ", "-")]
  );
  for (const [i, task] of t.tasks.entries()) {
    await pool.query(
      "INSERT INTO tasks (id, project_id, repository_id, title) VALUES ($1, $2, $3, $4)",
      [task, t.project, t.repo, `${label} task ${i}`]
    );
  }
}

interface CallSeed {
  t: Tenant; task: number; outcome?: string; status: string | null;
  input?: number; read?: number; write?: number; output?: number;
  cost?: number | null; without?: number | null; savings?: number | null; at: string;
}
async function seedCall(c: CallSeed): Promise<void> {
  const usage = c.input === undefined ? {} : {
    inputTokens: c.input, outputTokens: c.output ?? 0, cacheReadTokens: c.read ?? 0,
    cacheWriteTokens: c.write ?? 0
  };
  await pool.query(
    `INSERT INTO model_provider_calls (
       request_id, organization_id, project_id, task_id, provider, model, outcome, attempt_count,
       usage, cache_read_tokens, cache_write_tokens, cache_status,
       estimated_cost_chf, estimated_cost_without_cache_chf, estimated_cache_savings_chf, created_at
     ) VALUES ($1,$2,$3,$4,'anthropic','claude-sonnet-5-5',$5,1,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)`,
    [randomUUID(), c.t.org, c.t.project, c.t.tasks[c.task], c.outcome ?? "SUCCESS",
      JSON.stringify(usage), c.read ?? 0, c.write ?? 0, c.status,
      c.cost ?? null, c.without ?? null, c.savings ?? null, c.at]
  );
}

beforeAll(async () => {
  await migrate(pool);
  await seedTenant(A, "Metrics Org A");
  await seedTenant(B, "Metrics Org B");
  // Org A, task 0: write (negative savings), hit (positive savings), failed cache ERROR retry.
  await seedCall({ t: A, task: 0, status: "WRITE", input: 1500, write: 20000, output: 800,
    cost: 0.061, without: 0.051, savings: -0.010, at: "2026-01-01T10:00:00Z" });
  await seedCall({ t: A, task: 0, status: "PARTIAL", input: 1500, read: 20000, output: 800,
    cost: 0.013, without: 0.051, savings: 0.038, at: "2026-01-01T10:01:00Z" });
  await seedCall({ t: A, task: 0, outcome: "FAILED", status: "ERROR", at: "2026-01-01T10:02:00Z" });
  // Org A, task 1: zero cache reads (MISS), a blocked call, and a call not estimable.
  await seedCall({ t: A, task: 1, status: "MISS", input: 700, output: 5,
    cost: 0.002, without: 0.002, savings: 0, at: "2026-01-02T10:00:00Z" });
  await seedCall({ t: A, task: 1, outcome: "BLOCKED", status: "DISABLED", at: "2026-01-02T10:01:00Z" });
  await seedCall({ t: A, task: 1, status: null, input: 10, output: 1, at: "2026-01-02T10:02:00Z" });
  // Org B: a large saving that org A must never see.
  await seedCall({ t: B, task: 0, status: "HIT", input: 0, read: 90000, output: 10,
    cost: 0.01, without: 0.2, savings: 0.19, at: "2026-01-03T10:00:00Z" });
});

afterAll(async () => {
  await pool.query("TRUNCATE task_state_history");
  for (const t of [A, B]) {
    await pool.query("DELETE FROM model_provider_calls WHERE organization_id = $1", [t.org]);
    await pool.query("DELETE FROM cost_events WHERE organization_id = $1", [t.org]);
    await pool.query("DELETE FROM provider_credentials WHERE organization_id = $1", [t.org]);
    await pool.query("DELETE FROM audit_events WHERE organization_id = $1", [t.org]);
    await pool.query("DELETE FROM tasks WHERE project_id = $1", [t.project]);
    await pool.query("DELETE FROM repositories WHERE id = $1", [t.repo]);
    await pool.query("DELETE FROM projects WHERE id = $1", [t.project]);
    await pool.query("DELETE FROM users WHERE id = $1", [t.user]);
    await pool.query("DELETE FROM organizations WHERE id = $1", [t.org]);
  }
  await pool.end();
});

describe("PLT-052 cache metrics views through CacheMetricsReader", () => {
  it("per call: tokens, hit rate, cost and signed savings", async () => {
    const calls = await reader.byCall(A.org, { taskId: A.tasks[0] });
    expect(calls).toHaveLength(3);
    const byStatus = Object.fromEntries(calls.map(c => [c.cacheStatus, c]));
    expect(byStatus.WRITE).toMatchObject({
      ordinaryInputTokens: "1500", cacheWriteTokens: "20000", cacheReadTokens: "0",
      totalInputTokens: "21500", cacheHitRate: "0.000000"
    });
    expect(Number(byStatus.WRITE!.cacheSavingsChf)).toBeCloseTo(-0.01, 6);
    expect(Number(byStatus.WRITE!.cacheSavingsRatio)).toBeLessThan(0);
    expect(byStatus.PARTIAL).toMatchObject({ totalInputTokens: "21500" });
    expect(Number(byStatus.PARTIAL!.cacheHitRate)).toBeCloseTo(20000 / 21500, 6);
    expect(Number(byStatus.PARTIAL!.cacheSavingsChf)).toBeCloseTo(0.038, 6);
    expect(Number(byStatus.PARTIAL!.cacheSavingsRatio)).toBeCloseTo(0.038 / 0.051, 5);
    // A failed call has no usage: counters 0, hit rate 0, no cost.
    expect(byStatus.ERROR).toMatchObject({
      outcome: "FAILED", totalInputTokens: "0", cacheHitRate: "0", costChf: null, cacheSavingsChf: null
    });
    // Fingerprint columns are internal and never returned by the reader.
    expect(Object.keys(calls[0]!).some(k => /prefix|hash|sha/i.test(k))).toBe(false);
  });

  it("per task: sums, token-weighted hit rate, negative and positive savings, status counts", async () => {
    const [task0] = await reader.byTask(A.org, { taskId: A.tasks[0] });
    expect(task0).toMatchObject({
      callsTotal: "3", callsNotEstimable: "0", ordinaryInputTokens: "3000",
      cacheReadTokens: "20000", cacheWriteTokens: "20000", totalInputTokens: "43000",
      outputTokens: "1600", callsWrite: "1", callsPartial: "1", callsError: "1",
      callsHit: "0", callsMiss: "0", callsWithoutStatus: "0"
    });
    expect(Number(task0!.cacheHitRate)).toBeCloseTo(20000 / 43000, 6);
    expect(Number(task0!.costChf)).toBeCloseTo(0.074, 6);
    expect(Number(task0!.costWithoutCacheChf)).toBeCloseTo(0.102, 6);
    expect(Number(task0!.cacheSavingsChf)).toBeCloseTo(0.028, 6);
    expect(task0!.projectId).toBe(A.project);
  });

  it("hit rate is 0 with zero reads, mixed statuses are counted and not-estimable calls are flagged", async () => {
    const [task1] = await reader.byTask(A.org, { taskId: A.tasks[1] });
    expect(task1).toMatchObject({
      callsTotal: "3", cacheReadTokens: "0", cacheHitRate: "0.000000", callsMiss: "1",
      callsDisabled: "1", callsWithoutStatus: "1", callsNotEstimable: "1"
    });
    expect(Number(task1!.cacheSavingsChf)).toBe(0);
  });

  it("per project: aggregates all tasks of the project and nothing else", async () => {
    const projects = await reader.byProject(A.org);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      projectId: A.project, callsTotal: "6", callsNotEstimable: "1",
      cacheReadTokens: "20000", cacheWriteTokens: "20000", ordinaryInputTokens: "3710"
    });
    expect(Number(projects[0]!.cacheSavingsChf)).toBeCloseTo(0.028, 6);
  });

  it("isolates organizations: each sees only its own rows at every level", async () => {
    const forB = {
      projects: await reader.byProject(B.org), tasks: await reader.byTask(B.org),
      calls: await reader.byCall(B.org)
    };
    expect(forB.projects.map(p => p.projectId)).toEqual([B.project]);
    expect(forB.tasks.map(t => t.taskId)).toEqual([B.tasks[0]]);
    expect(forB.calls).toHaveLength(1);
    expect(forB.projects[0]).toMatchObject({ cacheHitRate: "1.000000", cacheReadTokens: "90000" });
    for (const a of [await reader.byProject(A.org), await reader.byTask(A.org), await reader.byCall(A.org)]) {
      expect(a.every(row => row.organizationId === A.org)).toBe(true);
    }
    // Asking for a project or task of the other organization returns nothing, not an error.
    expect(await reader.byProject(A.org, { projectId: B.project })).toEqual([]);
    expect(await reader.byTask(A.org, { taskId: B.tasks[0] })).toEqual([]);
    expect(await reader.byCall(A.org, { taskId: B.tasks[0] })).toEqual([]);
  });

  it("requires a valid organization and bounded filters", async () => {
    await expect(reader.byProject(undefined as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(reader.byTask("not-a-uuid")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(reader.byCall(A.org, { taskId: "x' OR '1'='1" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(reader.byCall(A.org, { limit: 0 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(reader.byCall(A.org, { limit: 100000 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await reader.byCall(A.org, { limit: 2 })).toHaveLength(2);
  });
});

describe("PLT-052 unstable prefix alert between calls of the same task", () => {
  const credentials = new ProviderCredentialStore(pool, Buffer.alloc(32, 7).toString("base64"));
  const rates = {
    "anthropic:*": {
      inputPerMillionChf: 2, outputPerMillionChf: 10, cacheReadPerMillionChf: 0.1,
      cacheWrite5mPerMillionChf: 2.5, cacheWrite1hPerMillionChf: 4
    }
  };
  const ok = () => new Response(JSON.stringify({
    id: "m", type: "message", role: "assistant", stop_reason: "end_turn",
    content: [{ type: "text", text: "OK" }], usage: { input_tokens: 10, output_tokens: 1 }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  const alerts: GatewayAlert[] = [];
  const fetchImpl = (async () => ok()) as unknown as typeof fetch;
  const gateway = (secret = "tenant-namespace-test-secret") => new ModelGateway(
    pool, credentials,
    new ProviderRegistry().register(new AnthropicAdapter(fetchImpl, "https://example.test/v1")),
    new PricingCatalog(rates), 3, 30_000, alert => { alerts.push(alert); },
    CachePolicy.fromEnv({ JEV_PROMPT_CACHE: "on" }), secret
  );
  const request = (task: number, rules: string, version = "1", t = A) => ({
    requestId: randomUUID(), organizationId: t.org, projectId: t.project, taskId: t.tasks[task]!,
    agentRole: "DEVELOPER", targets: [{ provider: "anthropic" as const, model: "claude-sonnet-5-5" }],
    segments: [
      { kind: "system" as const, content: "You are JEV." },
      { kind: "rules" as const, id: "r1", version, content: rules },
      { kind: "input" as const, content: "go " + randomUUID() }
    ]
  });
  const unstable = () => alerts.filter(a => a.code === "PROMPT_UNSTABLE_CONTENT" && /changed without/.test(a.reason));

  beforeAll(async () => {
    await credentials.configure(A.org, "anthropic", "anthropic-test-secret-1234", A.user);
    await credentials.configure(B.org, "anthropic", "anthropic-test-secret-1234", B.user);
  });

  it("stores the fingerprint and does not alert on the first call or on an identical prefix", async () => {
    alerts.length = 0;
    const g = gateway();
    const first = request(0, "rule one");
    await g.execute(first);
    await g.execute(request(0, "rule one"));
    expect(unstable()).toEqual([]);
    const stored = (await pool.query(
      `SELECT prefix_tools_sha256, prefix_segment_refs FROM model_provider_calls
        WHERE request_id = $1`, [first.requestId])).rows[0];
    expect(stored.prefix_tools_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.prefix_segment_refs).toEqual(expect.arrayContaining([expect.stringContaining("r1")]));
  });

  it("alerts, without blocking the call, when the content changes with the same id and version", async () => {
    alerts.length = 0;
    const g = gateway();
    await g.execute(request(0, "rule one"));
    const changed = request(0, "rule one, silently edited");
    await expect(g.execute(changed)).resolves.toMatchObject({ provider: "anthropic" });
    const found = unstable();
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found.every(a => a.organizationId === A.org && a.requestId === changed.requestId)).toBe(true);
    expect(found.map(a => a.reason).join(" ")).toMatch(/prefix_project_sha256/);
    expect((await pool.query("SELECT outcome FROM model_provider_calls WHERE request_id = $1",
      [changed.requestId])).rows[0].outcome).toBe("SUCCESS");
  });

  it("does not alert when the change is declared with a new version", async () => {
    alerts.length = 0;
    const g = gateway();
    await g.execute(request(1, "rule one"));
    await g.execute(request(1, "rule two", "2"));
    expect(unstable()).toEqual([]);
  });

  it("compares only calls of the same task and organization", async () => {
    alerts.length = 0;
    const g = gateway();
    await g.execute(request(0, "other content", "1", B));
    expect(unstable()).toEqual([]);
  });

  it("never blocks a call when the fingerprint lookup fails", async () => {
    alerts.length = 0;
    const broken = Object.create(pool, {
      query: { value: async (sql: string, ...rest: unknown[]) => {
        if (String(sql).includes("model_cache_metrics_by_call")) throw new Error("view unavailable");
        return (pool.query as (...a: unknown[]) => unknown)(sql, ...rest);
      } }
    });
    const g = new ModelGateway(
      broken, credentials,
      new ProviderRegistry().register(new AnthropicAdapter(fetchImpl, "https://example.test/v1")),
      new PricingCatalog(rates), 3, 30_000, alert => { alerts.push(alert); },
      CachePolicy.fromEnv({ JEV_PROMPT_CACHE: "on" }), "tenant-namespace-test-secret"
    );
    await expect(g.execute(request(0, "anything else"))).resolves.toMatchObject({ provider: "anthropic" });
    expect(unstable()).toEqual([]);
  });
});
