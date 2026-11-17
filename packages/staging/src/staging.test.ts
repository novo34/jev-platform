import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DokployStagingAdapter, type DokployStagingConfig } from "./adapter.js";
import { DokployClient, type DokployClientEvent, type FetchLike } from "./client.js";
import { renderStagingCompose } from "./compose-template.js";
import { DokployError, type DokployErrorCode } from "./errors.js";
import { MockDokploy } from "./mock-dokploy.js";
import { parseEnv } from "./mapping.js";
import { slugFromStagingUrl, StagingPolicyError, validateStagingRequest, type StagingDeploymentRequest, type StagingReferencePolicy } from "./policy.js";
import { sanitizeText } from "./sanitize.js";

const API_KEY = "dk_live_SuperSecretKey1234567890abcdef";

const policy: StagingReferencePolicy = {
  databaseRefs: new Set(["espacore_staging"]),
  secretRefs: new Set(["SMTP_PASSWORD", "STRIPE_TEST_KEY"]),
  stagingBaseDomain: "example.test"
};

const request = (overrides: Partial<StagingDeploymentRequest> = {}): StagingDeploymentRequest => ({
  projectId: "proj-1",
  taskId: "task-1",
  repositoryId: "repo-1",
  repository: "novo34/espacore",
  sourceBranch: "jev/task-1",
  stagingBranch: "staging",
  stagingUrl: "https://espacore.staging.example.test",
  databaseRef: "espacore_staging",
  environmentKind: "PERMANENT_STAGING",
  secretRefs: [],
  ...overrides
});

let mock: MockDokploy;
let events: DokployClientEvent[];

beforeEach(async () => {
  mock = new MockDokploy(API_KEY);
  events = [];
  await mock.start();
});
afterEach(async () => {
  await mock.stop();
});

function client(options: { timeoutMs?: number; apiKey?: string } = {}): DokployClient {
  return new DokployClient({ baseUrl: mock.url, apiKey: options.apiKey ?? API_KEY, timeoutMs: options.timeoutMs, onEvent: (e) => events.push(e) });
}

/** Real HTTP: the public staging URL is routed to the local mock server. */
const toMockPublic: FetchLike = (input, init) => {
  const url = new URL(input);
  return fetch(`${mock.url}/public${url.pathname}${url.search}`, init);
};

function adapter(overrides: Partial<DokployStagingConfig> = {}): DokployStagingAdapter {
  return new DokployStagingAdapter({
    client: client(),
    environmentId: "env_1",
    policy,
    pollIntervalMs: 5,
    deployTimeoutMs: 2_000,
    httpTimeoutMs: 500,
    fetchImpl: toMockPublic,
    ...overrides
  });
}

const posts = (): string[] => mock.calls.filter((c) => c.method === "POST").map((c) => c.path);

describe("policy (FND-026 provider_policy)", () => {
  it("accepts a valid permanent staging request", () => {
    expect(() => validateStagingRequest(request({ secretRefs: ["SMTP_PASSWORD"] }), policy)).not.toThrow();
  });

  it.each(["main", "master", "production", "prod", "MAIN"])("rejects production branch %s as staging branch", (branch) => {
    expect(() => validateStagingRequest(request({ stagingBranch: branch }), policy)).toThrow(new StagingPolicyError("staging_branch_must_not_be_production"));
  });

  it("rejects a production source branch and the default branch", () => {
    expect(() => validateStagingRequest(request({ sourceBranch: "master" }), policy)).toThrow("task_source_branch_must_not_be_production");
    expect(() => validateStagingRequest(request({ stagingBranch: "develop" }), { ...policy, protectedBranches: new Set(["develop"]) })).toThrow("staging_branch_must_not_be_production");
  });

  it("rejects identical branches, wrong kind, missing/unknown refs, unknown secrets and foreign hosts", () => {
    expect(() => validateStagingRequest(request({ sourceBranch: "staging" }), policy)).toThrow("source_and_staging_branch_must_differ");
    expect(() => validateStagingRequest(request({ environmentKind: "PRODUCTION" }), policy)).toThrow("environment_must_be_permanent_staging");
    expect(() => validateStagingRequest(request({ databaseRef: "" }), policy)).toThrow("staging_database_ref_required");
    expect(() => validateStagingRequest(request({ databaseRef: "espacore_prod" }), policy)).toThrow("staging_database_reference_not_allowed");
    expect(() => validateStagingRequest(request({ stagingUrl: "" }), policy)).toThrow("staging_url_required");
    expect(() => validateStagingRequest(request({ secretRefs: ["PROD_DB_PASSWORD", "SMTP_PASSWORD", "AWS_KEY"] }), policy)).toThrow("staging_secret_reference_not_allowed:AWS_KEY,PROD_DB_PASSWORD");
    expect(() => validateStagingRequest(request({ stagingUrl: "https://espacore.example.com" }), policy)).toThrow("staging_url_host_not_allowed");
    expect(() => validateStagingRequest(request({ stagingUrl: "http://espacore.staging.example.test" }), policy)).toThrow("staging_url_must_be_plain_https");
  });

  it("derives the slug from the staging URL", () => {
    expect(slugFromStagingUrl("https://espacore.staging.example.test", "example.test")).toBe("espacore");
    expect(() => slugFromStagingUrl("https://-bad-.staging.example.test", "example.test")).toThrow("staging_url_slug_invalid");
  });
});

describe("DokployClient", () => {
  it("requires an https base URL (loopback excepted) and an API key", () => {
    expect(() => new DokployClient({ baseUrl: "http://dokploy.example.com", apiKey: API_KEY })).toThrow("dokploy_base_url_must_be_https");
    expect(() => new DokployClient({ baseUrl: "https://dokploy.example.com", apiKey: "" })).toThrow("dokploy_api_key_required");
  });

  it.each<[number, DokployErrorCode]>([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
    [409, "conflict"],
    [429, "rate_limited"],
    [500, "upstream"],
    [503, "upstream"]
  ])("maps HTTP %i to %s", async (status, code) => {
    mock.fail({ path: "compose.one", status, headers: { "retry-after": "7" } });
    const error = await client().get("compose.one", { composeId: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DokployError);
    expect((error as DokployError).code).toBe(code);
    expect((error as DokployError).status).toBe(status);
    if (code === "rate_limited") expect((error as DokployError).retryAfterSeconds).toBe(7);
  });

  it("maps a wrong key to unauthorized", async () => {
    const error = await client({ apiKey: "dk_wrong_key_value_000000" }).get("environment.one", { environmentId: "env_1" }).catch((e: unknown) => e);
    expect((error as DokployError).code).toBe("unauthorized");
  });

  it("maps a slow answer to timeout", async () => {
    mock.fail({ path: "compose.one", status: 200, body: "{}", delayMs: 400 });
    const error = await client({ timeoutMs: 60 }).get("compose.one", { composeId: "x" }).catch((e: unknown) => e);
    expect((error as DokployError).code).toBe("timeout");
  });

  it("maps non-JSON and malformed payloads to invalid_response", async () => {
    mock.fail({ path: "compose.one", status: 200, body: "<html>proxy</html>" });
    expect(((await client().get("compose.one", {}).catch((e: unknown) => e)) as DokployError).code).toBe("invalid_response");
    mock.fail({ path: "environment.one", status: 200, body: JSON.stringify({ environmentId: "env_1", compose: [{ name: "no id" }] }) });
    const result = await adapter().deploy(request());
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("dokploy_invalid_response");
  });

  it("does not follow redirects", async () => {
    mock.fail({ path: "compose.one", status: 302, headers: { location: "http://127.0.0.1:1/steal" } });
    const error = await client().get("compose.one", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DokployError);
    expect((error as DokployError).code).not.toBe("invalid_response");
    expect(mock.calls).toHaveLength(1);
  });

  it("never leaks the API key in errors or events, even when the upstream echoes it", async () => {
    mock.fail({ path: "compose.one", status: 500, body: `boom x-api-key: ${API_KEY} and ${API_KEY}` });
    const error = (await client().get("compose.one", {}).catch((e: unknown) => e)) as DokployError;
    expect(error.message).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect(error.stack ?? "").not.toContain(API_KEY);
    await client().get("environment.one", { environmentId: "env_1" });
    expect(JSON.stringify(events)).not.toContain(API_KEY);
    expect(events.length).toBeGreaterThan(0);
  });

  it("sanitizes credentials embedded in URLs", () => {
    expect(sanitizeText("postgresql://owner:hunter2pass@db:5432/x")).toBe("postgresql://[REDACTED]@db:5432/x");
  });
});

describe("DokployStagingAdapter.deploy", () => {
  it("creates compose (with its own database), variables, domain and deployment in order", async () => {
    const result = await adapter({ secretValues: { SMTP_PASSWORD: "smtp-secret-value" } }).deploy(request({ secretRefs: ["SMTP_PASSWORD"] }));
    expect(result).toMatchObject({ ok: true, detail: "created_and_deployed", metadata: { created: true, domainCreated: true, redeployed: false, branch: "staging" } });
    expect(posts()).toEqual(["compose.create", "compose.saveEnvironment", "domain.create", "compose.deploy"]);

    const create = mock.calls.find((c) => c.path === "compose.create")!.body!;
    expect(create).toMatchObject({ name: "jev-stg-espacore", appName: "jev-stg-espacore", environmentId: "env_1", composeType: "docker-compose" });
    const file = String(create.composeFile);
    expect(file).toContain("https://github.com/novo34/espacore.git#staging");
    expect(file).toMatch(/^ {2}db:/m);
    expect(file).toContain("db-data:/var/lib/postgresql/data");
    expect(file).not.toMatch(/^\s+ports:/m);

    const compose = [...mock.composes.values()][0]!;
    const env = parseEnv(compose.env);
    expect(env.DATABASE_URL).toMatch(/^postgresql:\/\/espacore_staging_runtime:[0-9a-f]+@db:5432\/espacore_staging$/);
    expect(env.STAGING_ENVIRONMENT).toBe("staging");
    expect(env.SMTP_PASSWORD).toBe("smtp-secret-value");
    // Secrets live in the Dokploy env, never in the generated file or in the result.
    expect(file).not.toContain(env.STAGING_DB_OWNER_PASSWORD);
    expect(file).not.toContain("smtp-secret-value");
    expect(JSON.stringify(result)).not.toContain(env.STAGING_DB_OWNER_PASSWORD);
    expect(compose.composeStatus).toBe("done");
  });

  it("registers the domain with Let's Encrypt on the app service", async () => {
    await adapter().deploy(request());
    const body = mock.calls.find((c) => c.path === "domain.create")!.body!;
    expect(body).toMatchObject({ host: "espacore.staging.example.test", serviceName: "app", port: 3000, https: true, certificateType: "letsencrypt" });
    expect([...mock.domains.values()][0]).toHaveLength(1);
  });

  it("is idempotent: the second run reuses compose, variables, passwords and domain", async () => {
    const stagingAdapter = adapter();
    await stagingAdapter.deploy(request());
    const before = [...mock.composes.values()][0]!.env;
    mock.calls.length = 0;
    const second = await stagingAdapter.deploy(request());
    expect(second).toMatchObject({ ok: true, detail: "reused_and_redeployed", metadata: { created: false, domainCreated: false, redeployed: true } });
    expect(posts()).toEqual(["compose.redeploy"]);
    expect(mock.composes.size).toBe(1);
    expect([...mock.domains.values()][0]).toHaveLength(1);
    expect([...mock.composes.values()][0]!.env).toBe(before);
  });

  it("updates the compose file when the template changes, without recreating anything", async () => {
    await adapter().deploy(request());
    mock.calls.length = 0;
    await adapter({ migrationCommand: "npm run migrate" }).deploy(request());
    expect(posts()).toEqual(["compose.update", "compose.redeploy"]);
    expect(mock.composes.size).toBe(1);
  });

  it("rejects a production branch before any Dokploy call", async () => {
    await expect(adapter().deploy(request({ stagingBranch: "main" }))).rejects.toThrow("staging_branch_must_not_be_production");
    expect(mock.calls).toHaveLength(0);
  });

  it("rejects secret refs outside the allowlist before any Dokploy call", async () => {
    await expect(adapter().deploy(request({ secretRefs: ["PROD_DB_PASSWORD"] }))).rejects.toThrow("staging_secret_reference_not_allowed:PROD_DB_PASSWORD");
    expect(mock.calls).toHaveLength(0);
  });

  it.each<[string, Partial<DokployStagingConfig>, string]>([
    ["production variable name", { extraEnv: { PROD_API_URL: "https://x.example.test" } }, "env_production_name_rejected:PROD_API_URL"],
    ["production marker in value", { extraEnv: { API_URL: "https://api.espacore.com" }, productionMarkers: ["espacore.com"] }, "env_production_value_rejected:API_URL"],
    ["foreign database URL", { extraEnv: { REPORTING_URL: "postgresql://ro:pw@db.prod-cluster.internal:5432/app" } }, "env_database_host_not_staging:REPORTING_URL"],
    ["secret value pointing to production", { secretValues: { SMTP_PASSWORD: "pw-for-live.espacore.com" }, productionMarkers: ["live.espacore.com"] }, "env_production_value_rejected:SMTP_PASSWORD"],
    ["missing secret value", { secretValues: {} }, "secret_value_missing:SMTP_PASSWORD"],
    ["overriding the staging DATABASE_URL", { extraEnv: { DATABASE_URL: "postgresql://a:b@db:5432/x" } }, "env_reserved_name_rejected:DATABASE_URL"]
  ])("refuses %s without creating anything", async (_name, config, detail) => {
    const result = await adapter(config).deploy(request({ secretRefs: config.secretValues ? ["SMTP_PASSWORD"] : [] }));
    expect(result).toMatchObject({ ok: false, detail });
    expect(posts()).toEqual([]);
  });

  it("maps Dokploy HTTP failures to step results without leaking the key", async () => {
    mock.fail({ path: "compose.create", status: 409, body: `conflict ${API_KEY}` });
    const conflict = await adapter().deploy(request());
    expect(conflict).toMatchObject({ ok: false, detail: "dokploy_conflict" });

    const rejected = await adapter({ client: client({ apiKey: "dk_wrong_key_value_000000" }) }).deploy(request());
    expect(rejected).toMatchObject({ ok: false, detail: "dokploy_unauthorized" });
    expect(JSON.stringify([conflict, rejected, events])).not.toContain(API_KEY);
  });

  it("reports a timeout from Dokploy as a failed step", async () => {
    mock.fail({ path: "environment.one", status: 200, body: "{}", delayMs: 400 });
    const result = await adapter({ client: client({ timeoutMs: 60 }) }).deploy(request());
    expect(result).toMatchObject({ ok: false, detail: "dokploy_timeout" });
  });

  it("fails the step when the deployment ends in error and keeps the compose", async () => {
    mock.deployStatuses = ["running", "error"];
    const result = await adapter().deploy(request());
    expect(result).toMatchObject({ ok: false, detail: "deployment_failed" });
    expect(mock.composes.size).toBe(1);
  });

  it("refuses to reuse a domain with a different certificate type", async () => {
    await adapter().deploy(request());
    const [composeId] = [...mock.domains.keys()];
    mock.domains.get(composeId!)![0]!.certificateType = "none";
    const result = await adapter().deploy(request());
    expect(result).toMatchObject({ ok: false, detail: "dokploy_conflict" });
  });
});

describe("verifyDatabase, migrations and seeds", () => {
  it("verifies the isolated database after a deployment", async () => {
    const stagingAdapter = adapter();
    expect(await stagingAdapter.verifyDatabase(request())).toMatchObject({ ok: false, detail: "compose_missing" });
    await stagingAdapter.deploy(request());
    expect(await stagingAdapter.verifyDatabase(request())).toMatchObject({ ok: true, detail: "database_isolated" });
  });

  it("fails when the database would be exposed or points elsewhere", async () => {
    const stagingAdapter = adapter();
    await stagingAdapter.deploy(request());
    const compose = [...mock.composes.values()][0]!;
    const goodFile = compose.composeFile;
    compose.composeFile = `${goodFile}\n    ports:\n      - "5432:5432"\n`;
    expect(await stagingAdapter.verifyDatabase(request())).toMatchObject({ ok: false, detail: "database_ports_published" });
    compose.composeFile = goodFile;
    compose.env = compose.env.replace(/DATABASE_URL=postgresql:\/\/([^@]+)@db:/, "DATABASE_URL=postgresql://$1@prod-db.internal:");
    expect(await stagingAdapter.verifyDatabase(request())).toMatchObject({ ok: false, detail: "database_url_not_staging" });
  });

  it("runs project migrations and seeds as one-shot services that gate the app", async () => {
    const stagingAdapter = adapter({ migrationCommand: "npm run db:migrate", seedCommand: "npm run db:seed" });
    await stagingAdapter.deploy(request());
    const file = [...mock.composes.values()][0]!.composeFile;
    expect(file).toMatch(/^ {2}migrate:/m);
    expect(file).toMatch(/^ {2}seed:/m);
    expect(file).toContain("service_completed_successfully");
    expect(parseEnv([...mock.composes.values()][0]!.env).STAGING_SEED_SYNTHETIC_ONLY).toBe("1");
    expect(await stagingAdapter.applyMigrations(request())).toMatchObject({ ok: true, detail: "migrate_completed_with_deployment" });
    expect(await stagingAdapter.seedTestData(request())).toMatchObject({ ok: true, detail: "seed_completed_with_deployment" });
  });

  it("reports skipped (not executed) when no command is configured, and fails when the deployment failed", async () => {
    const plain = adapter();
    await plain.deploy(request());
    expect(await plain.applyMigrations(request())).toMatchObject({ ok: true, metadata: { skipped: true } });
    mock.deployStatuses = ["error"];
    const withMigrations = adapter({ migrationCommand: "npm run db:migrate" });
    await withMigrations.deploy(request());
    expect(await withMigrations.applyMigrations(request())).toMatchObject({ ok: false, detail: "deployment_error" });
  });
});

describe("health check and minimal E2E", () => {
  it("passes on 2xx and fails on non-2xx", async () => {
    const stagingAdapter = adapter({ healthPath: "/health" });
    expect(await stagingAdapter.healthCheck(request())).toMatchObject({ ok: true, detail: "health_ok" });
    mock.publicResponses.set("/health", { status: 503, body: "down" });
    expect(await stagingAdapter.healthCheck(request())).toMatchObject({ ok: false, detail: "health_status_503" });
  });

  it("fails when the public URL is unreachable or too slow", async () => {
    const refused = adapter({ fetchImpl: () => Promise.reject(new Error("connect ECONNREFUSED")) });
    expect((await refused.healthCheck(request())).detail).toMatch(/^health_unreachable:/);
    const slow = adapter({ httpTimeoutMs: 30, fetchImpl: (input, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })))) });
    expect(await slow.healthCheck(request())).toMatchObject({ ok: false, detail: "health_unreachable:timeout" });
  });

  it("E2E = health + configured routes", async () => {
    const stagingAdapter = adapter({ healthPath: "/health", e2eRoutes: [{ path: "/login", bodyIncludes: "Sign in" }] });
    mock.publicResponses.set("/login", { status: 200, body: "<h1>Sign in</h1>" });
    expect(await stagingAdapter.runOnlineE2E(request())).toMatchObject({ ok: true, metadata: { checked: ["/health", "/login"] } });
    mock.publicResponses.set("/login", { status: 200, body: "error page" });
    expect(await stagingAdapter.runOnlineE2E(request())).toMatchObject({ ok: false, detail: "e2e_body_mismatch" });
    mock.publicResponses.set("/health", { status: 500, body: "" });
    expect(await stagingAdapter.runOnlineE2E(request())).toMatchObject({ ok: false, detail: "e2e_status_500" });
  });
});

describe("compose template", () => {
  it("keeps the database on an internal network, only the app joins dokploy-network", () => {
    const file = renderStagingCompose({
      appName: "jev-stg-x",
      appEnvKeys: ["DATABASE_URL"],
      app: { image: "ghcr.io/novo34/x:staging" },
      appPort: 3000,
      postgresImage: "postgres:16-alpine",
      limits: { appMemory: "512m", appCpus: "1.0", dbMemory: "512m", dbCpus: "0.5" }
    });
    const db = file.slice(file.indexOf("  db:"), file.indexOf("  app:"));
    expect(db).toContain("networks: [internal]");
    expect(db).not.toContain("dokploy-network");
    expect(file).toMatch(/internal:\n {4}internal: true/);
    expect(file).toContain("networks: [internal, dokploy-network]");
    expect(file).not.toMatch(/^\s+ports:/m);
  });
});
