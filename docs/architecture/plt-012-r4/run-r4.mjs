#!/usr/bin/env node
/**
 * PLT-012 R4: first real staging deployment of novo34/jev-staging-demo through the @jev/staging orchestrator.
 *
 *   node run-r4.mjs --dry-run   (default) builds everything, validates, prints the masked compose. No Dokploy POST.
 *   node run-r4.mjs --execute   REAL run against https://dokploy.nuvurent.com (operator approval required).
 *
 * Local DB: postgresql://jev_runtime@127.0.0.1:5432/jev_r4 (trust auth, no password). Fixtures are inserted
 * idempotently with the admin role `jev` (see ensureFixtures). Override with R4_DB_HOST/R4_DB_PORT/R4_DB_NAME.
 * Never prints passwords or full database URLs.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

// Node's global fetch only honours the agent proxy with NODE_USE_ENV_PROXY=1: re-exec once with it.
if (process.env.NODE_USE_ENV_PROXY !== "1" && process.env.HTTPS_PROXY) {
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env: { ...process.env, NODE_USE_ENV_PROXY: "1" } });
  process.exit(r.status ?? 1);
}

const REPO = process.env.JEV_PLATFORM_DIR ?? "/home/user/jev-platform";
const imp = (p) => import(pathToFileURL(`${REPO}/${p}`).href);
const { createDatabasePool } = await imp("packages/db/dist/index.js");
const S = await imp("packages/staging/dist/index.js");
const { default: pg } = await import(pathToFileURL(`${REPO}/node_modules/pg/lib/index.js`).href);

const execute = process.argv.includes("--execute");
const dryRun = !execute;
if (execute && process.argv.includes("--dry-run")) throw new Error("--dry-run and --execute are mutually exclusive");

// ---------------------------------------------------------------- constants
const DB = { host: process.env.R4_DB_HOST ?? "127.0.0.1", port: process.env.R4_DB_PORT ?? "5432", name: process.env.R4_DB_NAME ?? "jev_r4" };
const REVISION = "7baa28629d811aec3845d28ae558e17b3d733c10";
const detId = (label) => { // deterministic UUIDs so fixtures are idempotent
  const h = createHash("sha256").update(`jev-r4:${label}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const IDS = { org: detId("org"), user: detId("user"), project: detId("project"), repo: detId("repo"), order: detId("order") };
const REPO_ROW = { fullName: "novo34/jev-staging-demo", defaultBranch: "main", stagingBranch: "staging", stagingUrl: "https://demo.staging.nuvurent.com" };

/**
 * NOTE stagingBaseDomain: the policy requires host = `<slug>.staging.<stagingBaseDomain>`. For
 * demo.staging.nuvurent.com the value that satisfies it is `nuvurent.com` (not `staging.nuvurent.com`,
 * which would require demo.staging.staging.nuvurent.com). Verified below by validateBaseDomain().
 */
const SETTINGS = {
  stagingBaseDomain: "nuvurent.com",
  dokployEnvironmentId: "iLssf876B5hWf_TLDmFCq",
  // dokployServerId: intentionally undefined
  appPort: 3000,
  healthPath: "/health",
  migrationCommand: "node src/migrate.js",
  seedCommand: "node src/seed.js",
  e2eRoutes: [{ path: "/", bodyIncludes: "JEV staging demo" }],
  // Optional in the type; a marker that matches nothing of the demo (must not be a substring of any env value).
  productionMarkers: ["jev-r4-production-marker.invalid"]
  // secretRefs / secretValues / extraEnv / appImage: none (build from github.com/<repo>.git#<sha>)
};
const DOKPLOY = { baseUrl: "https://dokploy.nuvurent.com", apiKey: "proxy-injected" };

// ---------------------------------------------------------------- helpers
const mask = (text) => String(text)
  .replace(/(\b[a-z]+:\/\/[^:\/\s@]+:)[^@\s]+@/gi, "$1***@")
  .replace(/(PASSWORD=)\S+/g, "$1***");
const maskEnv = (env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, /PASSWORD|SECRET|TOKEN|KEY/.test(k) && !/^STAGING_DB_RUNTIME$|^STAGING_DB_OWNER$/.test(k) ? "***" : mask(v)]));
const line = (s = "") => console.log(s);
const adminPool = () => new pg.Pool({ host: DB.host, port: Number(DB.port), user: "jev", database: DB.name });
const runtimePool = () => createDatabasePool({ connectionString: `postgresql://jev_runtime@${DB.host}:${DB.port}/${DB.name}`, application_name: "jev-r4" });

/**
 * Fixtures. Official writers: jev_create_task / jev_transition_task (SQL controlled writers, same as the tests).
 * Direct INSERTs (as admin `jev`, because there is no runtime writer for them locally; same as deployments.test.ts):
 *   organizations, users, projects, repositories, orders, github_operations (the ledger normally written by the
 *   control service after a real GitHub merge; here the 7baa286 SHA was merged by the operator, so it is recorded).
 */
async function ensureFixtures(admin) {
  const q = (sql, params) => admin.query(sql, params);
  await q("INSERT INTO organizations(id,name) VALUES($1,'JEV R4 Org') ON CONFLICT DO NOTHING", [IDS.org]);
  await q("INSERT INTO users(id,organization_id,email,display_name,role,password_hash) VALUES($1,$2,'r4-operator@jev.invalid','R4 operator','ADMIN','!') ON CONFLICT DO NOTHING", [IDS.user, IDS.org]);
  await q("INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'jev-staging-demo') ON CONFLICT DO NOTHING", [IDS.project, IDS.org]);
  await q(`INSERT INTO repositories(id,project_id,full_name,role,default_branch,staging_branch,staging_url,staging_database_enabled)
           VALUES($1,$2,$3,'other',$4,$5,$6,true) ON CONFLICT DO NOTHING`,
    [IDS.repo, IDS.project, REPO_ROW.fullName, REPO_ROW.defaultBranch, REPO_ROW.stagingBranch, REPO_ROW.stagingUrl]);
  await q("INSERT INTO orders(id,project_id,objective) VALUES($1,$2,'R4 staging demo') ON CONFLICT DO NOTHING", [IDS.order, IDS.project]);
  let task = (await q("SELECT id FROM tasks WHERE project_id=$1 AND title='R4 staging demo task' ORDER BY created_at LIMIT 1", [IDS.project])).rows[0]?.id;
  if (!task) {
    task = (await q("SELECT jev_create_task($1,$2,$3,'R4 staging demo task','R4','[]'::jsonb) AS id", [IDS.project, IDS.order, IDS.repo])).rows[0].id;
    const t = (to, actor, ref, ev = {}) => q("SELECT jev_transition_task($1,$2,$3,$4,'r4-fixture',$5::jsonb)", [task, to, actor, ref, JSON.stringify(ev)]);
    await t("READY", "SYSTEM", null);
    await t("RUNNING", "SYSTEM", null);
    await t("VERIFYING", "SYSTEM", null);
    // Independent technical verification evidence (same shape the tests use); task ends VERIFIED.
    await t("VERIFIED", "AGENT", "independent-qa-process", { technicalVerification: { passed: true, revision: REVISION } });
  }
  const has = (await q("SELECT 1 FROM github_operations WHERE task_id=$1 AND action='GITHUB_INTEGRATE_STAGING' AND status='SUCCESS' AND result->>'sha'=$2", [task, REVISION])).rowCount;
  if (!has) {
    const commandId = `r4-integrate-${REVISION.slice(0, 12)}`;
    await q("INSERT INTO github_operations(organization_id,project_id,repository_id,task_id,actor_id,command_id,action,request_hash,status) VALUES($1,$2,$3,$4,$5,$6,'GITHUB_INTEGRATE_STAGING',$7,'PENDING')",
      [IDS.org, IDS.project, IDS.repo, task, IDS.user, commandId, "a".repeat(64)]);
    await q("UPDATE github_operations SET status='SUCCESS', result=$3::jsonb WHERE organization_id=$1 AND command_id=$2", [IDS.org, commandId, JSON.stringify({ merged: true, sha: REVISION })]);
  }
  return task;
}

function validateBaseDomain() {
  const checks = [];
  for (const base of ["nuvurent.com", "staging.nuvurent.com"]) {
    try { checks.push(`${base} -> slug ${S.slugFromStagingUrl(REPO_ROW.stagingUrl, base)}`); } catch (e) { checks.push(`${base} -> REJECTED (${e.code})`); }
  }
  return checks;
}

// ---------------------------------------------------------------- dry-run simulated Dokploy
/** GET environment.one goes to the real API (read only); everything else is simulated and POSTs are recorded. */
function makeDryRunFetch(recorded) {
  const state = { composeFile: "", env: "", appName: "" };
  return async (input, init = {}) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\//, "");
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if ((init.method ?? "GET") === "GET") {
      if (path === "environment.one") {
        const real = await fetch(input, init);
        const text = await real.text();
        recorded.environmentOne = { status: real.status, text };
        return new Response(text, { status: real.status, headers: { "content-type": "application/json" } });
      }
      if (path === "compose.one") return json({ composeId: "dry-run-compose", name: state.appName, appName: state.appName, composeStatus: "done", composeFile: state.composeFile, env: state.env });
      if (path === "domain.byComposeId") return json([]);
      throw new Error(`dry-run: unexpected GET ${path}`);
    }
    const body = JSON.parse(init.body ?? "{}");
    recorded.posts.push({ path, body });
    if (path === "compose.create") { state.composeFile = body.composeFile; state.appName = body.appName; return json({ composeId: "dry-run-compose" }); }
    if (path === "compose.saveEnvironment") { state.env = body.env; return json({}); }
    return json({});
  };
}

// ---------------------------------------------------------------- main
line(`R4 runner  mode=${dryRun ? "DRY-RUN (no Dokploy POST)" : "EXECUTE (REAL Dokploy)"}  db=${DB.host}:${DB.port}/${DB.name}`);
if (!/^(127\.0\.0\.1|localhost)$/.test(DB.host)) throw new Error("refusing non-local database host");
line("baseDomain check:"); for (const c of validateBaseDomain()) line("  " + c);

const admin = adminPool();
let taskId;
try { taskId = await ensureFixtures(admin); } finally { await admin.end(); }
line(`fixtures ok  org=${IDS.org} project=${IDS.project} repo=${IDS.repo} task=${taskId}`);

const pool = runtimePool();
try {
  const ids = { projectId: IDS.project, repositoryId: IDS.repo, taskId };
  const integrated = await S.loadIntegratedRevision(pool, ids);
  if (integrated !== REVISION) throw new Error(`integrated revision in ledger (${integrated}) != expected`);
  line(`ledger integrated revision = ${integrated}`);
  const config = await S.loadProjectStagingConfig(pool, ids, SETTINGS);
  line(`config: repo=${config.request.repository} staging=${config.request.stagingBranch} default=${config.defaultBranch} source=${config.request.sourceBranch}`);
  line(`        url=${config.request.stagingUrl} databaseRef=${config.request.databaseRef} slug=${S.slugFromStagingUrl(config.request.stagingUrl, SETTINGS.stagingBaseDomain)} secretRefs=${JSON.stringify(config.request.secretRefs)}`);

  if (dryRun) {
    const recorded = { posts: [], environmentOne: null };
    const events = [];
    const client = new S.DokployClient({ ...DOKPLOY, fetchImpl: makeDryRunFetch(recorded), onEvent: (e) => events.push(`${e.method} ${e.path} ${e.status} ${e.outcome}`) });
    const adapter = S.createDokployAdapterFactory(client)(config);
    const request = { ...config.request, revision: REVISION };
    // deploy() runs the real adapter code: policy, ownership checks, env guard, compose render, domain, deploy.
    const result = await adapter.deploy(request);
    line(`\nenvironment.one (REAL GET): http ${recorded.environmentOne?.status}`);
    try {
      const comps = S.parseEnvironmentComposes(JSON.parse(recorded.environmentOne.text));
      line(`  parsed ok; existing composes in environment: ${comps.length} ${JSON.stringify(comps.map((c) => c.name))}`);
    } catch (e) { line(`  PARSE FAILED: ${e.code ?? e.message}`); }
    line(`adapter.deploy (simulated Dokploy): ok=${result.ok} detail=${result.detail}`);
    line("POSTs that WOULD be sent (not sent):");
    for (const p of recorded.posts) {
      if (p.path === "compose.saveEnvironment") {
        const env = S.parseEnv(p.body.env);
        line(`  - ${p.path} composeId=${p.body.composeId}\n    env(masked)=${JSON.stringify(maskEnv(env), null, 2).replace(/\n/g, "\n    ")}`);
      } else if (p.path === "compose.create") {
        const { composeFile, ...rest } = p.body;
        line(`  - ${p.path} ${JSON.stringify(rest)} (composeFile below)`);
      } else line(`  - ${p.path} ${JSON.stringify(p.body)}`);
    }
    const create = recorded.posts.find((p) => p.path === "compose.create");
    const file = create?.body.composeFile ?? "";
    line("\n===== compose that would be sent (secrets are ${VAR} references only) =====");
    line(file.trimEnd());
    line("===== end compose =====");
    const checks = {
      "build context pinned to exact sha": file.includes(`https://github.com/novo34/jev-staging-demo.git#${REVISION}`),
      "db has no published ports": !/^\s+ports:/m.test(file),
      "db on internal network only": /db:[\s\S]*?networks: \[internal\]/.test(file),
      "migrate service uses node src/migrate.js": file.includes('"node src/migrate.js"'),
      "seed service uses node src/seed.js": file.includes('"node src/seed.js"'),
      "app joins dokploy-network": file.includes("networks: [internal, dokploy-network]"),
      "domain demo.staging.nuvurent.com -> app:3000 https letsencrypt": recorded.posts.some((p) => p.path === "domain.create" && p.body.host === "demo.staging.nuvurent.com" && p.body.serviceName === "app" && p.body.port === 3000 && p.body.https === true && p.body.certificateType === "letsencrypt"),
      "target environment id": recorded.posts.some((p) => p.path === "compose.create" && p.body.environmentId === SETTINGS.dokployEnvironmentId),
      "no serverId sent": !recorded.posts.some((p) => "serverId" in p.body),
      "revision env == sha": recorded.posts.some((p) => p.path === "compose.saveEnvironment" && S.parseEnv(p.body.env).JEV_STAGING_REVISION === REVISION)
    };
    line("\nvalidations:");
    let bad = 0; for (const [k, v] of Object.entries(checks)) { line(`  [${v ? "PASS" : "FAIL"}] ${k}`); if (!v) bad += 1; }
    line(`client events: ${events.join(" | ")}`);

    // Informational, read-only: is the repo publicly buildable (Dokploy builds from the https git URL without credentials)?
    try {
      const r = await fetch("https://github.com/novo34/jev-staging-demo", { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10_000) });
      line(`\nrepo visibility probe (unauthenticated HEAD github.com/${REPO_ROW.fullName}): http ${r.status} -> ${r.status === 200 ? "PUBLIC (build will work)" : "NOT PUBLIC / not reachable: build from the git URL will fail until the repo is public"}`);
    } catch (e) { line(`\nrepo visibility probe failed: ${mask(e.message).slice(0, 120)}`); }
    line(`\nDRY-RUN ${bad === 0 && result.ok ? "OK" : "FAILED"}. No POST was sent to Dokploy; no deployment row was written.`);
    process.exitCode = bad === 0 && result.ok ? 0 : 1;
  } else {
    const events = [];
    const client = new S.DokployClient({ ...DOKPLOY, onEvent: (e) => { events.push(e); line(`  [dokploy] ${e.method} ${e.path} -> ${e.status ?? "-"} ${e.outcome}${e.code ? " " + e.code : ""}`); } });
    const adapter = S.createDokployAdapterFactory(client)(config);
    const registry = new S.PgDeploymentRegistry(pool);
    const ac = new AbortController();
    process.once("SIGINT", () => ac.abort());
    line("\nRunning orchestrator (6 stages)...");
    const run = await new S.StagingOrchestrator(adapter, registry).run({ request: config.request, revision: REVISION, signal: ac.signal, secrets: [DOKPLOY.apiKey] });
    for (const st of run.stages) line(`stage ${st.stage.padEnd(16)} ${st.status.padEnd(8)} ${st.durationMs}ms  ${mask(st.detail)}  ${mask(JSON.stringify(st.metadata))}`);
    line(`\noutcome=${run.outcome}${run.failedStage ? " failedStage=" + run.failedStage : ""}${run.blockedReason ? " blockedReason=" + run.blockedReason : ""}`);
    const row = (await pool.query("SELECT d.id,d.status,d.url,d.revision,d.provider,e.kind,e.url AS env_url FROM deployments d JOIN environments e ON e.id=d.environment_id WHERE d.id=$1", [run.deploymentId])).rows[0];
    line(`deployment row (local DB): ${JSON.stringify(row)}`);
    process.exitCode = run.outcome === "READY" ? 0 : 2;
  }
} finally {
  await pool.end();
}
