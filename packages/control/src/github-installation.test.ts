import { generateKeyPairSync, randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import { hashPassword, login, type AuthenticatedUser } from "@jev/auth";
import { ControlService, GitHubAppClient, GitHubInstallationFlow } from "./index.js";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const applicationName = "jev-gh-install-" + randomUUID();
const pool = createDatabasePool({ application_name: applicationName });
const organizationId = randomUUID();
const foreignOrganizationId = randomUUID();
const projectId = randomUUID();
const foreignProjectId = randomUUID();
const repositoryId = randomUUID();
const foreignRepositoryId = randomUUID();
const userId = randomUUID();
const developerId = randomUUID();
let admin: AuthenticatedUser;
let developer: AuthenticatedUser;
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const configuration = { slug: "jev-test", clientId: "Iv1.example", clientSecret: "disposable-test-client-secret", callbackUrl: "https://jev.test/integrations/github/callback" };
let httpCalls: string[];
let repoAdmin = true;
let accessible = true;
let revokeSession = false;
let oauthDelay = 0;

function service(database = pool): ControlService {
  const app = new GitHubAppClient({ appId: "123", privateKey: key }, { fetch: async (url, init) => {
    httpCalls.push(String(url));
    if (String(url).endsWith("/access_tokens")) return Response.json({ token: "test-installation-token",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ id: 42 }],
      permissions: JSON.parse(String(init?.body)).permissions });
    if (String(url).includes("/app/installations/17")) return Response.json({ id: 17, account: { id: 77, login: "owner" }, suspended_at: null });
    return Response.json({ id: 42, full_name: "owner/repo", default_branch: "main" });
  } });
  const flow = new GitHubInstallationFlow(configuration, app, async (url) => {
    httpCalls.push(String(url));
    if (String(url).includes("oauth/access_token")) {
      if (oauthDelay) await new Promise((resolve) => setTimeout(resolve, oauthDelay));
      return Response.json({ access_token: "test-user-token", token_type: "bearer" });
    }
    if (String(url) === "https://api.github.com/user") return Response.json({ id: 88, login: "implementer" });
    if (String(url).includes("/user/installations/")) {
      if (revokeSession) await pool.query("DELETE FROM auth_sessions WHERE id=$1", [admin.sessionId]);
      return Response.json({ repositories: accessible ? [{ id: 42 }] : [] });
    }
    return Response.json({ id: 42, full_name: "owner/repo", permissions: { admin: repoAdmin } });
  });
  return new ControlService(database, flow);
}

async function start(control = service(), actor = admin, targetProjectId = projectId, targetRepositoryId = repositoryId) {
  const result = await control.execute<{ installUrl: string; cookieState: string }>({
    commandId: randomUUID(), action: "START_GITHUB_INSTALLATION", projectId: targetProjectId,
    payload: { repositoryId: targetRepositoryId }
  }, { actor, correlationId: "github-install-test" });
  return { control, state: result.data.cookieState, url: result.data.installUrl };
}

async function setup() {
  const value = await start();
  await value.control.completeGitHubInstallation({ state: value.state, cookieState: value.state, installationId: 17 }, "setup");
  return value;
}

beforeAll(async () => {
  await migrate(pool);
  await pool.query("INSERT INTO organizations(id,name) VALUES ($1,'GitHub Org'),($2,'Foreign GitHub Org')", [organizationId, foreignOrganizationId]);
  await pool.query(`INSERT INTO users(id,organization_id,email,display_name,role,password_hash)
    VALUES ($1,$2,'admin@github.test','Admin','ADMIN',$3),($4,$2,'dev@github.test','Dev','DEVELOPER',$3)`,
    [userId, organizationId, hashPassword("github-installation-test-password"), developerId]);
  await pool.query("INSERT INTO projects(id,organization_id,name) VALUES ($1,$2,'GitHub Project'),($3,$4,'Foreign GitHub Project')", [projectId, organizationId, foreignProjectId, foreignOrganizationId]);
  await pool.query("INSERT INTO repositories(id,project_id,full_name,role) VALUES ($1,$2,'owner/repo','other'),($3,$4,'foreign/repo','other')", [repositoryId, projectId, foreignRepositoryId, foreignProjectId]);
  await pool.query("INSERT INTO project_memberships(project_id,user_id,role) VALUES ($1,$2,'DEVELOPER')", [projectId, developerId]);
  developer = (await login(pool, { organizationId, email: "dev@github.test", password: "github-installation-test-password" })).user;
});

beforeEach(async () => {
  await pool.query("DELETE FROM github_installation_requests WHERE organization_id=$1", [organizationId]);
  await pool.query("DELETE FROM github_user_identities WHERE organization_id=$1", [organizationId]);
  await pool.query("DELETE FROM github_repository_installations WHERE repository_id=$1", [repositoryId]);
  await pool.query("DELETE FROM github_installations WHERE installation_id=17");
  await pool.query("UPDATE repositories SET external_repository_id=NULL WHERE id=$1", [repositoryId]);
  await pool.query("UPDATE users SET role='ADMIN',status='ACTIVE' WHERE id=$1", [userId]);
  admin = (await login(pool, { organizationId, email: "admin@github.test", password: "github-installation-test-password" })).user;
  httpCalls = []; repoAdmin = true; accessible = true; revokeSession = false; oauthDelay = 0;
});

afterAll(async () => {
  await pool.query("DELETE FROM github_installation_requests WHERE organization_id=$1", [organizationId]);
  await pool.query("DELETE FROM github_user_identities WHERE organization_id=$1", [organizationId]);
  await pool.query("DELETE FROM github_repository_installations WHERE repository_id=$1", [repositoryId]);
  await pool.query("DELETE FROM github_installations WHERE installation_id=17");
  await pool.query("DELETE FROM audit_events WHERE organization_id=$1", [organizationId]);
  await pool.query("DELETE FROM project_memberships WHERE user_id=$1", [developerId]);
  await pool.query("DELETE FROM auth_sessions WHERE user_id IN ($1,$2)", [userId, developerId]);
  await pool.query("DELETE FROM repositories WHERE id IN ($1,$2)", [repositoryId, foreignRepositoryId]);
  await pool.query("DELETE FROM projects WHERE id IN ($1,$2)", [projectId, foreignProjectId]);
  await pool.query("DELETE FROM users WHERE id IN ($1,$2)", [userId, developerId]);
  await pool.query("DELETE FROM organizations WHERE id IN ($1,$2)", [organizationId, foreignOrganizationId]);
  await pool.end();
});

describe("GitHub installation control boundary (real PostgreSQL, simulated GitHub)", () => {
  it("rejects unauthorized role, foreign tenant and repository before issuing state", async () => {
    await expect(start(service(), developer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(start(service(), admin, foreignProjectId, foreignRepositoryId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(start(service(), admin, projectId, foreignRepositoryId)).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(httpCalls).toEqual([]);
    expect((await pool.query("SELECT * FROM github_installation_requests WHERE organization_id=$1", [organizationId])).rowCount).toBe(0);
  });

  it("stores only a hash and binds state to the exact session and repository", async () => {
    const { state, url } = await start();
    expect(url).toBe(`https://github.com/apps/jev-test/installations/new?state=${state}`);
    const row = (await pool.query("SELECT * FROM github_installation_requests WHERE session_id=$1", [admin.sessionId])).rows[0];
    expect(row.state_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.state_hash).not.toBe(state);
    expect(row.repository_id).toBe(repositoryId);
    expect(row.user_id).toBe(userId);
  });

  it("rejects absent or manipulated cookie/state without calling GitHub", async () => {
    const { control, state } = await start();
    for (const cookieState of [undefined, "a".repeat(43)]) {
      await expect(control.completeGitHubInstallation({ state, cookieState, installationId: 17 }, "tamper")).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    }
    expect(httpCalls).toEqual([]);
  });

  it("rejects expired state and replay of the setup callback", async () => {
    const { control, state } = await setup();
    await expect(control.completeGitHubInstallation({ state, cookieState: state, installationId: 17 }, "replay-setup")).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    await pool.query("UPDATE github_installation_requests SET expires_at=NOW()-interval '1 second' WHERE session_id=$1", [admin.sessionId]);
    await expect(control.completeGitHubInstallation({ state, cookieState: state, code: "test-code" }, "expired")).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(httpCalls).toEqual([]);
  });

  it.each(["state", "session"])("rejects %s expiration while callback waits for its row lock", async (scenario) => {
    const { control, state } = await setup();
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT state_hash FROM github_installation_requests WHERE session_id=$1 FOR UPDATE", [admin.sessionId]);
      const pending = control.completeGitHubInstallation({ state, cookieState: state, code: "test-code" }, "expired-lock");
      const result = pending.then(() => "unexpected-success", (error: any) => error.code);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const active = await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%FROM github_installation_requests q%'", [applicationName]);
        if (active.rowCount) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      if (scenario === "state") await blocker.query("UPDATE github_installation_requests SET expires_at=clock_timestamp() WHERE session_id=$1", [admin.sessionId]);
      else await blocker.query("UPDATE auth_sessions SET expires_at=clock_timestamp() WHERE id=$1", [admin.sessionId]);
      await blocker.query("COMMIT");
      expect(await result).toBe("GITHUB_FORBIDDEN");
      expect(httpCalls).toEqual([]);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });

  it.each(["installation-expiry", "identity-expiry"])("revalidates %s after final transaction lock wait", async (scenario) => {
    let control: ControlService, state: string;
    if (scenario === "identity-expiry") {
      control = service();
      const result = await control.execute<{ cookieState: string }>({ commandId: randomUUID(),
        action: "CONNECT_GITHUB_IDENTITY", projectId, payload: { repositoryId } }, { actor: admin, correlationId: "identity-lock" });
      state = result.data.cookieState;
    } else ({ control, state } = await setup());
    if (scenario.endsWith("expiry")) await pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1", [admin.sessionId]);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      if (scenario === "identity-expiry") await blocker.query("SELECT id FROM auth_sessions WHERE id=$1 FOR UPDATE", [admin.sessionId]);
      else await blocker.query("SELECT id FROM repositories WHERE id=$1 FOR UPDATE", [repositoryId]);
      const result = control.completeGitHubInstallation({ state, cookieState: state, code: "test-code" }, "final-lock")
        .then(() => "unexpected-success", (error: any) => error.code);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const active = await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND (query LIKE '%SELECT r.id FROM repositories r JOIN projects%' OR query LIKE '%SELECT u.* FROM users u JOIN auth_sessions%')", [applicationName]);
        if (active.rowCount) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 2100));
      await blocker.query("COMMIT");
      expect(await result).toBe("GITHUB_FORBIDDEN");
      expect((await pool.query("SELECT 1 FROM github_user_identities WHERE organization_id=$1", [organizationId])).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM github_repository_installations WHERE repository_id=$1", [repositoryId])).rowCount).toBe(0);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });

  it.each([["INSTALLATION", "role"], ["IDENTITY", "role"], ["INSTALLATION", "delete"], ["IDENTITY", "membership"]] as const)(
    "holds %s authority through final bind against concurrent %s revocation", async (purpose, scenario) => {
      if (scenario === "membership") {
        await pool.query("UPDATE users SET role='DEVELOPER' WHERE id=$1", [userId]); admin.role = "DEVELOPER";
        await pool.query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,'DEVELOPER')", [projectId,userId]);
      }
      let revocation: Promise<string> | undefined;
      let intercepted = false;
      const query = scenario === "role" ? "UPDATE users SET role='AUDITOR' WHERE id=$1" :
        scenario === "delete" ? "DELETE FROM users WHERE id=$1" : "DELETE FROM project_memberships WHERE user_id=$1";
      const wrapped = { query: pool.query.bind(pool), connect: async () => {
        const client = await pool.connect();
        return { query: async (sql: string, values?: unknown[]) => {
          if (!intercepted && sql.includes("INSERT INTO github_user_identities")) {
            intercepted = true;
            revocation = pool.query(query, [userId]).then(() => "committed", (error: any) => error.code);
            let waiting = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query=$2", [applicationName,query]);
              if (result.rowCount) { waiting = true; break; }
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(waiting).toBe(true);
          }
          return client.query(sql, values);
        }, release: () => client.release() };
      } } as unknown as Pool;
      const control = service(wrapped);
      let state: string;
      if (purpose === "INSTALLATION") {
        ({ state } = await start(control));
        await control.completeGitHubInstallation({ state, cookieState: state, installationId: 17 }, "setup-lock");
      } else {
        const result = await control.execute<{ cookieState: string }>({ commandId: randomUUID(), action: "CONNECT_GITHUB_IDENTITY", projectId, payload: { repositoryId } }, { actor: admin, correlationId: "identity-lock" });
        state = result.data.cookieState;
      }
      try {
        await expect(control.completeGitHubInstallation({ state, cookieState: state, code: "test-code" }, "stable-bind")).resolves.toBeDefined();
      } finally { expect(await revocation).toBe(scenario === "delete" ? "23503" : "committed"); }
      expect(intercepted).toBe(true);
      expect((await pool.query("SELECT 1 FROM github_user_identities WHERE organization_id=$1", [organizationId])).rowCount).toBe(1);
    });

  it("rejects membership revoked before final identity authorization lock", async () => {
    let revoke = false;
    const wrapped = { query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect();
      return { query: async (sql: string, values?: unknown[]) => {
        if (revoke && sql.includes("SELECT jev_lock_project_scope")) {
          revoke = false;
          await pool.query("DELETE FROM project_memberships WHERE user_id=$1", [developerId]);
        }
        return client.query(sql, values);
      }, release: () => client.release() };
    } } as unknown as Pool;
    const control = service(wrapped);
    const result = await control.execute<{ cookieState: string }>({ commandId: randomUUID(), action: "CONNECT_GITHUB_IDENTITY", projectId, payload: { repositoryId } }, { actor: developer, correlationId: "revoke-before-lock" });
    const state = result.data.cookieState; revoke = true;
    try {
      await expect(control.completeGitHubInstallation({ state, cookieState: state, code: "test-code" }, "revoked-membership")).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
      expect((await pool.query("SELECT 1 FROM github_user_identities WHERE organization_id=$1", [organizationId])).rowCount).toBe(0);
    } finally { await pool.query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,'DEVELOPER')", [projectId,developerId]); }
  });

  it("does not bind an installation if the authorization deadline expires during OAuth", async () => {
    const { control, state } = await setup(); oauthDelay = 1100;
    await pool.query("UPDATE github_installation_requests SET expires_at=clock_timestamp()+interval '1 second' WHERE session_id=$1", [admin.sessionId]);
    await expect(control.completeGitHubInstallation({ state, cookieState: state, code: "test-code" }, "expired-network")).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(httpCalls.some((url) => url.includes("oauth/access_token"))).toBe(true);
    expect((await pool.query("SELECT * FROM github_repository_installations WHERE repository_id=$1", [repositoryId])).rowCount).toBe(0);
    expect((await pool.query("SELECT * FROM github_installations WHERE installation_id=17")).rowCount).toBe(0);
  });

  it("links only after OAuth repository admin and installation access proof; consumes callback once", async () => {
    const { control, state } = await setup();
    const result = await control.completeGitHubInstallation({ state, cookieState: state, code: "test-code" }, "complete");
    expect(result).toEqual({ installationId: 17, repositoryId });
    expect((await pool.query("SELECT organization_id FROM github_installations WHERE installation_id=17")).rows[0].organization_id).toBe(organizationId);
    expect((await pool.query("SELECT external_repository_id FROM repositories WHERE id=$1", [repositoryId])).rows[0].external_repository_id).toBe("42");
    const before = httpCalls.length;
    await expect(control.completeGitHubInstallation({ state, cookieState: state, code: "test-code" }, "replay")).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect(httpCalls).toHaveLength(before);
    const audit = JSON.stringify((await pool.query("SELECT evidence FROM audit_events WHERE project_id=$1", [projectId])).rows);
    for (const secret of [state, "test-code", "test-user-token", "test-installation-token", configuration.clientSecret]) expect(audit).not.toContain(secret);
  });

  it("rejects repository users who are not administrators", async () => {
    const { control, state } = await setup(); repoAdmin = false;
    await expect(control.completeGitHubInstallation({ state, cookieState: state, code: "test-code" }, "nonadmin")).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect((await pool.query("SELECT * FROM github_repository_installations WHERE repository_id=$1", [repositoryId])).rowCount).toBe(0);
  });

  it("rejects inaccessible repositories and concurrent session revocation", async () => {
    for (const scenario of ["inaccessible", "revoked"]) {
      const { control, state } = await setup();
      accessible = scenario !== "inaccessible"; revokeSession = scenario === "revoked";
      await expect(control.completeGitHubInstallation({ state, cookieState: state, code: "test-code" }, scenario)).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
      expect((await pool.query("SELECT * FROM github_repository_installations WHERE repository_id=$1", [repositoryId])).rowCount).toBe(0);
    }
  });

  it("prevents an installation already bound to another organization being taken over", async () => {
    await pool.query("INSERT INTO github_installations(installation_id,organization_id,account_id,verified_by) VALUES (17,$1,77,$2)", [foreignOrganizationId, userId]);
    const { control, state } = await setup();
    await expect(control.completeGitHubInstallation({ state, cookieState: state, code: "test-code" }, "cross-tenant")).rejects.toMatchObject({ code: "GITHUB_FORBIDDEN" });
    expect((await pool.query("SELECT organization_id FROM github_installations WHERE installation_id=17")).rows[0].organization_id).toBe(foreignOrganizationId);
    expect((await pool.query("SELECT external_repository_id FROM repositories WHERE id=$1", [repositoryId])).rows[0].external_repository_id).toBeNull();
  });

  it("fails closed for disabled and invalid installation configuration", async () => {
    const control = new ControlService(pool);
    await expect(start(control)).rejects.toMatchObject({ code: "GITHUB_INVALID_CONFIGURATION" });
    const app = new GitHubAppClient({ appId: "123", privateKey: key });
    expect(() => new GitHubInstallationFlow({ ...configuration, callbackUrl: "http://unsafe.test/integrations/github/callback" }, app)).toThrow("GITHUB_INVALID_CONFIGURATION");
  });

  it("allows a scoped developer to verify their own identity without installing or binding repositories", async () => {
    const control = service();
    const result = await control.execute<{ installUrl: string; cookieState: string }>({
      commandId: randomUUID(), action: "CONNECT_GITHUB_IDENTITY", projectId, payload: { repositoryId }
    }, { actor: developer, correlationId: "identity-connect" });
    const state = result.data.cookieState;
    expect(new URL(result.data.installUrl).pathname).toBe("/login/oauth/authorize");
    await expect(control.completeGitHubInstallation({ state, cookieState: state, code: "test-code" }, "identity-callback")).resolves.toEqual({ identityConnected: true });
    const bound = (await pool.query("SELECT github_user_id FROM github_user_identities WHERE organization_id=$1 AND user_id=$2", [organizationId, developerId])).rows[0];
    expect(bound.github_user_id).toBe("88");
    expect((await pool.query("SELECT * FROM github_repository_installations WHERE repository_id=$1", [repositoryId])).rowCount).toBe(0);
  });

  it("completes the callback under actual restricted provisioning ACL without UPDATE on users", async () => {
    const role = "jev_gh_" + randomUUID().replaceAll("-", "");
    const sql = await readFile(new URL("../../db/security/provision-runtime-role.sql", import.meta.url), "utf8");
    let restricted: Pool | undefined;
    try {
      await pool.query(sql.replaceAll("jev_runtime", role));
      restricted = new Pool({ connectionString: process.env.DATABASE_URL,
        onConnect: async (client) => { await client.query(`SET ROLE "${role}"`); } });
      const acl = await restricted.query("SELECT current_user AS role, has_table_privilege(current_user,'users','UPDATE') AS can_update_users");
      expect(acl.rows[0]).toEqual({ role, can_update_users: false });
      const control = service(restricted);
      const { state } = await start(control);
      await control.completeGitHubInstallation({ state, cookieState: state, installationId: 17 }, "restricted-setup");
      await expect(control.completeGitHubInstallation({ state, cookieState: state, code: "test-code" }, "restricted-complete")).resolves.toEqual({ repositoryId, installationId: 17 });
    } finally {
      await restricted?.end();
      await pool.query(`DROP OWNED BY "${role}"`);
      await pool.query(`DROP ROLE "${role}"`);
    }
  });
});
