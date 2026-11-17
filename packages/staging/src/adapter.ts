import type { DokployClient, FetchLike } from "./client.js";
import { REVISION_ENV, renderStagingCompose } from "./compose-template.js";
import { assertStagingEnv, randomPassword, StagingEnvError } from "./env.js";
import { DokployError, StagingOwnershipError } from "./errors.js";
import {
  composeCreateBody,
  composeUpdateBody,
  domainCreateBody,
  ENDPOINTS,
  parseCompose,
  parseComposeCreated,
  parseDomains,
  parseEnv,
  parseEnvironmentComposes,
  saveEnvironmentBody,
  type ComposeDetails,
  type ComposeListEntry
} from "./mapping.js";
import {
  requireRevision,
  slugFromStagingUrl,
  validateStagingRequest,
  type StagingDeploymentRequest,
  type StagingProviderAdapter,
  type StagingReferencePolicy,
  type StagingStepResult
} from "./policy.js";
import { sanitizeText } from "./sanitize.js";

export interface E2ERoute {
  path: string;
  /** Substring the body must contain (optional). */
  bodyIncludes?: string;
}

export interface DokployStagingConfig {
  client: DokployClient;
  /** Dokploy environment (inside a Dokploy project) that hosts the staging composes. */
  environmentId: string;
  serverId?: string;
  policy: StagingReferencePolicy;
  /** Values for the allowed `secretRefs` (ref name = env variable name). Never logged. */
  secretValues?: Readonly<Record<string, string>>;
  /** Non-secret variables (must pass the production guard too). */
  extraEnv?: Readonly<Record<string, string>>;
  /** Strings that identify production (hosts, DB names). Values containing them are rejected. */
  productionMarkers?: readonly string[];
  appPort?: number;
  /**
   * Prebuilt image; when absent the app is built from `https://github.com/<repo>.git#<revision>` (exact SHA,
   * never the branch). An image must be pinned by digest (`name@sha256:<64 hex>`) and the health route must
   * report the revision (otherwise the run is DEGRADED, hence BLOCKED): an image cannot prove its source.
   */
  appImage?: string;
  postgresImage?: string;
  /**
   * Project commands run by Dokploy at deploy time as one-shot Compose
   * services (`migrate`, `seed`) that must succeed before the app starts.
   * The adapter does not execute SQL itself.
   */
  migrationCommand?: string;
  seedCommand?: string;
  healthPath?: string;
  e2eRoutes?: readonly E2ERoute[];
  httpTimeoutMs?: number;
  pollIntervalMs?: number;
  deployTimeoutMs?: number;
  limits?: { appMemory: string; appCpus: string; dbMemory: string; dbCpus: string };
  /** HTTP used for the public URL checks (defaults to global fetch). */
  fetchImpl?: FetchLike;
  generatePassword?: () => string;
}

const DB_SECRET_KEYS = [
  "STAGING_DB_NAME",
  "STAGING_DB_OWNER",
  "STAGING_DB_OWNER_PASSWORD",
  "STAGING_DB_RUNTIME",
  "STAGING_DB_RUNTIME_PASSWORD",
  "DATABASE_OWNER_URL"
];
/** Reserved non-secret variable stored in the compose at creation: `<projectId>:<repositoryId>`. */
export const OWNER_ENV = "JEV_STAGING_OWNER";
const IMAGE_DIGEST = /@sha256:[0-9a-f]{64}$/;
const SECRET_REF = /^[A-Z_][A-Z0-9_]*$/;

export function stagingAppName(slug: string): string {
  return `jev-stg-${slug}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class DokployStagingAdapter implements StagingProviderAdapter {
  private readonly cfg: Required<Pick<DokployStagingConfig, "appPort" | "postgresImage" | "healthPath" | "httpTimeoutMs" | "pollIntervalMs" | "deployTimeoutMs">> & DokployStagingConfig;

  constructor(config: DokployStagingConfig) {
    this.cfg = {
      appPort: 3000,
      postgresImage: "postgres:16-alpine",
      healthPath: "/",
      httpTimeoutMs: 10_000,
      pollIntervalMs: 2_000,
      deployTimeoutMs: 600_000,
      ...config
    };
  }

  // --- Contract operations -------------------------------------------------

  /**
   * Idempotent: reuses the compose (which contains the project's own
   * PostgreSQL and volume), environment and domain when they exist, then
   * (re)deploys `stagingBranch`. Never deletes anything.
   */
  deploy(request: StagingDeploymentRequest): Promise<StagingStepResult> {
    return this.step(request, async (slug) => {
      const revision = requireRevision(request.revision);
      if (this.cfg.appImage && !IMAGE_DIGEST.test(this.cfg.appImage)) return { ok: false, detail: "app_image_digest_required" };
      const appName = stagingAppName(slug);
      // Ownership and host checks run before any write: a resource of another project is never touched.
      const existing = await this.findCompose(appName, request);
      await this.assertHostNotOwnedByOtherCompose(new URL(request.stagingUrl).hostname.toLowerCase(), existing?.composeId);
      const existingEnv = existing ? parseEnv(existing.env) : {};
      const env = this.buildEnv(request, slug, existingEnv, revision);
      const composeFile = renderStagingCompose({
        appName,
        appEnvKeys: Object.keys(env).filter((key) => !DB_SECRET_KEYS.includes(key) && key !== OWNER_ENV).sort(),
        app: this.cfg.appImage ? { image: this.cfg.appImage } : { buildContext: `https://github.com/${request.repository}.git#${revision}` },
        revision,
        appPort: this.cfg.appPort,
        postgresImage: this.cfg.postgresImage,
        migrationCommand: this.cfg.migrationCommand,
        seedCommand: this.cfg.seedCommand,
        limits: this.cfg.limits ?? { appMemory: "512m", appCpus: "1.0", dbMemory: "512m", dbCpus: "0.5" }
      });

      let composeId: string;
      const created = !existing;
      if (existing) {
        composeId = existing.composeId;
        if (existing.composeFile !== composeFile) await this.cfg.client.post(ENDPOINTS.composeUpdate, composeUpdateBody({ composeId, composeFile }));
      } else {
        const raw = await this.cfg.client.post(
          ENDPOINTS.composeCreate,
          composeCreateBody({ name: appName, appName, environmentId: this.cfg.environmentId, composeFile, serverId: this.cfg.serverId })
        );
        composeId = parseComposeCreated(raw).composeId;
      }

      if (created || !sameEnv(existingEnv, env)) await this.cfg.client.post(ENDPOINTS.composeSaveEnvironment, saveEnvironmentBody(composeId, env));

      const host = new URL(request.stagingUrl).hostname.toLowerCase();
      const domainCreated = await this.ensureDomain(composeId, host);

      const redeploy = !created && existing?.composeStatus !== "idle";
      await this.cfg.client.post(redeploy ? ENDPOINTS.composeRedeploy : ENDPOINTS.composeDeploy, { composeId });
      const final = await this.waitForDeployment(composeId);
      const metadata = { composeId, appName, host, created, domainCreated, redeployed: redeploy, branch: request.stagingBranch, revision, status: final.composeStatus };
      if (final.composeStatus === "error") return { ok: false, detail: "deployment_failed", metadata };
      if (final.composeStatus !== "done") return { ok: false, detail: "deployment_timeout", metadata };
      return { ok: true, detail: created ? "created_and_deployed" : "reused_and_redeployed", metadata };
    });
  }

  /**
   * Checks what Dokploy can prove: the project's own database service exists
   * on an internal network without published ports, its URL targets that
   * service and carries no production value, and the deployment is `done`.
   * A live SQL connection check is the project's health route (VERIFY-R4).
   */
  verifyDatabase(request: StagingDeploymentRequest): Promise<StagingStepResult> {
    return this.step(request, async (slug) => {
      const compose = await this.findCompose(stagingAppName(slug), request);
      if (!compose) return { ok: false, detail: "compose_missing" };
      const env = parseEnv(compose.env);
      const file = compose.composeFile;
      if (!/^ {2}db:/m.test(file) || !/^ {2}db-data:/m.test(file)) return { ok: false, detail: "database_service_missing" };
      if (/^\s+ports:/m.test(file)) return { ok: false, detail: "database_ports_published" };
      try {
        const url = env.DATABASE_URL ? new URL(env.DATABASE_URL) : null;
        if (!url || url.hostname !== "db") return { ok: false, detail: "database_url_not_staging" };
        assertStagingEnv(env, { stagingDbHost: "db", productionMarkers: this.cfg.productionMarkers });
      } catch (error) {
        if (error instanceof StagingEnvError) return { ok: false, detail: error.code };
        return { ok: false, detail: "database_url_invalid" };
      }
      if (compose.composeStatus !== "done") return { ok: false, detail: `deployment_${compose.composeStatus}` };
      return { ok: true, detail: "database_isolated", metadata: { composeId: compose.composeId } };
    });
  }

  /** Migrations run in the one-shot `migrate` service; a `done` deployment proves they succeeded. */
  applyMigrations(request: StagingDeploymentRequest): Promise<StagingStepResult> {
    return this.oneShotStep(request, "migrate", this.cfg.migrationCommand);
  }

  /** Seeds run in the one-shot `seed` service (synthetic data only, project-defined command). */
  seedTestData(request: StagingDeploymentRequest): Promise<StagingStepResult> {
    return this.oneShotStep(request, "seed", this.cfg.seedCommand);
  }

  async healthCheck(request: StagingDeploymentRequest): Promise<StagingStepResult> {
    validateStagingRequest(request, this.cfg.policy);
    return this.probe(request.stagingUrl, { path: this.cfg.healthPath }, "health", request.revision);
  }

  /**
   * Minimal E2E: health plus the configured routes, all must answer 2xx. Per-route evidence is kept and a
   * degraded route (`metadata.degraded`) degrades the whole result, so the orchestrator never reports READY.
   */
  async runOnlineE2E(request: StagingDeploymentRequest): Promise<StagingStepResult> {
    validateStagingRequest(request, this.cfg.policy);
    const routes: E2ERoute[] = [{ path: this.cfg.healthPath }, ...(this.cfg.e2eRoutes ?? [])];
    const checked: string[] = [];
    const evidence: Array<Record<string, unknown>> = [];
    let degraded = false;
    for (const [index, route] of routes.entries()) {
      const result = await this.probe(request.stagingUrl, route, "e2e", index === 0 ? request.revision : undefined);
      if (!result.ok) return { ...result, metadata: { ...result.metadata, checked, routes: evidence } };
      checked.push(route.path);
      const routeDegraded = result.metadata?.degraded === true;
      degraded = degraded || routeDegraded;
      evidence.push({ path: route.path, status: result.metadata?.status, ...(result.metadata?.revisionCheck ? { revisionCheck: result.metadata.revisionCheck } : {}), degraded: routeDegraded });
    }
    return degraded
      ? { ok: true, detail: "e2e_degraded", metadata: { checked, routes: evidence, degraded: true } }
      : { ok: true, detail: "e2e_passed", metadata: { checked, routes: evidence } };
  }

  // --- Internals ------------------------------------------------------------

  private async step(request: StagingDeploymentRequest, run: (slug: string) => Promise<StagingStepResult>): Promise<StagingStepResult> {
    validateStagingRequest(request, this.cfg.policy);
    const slug = slugFromStagingUrl(request.stagingUrl, this.cfg.policy.stagingBaseDomain);
    try {
      return await run(slug);
    } catch (error) {
      if (error instanceof DokployError) return { ok: false, detail: `dokploy_${error.code}`, metadata: { code: error.code, status: error.status } };
      if (error instanceof StagingEnvError) return { ok: false, detail: error.code };
      if (error instanceof StagingOwnershipError) return { ok: false, detail: error.code };
      throw error;
    }
  }

  private async oneShotStep(request: StagingDeploymentRequest, service: "migrate" | "seed", command?: string): Promise<StagingStepResult> {
    return this.step(request, async (slug) => {
      if (!command) return { ok: true, detail: `no_${service}_command_configured`, metadata: { skipped: true } };
      const compose = await this.findCompose(stagingAppName(slug), request);
      if (!compose) return { ok: false, detail: "compose_missing" };
      if (!new RegExp(`^ {2}${service}:`, "m").test(compose.composeFile)) return { ok: false, detail: `${service}_service_missing` };
      if (compose.composeStatus !== "done") return { ok: false, detail: `deployment_${compose.composeStatus}` };
      return { ok: true, detail: `${service}_completed_with_deployment`, metadata: { skipped: false } };
    });
  }

  /**
   * GET one route; 2xx required. With `expectedRevision` (health route) the body is also read: a JSON
   * `revision` (or `JEV_STAGING_REVISION`) field or the `x-jev-staging-revision` header is compared with the
   * deployed revision. A different value fails the step (definitive: the running code is not the recorded one).
   * If the route reports nothing the revision is "unverifiable" (VERIFY-R4): recorded in the evidence without
   * blocking, except with a prebuilt `appImage`, where it is DEGRADED (a digest cannot prove the source commit).
   */
  private async probe(baseUrl: string, route: E2ERoute, kind: "health" | "e2e", expectedRevision?: string): Promise<StagingStepResult> {
    const url = new URL(route.path, baseUrl).toString();
    const fetcher: FetchLike = this.cfg.fetchImpl ?? ((input, init) => fetch(input, init));
    try {
      const response = await fetcher(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(this.cfg.httpTimeoutMs) });
      const body = route.bodyIncludes || expectedRevision ? await response.text() : "";
      if (response.status < 200 || response.status > 299) return { ok: false, detail: `${kind}_status_${response.status}`, metadata: { path: route.path, status: response.status } };
      if (route.bodyIncludes && !body.includes(route.bodyIncludes)) return { ok: false, detail: `${kind}_body_mismatch`, metadata: { path: route.path } };
      const metadata: Record<string, unknown> = { path: route.path, status: response.status };
      if (expectedRevision) {
        const reported = reportedRevision(body, response.headers?.get?.("x-jev-staging-revision") ?? null);
        if (reported === null) {
          metadata.revisionCheck = "unverifiable";
          if (this.cfg.appImage) return { ok: true, detail: `${kind}_ok`, metadata: { ...metadata, degraded: true } };
        } else if (reported !== expectedRevision.toLowerCase()) {
          return { ok: false, detail: `${kind}_revision_mismatch`, metadata: { ...metadata, revisionCheck: "mismatch", expected: expectedRevision, reported: /^[0-9a-f]{40}$/.test(reported) ? reported : "invalid" } };
        } else metadata.revisionCheck = "verified";
      }
      return { ok: true, detail: `${kind}_ok`, metadata };
    } catch (error) {
      const name = (error as { name?: string }).name;
      const reason = name === "TimeoutError" || name === "AbortError" ? "timeout" : sanitizeText(String((error as Error).message)).slice(0, 120);
      return { ok: false, detail: `${kind}_unreachable:${reason}`, metadata: { path: route.path } };
    }
  }

  /**
   * Finds the compose for `appName` and proves it belongs to the request's project/repository. A compose owned by
   * another project (or without the owner marker) is rejected with `StagingOwnershipError` before any write. The only
   * exception is a compose with a completely empty environment: a creation of this adapter interrupted before the
   * owner was saved (a foreign compose always carries its own marker and database values).
   */
  private async findCompose(appName: string, request: StagingDeploymentRequest): Promise<ComposeDetails | null> {
    // environment.one does not expose appName: candidates are located by name (the adapter creates with name = appName)
    // and confirmed with compose.one (real appName) before anything is adopted or used.
    let compose: ComposeDetails | null = null;
    for (const entry of (await this.listComposes()).filter((candidate) => candidate.name === appName)) {
      const details = parseCompose(await this.cfg.client.get(ENDPOINTS.composeOne, { composeId: entry.composeId }));
      if (details.appName === appName) {
        compose = details;
        break;
      }
    }
    if (!compose) return null;
    const owner = parseEnv(compose.env)[OWNER_ENV];
    if (owner === undefined ? compose.env.trim() !== "" : owner !== ownerOf(request)) throw new StagingOwnershipError();
    return compose;
  }

  private async listComposes(): Promise<ComposeListEntry[]> {
    return parseEnvironmentComposes(await this.cfg.client.get(ENDPOINTS.environmentOne, { environmentId: this.cfg.environmentId }));
  }

  /** Rejects when another compose of the environment already serves the host (read-only, before any write). */
  private async assertHostNotOwnedByOtherCompose(host: string, ownComposeId: string | undefined): Promise<void> {
    for (const other of await this.listComposes()) {
      if (other.composeId === ownComposeId) continue;
      const domains = parseDomains(await this.cfg.client.get(ENDPOINTS.domainByComposeId, { composeId: other.composeId }));
      if (domains.some((domain) => domain.host.toLowerCase() === host)) throw new StagingOwnershipError();
    }
  }

  private async ensureDomain(composeId: string, host: string): Promise<boolean> {
    const domains = parseDomains(await this.cfg.client.get(ENDPOINTS.domainByComposeId, { composeId }));
    const existing = domains.find((domain) => domain.host.toLowerCase() === host);
    if (existing) {
      if (!existing.https || existing.certificateType !== "letsencrypt" || existing.serviceName !== "app" || existing.port !== this.cfg.appPort) {
        throw new DokployError("conflict", `dokploy_domain_mismatch:${host}`);
      }
      return false;
    }
    await this.cfg.client.post(ENDPOINTS.domainCreate, domainCreateBody({ composeId, host, serviceName: "app", port: this.cfg.appPort }));
    return true;
  }

  private async waitForDeployment(composeId: string): Promise<ComposeDetails> {
    const deadline = Date.now() + this.cfg.deployTimeoutMs;
    for (;;) {
      const details = parseCompose(await this.cfg.client.get(ENDPOINTS.composeOne, { composeId }));
      if (details.composeStatus === "done" || details.composeStatus === "error") return details;
      if (Date.now() >= deadline) return details;
      await sleep(this.cfg.pollIntervalMs);
    }
  }

  /** Builds the full env. DB passwords already stored in Dokploy are kept so a re-run never rotates them. */
  private buildEnv(request: StagingDeploymentRequest, slug: string, existing: Record<string, string>, revision: string): Record<string, string> {
    const generate = this.cfg.generatePassword ?? randomPassword;
    const dbName = request.databaseRef.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();
    const owner = `${dbName}_owner`.slice(0, 60);
    const runtime = `${dbName}_runtime`.slice(0, 60);
    const ownerPassword = existing.STAGING_DB_OWNER_PASSWORD || generate();
    const runtimePassword = existing.STAGING_DB_RUNTIME_PASSWORD || generate();
    const url = (user: string, password: string): string => `postgresql://${user}:${encodeURIComponent(password)}@db:5432/${dbName}`;

    const env: Record<string, string> = {
      STAGING_ENVIRONMENT: "staging",
      STAGING_PROJECT_SLUG: slug,
      STAGING_BRANCH: request.stagingBranch,
      STAGING_PUBLIC_URL: request.stagingUrl,
      [REVISION_ENV]: revision,
      [OWNER_ENV]: ownerOf(request),
      ...(this.cfg.seedCommand ? { STAGING_SEED_SYNTHETIC_ONLY: "1" } : {}),
      ...this.cfg.extraEnv
    };
    for (const ref of request.secretRefs) {
      if (!SECRET_REF.test(ref)) throw new StagingEnvError(`secret_ref_not_env_name:${ref}`);
      const value = this.cfg.secretValues?.[ref];
      if (value === undefined) throw new StagingEnvError(`secret_value_missing:${ref}`);
      env[ref] = value;
    }
    // The revision and the owner come only from the verified request; neither extraEnv nor a secret ref may override them.
    for (const reserved of [REVISION_ENV, OWNER_ENV]) {
      if ((this.cfg.extraEnv && reserved in this.cfg.extraEnv) || request.secretRefs.includes(reserved)) throw new StagingEnvError(`env_reserved_name_rejected:${reserved}`);
    }
    // Guard the caller-controlled part before adding the generated database values.
    assertStagingEnv(env, { stagingDbHost: "db", productionMarkers: this.cfg.productionMarkers });
    for (const key of DB_SECRET_KEYS) if (key in env) throw new StagingEnvError(`env_reserved_name_rejected:${key}`);
    if ("DATABASE_URL" in env) throw new StagingEnvError("env_reserved_name_rejected:DATABASE_URL");
    Object.assign(env, {
      STAGING_DB_NAME: dbName,
      STAGING_DB_OWNER: owner,
      STAGING_DB_OWNER_PASSWORD: ownerPassword,
      STAGING_DB_RUNTIME: runtime,
      STAGING_DB_RUNTIME_PASSWORD: runtimePassword,
      DATABASE_URL: url(runtime, runtimePassword),
      DATABASE_OWNER_URL: url(owner, ownerPassword)
    });
    return env;
  }
}

function ownerOf(request: StagingDeploymentRequest): string {
  return `${request.projectId}:${request.repositoryId}`;
}

function sameEnv(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((key) => a[key] === b[key]);
}

/** Revision reported by the app: header first, then a JSON body field. `null` when it reports none. */
function reportedRevision(body: string, header: string | null): string | null {
  if (header && header.trim()) return header.trim().toLowerCase();
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const value = record.revision ?? record[REVISION_ENV];
      if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
    }
  } catch { /* not JSON: nothing reported */ }
  return null;
}
