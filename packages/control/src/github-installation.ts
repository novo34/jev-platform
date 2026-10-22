import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { AuthenticatedUser } from "@jev/auth";
import { authorizeProject } from "@jev/auth";
import { GitHubAppClient, GitHubError, assertGitHubRepositoryName } from "./github-app.js";
import { recordAudit } from "./audit.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const configSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  clientId: z.string().min(1).max(128),
  clientSecret: z.string().min(16).max(512),
  callbackUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.search && !url.hash &&
      ["/integrations/github/callback", "/api/integrations/github/callback"].includes(url.pathname);
  })
});
export type GitHubInstallationConfiguration = z.infer<typeof configSchema>;
type Pending = {
  organization_id: string; project_id: string; repository_id: string;
  user_id: string; session_id: string; installation_id: string | null;
  purpose: "INSTALLATION" | "IDENTITY";
  expires_at: Date;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Installation policy invoked exclusively through the existing ControlService. */
export class GitHubInstallationFlow {
  private readonly configuration: GitHubInstallationConfiguration;
  private readonly app: GitHubAppClient;
  private readonly fetcher: typeof fetch;

  constructor(configuration: GitHubInstallationConfiguration, app: GitHubAppClient, fetcher = fetch) {
    const parsed = configSchema.safeParse(configuration);
    if (!parsed.success) throw new GitHubError("GITHUB_INVALID_CONFIGURATION");
    this.configuration = parsed.data;
    this.app = app;
    this.fetcher = fetcher;
  }

  async start(client: PoolClient, actor: AuthenticatedUser, projectId: string, repositoryId: unknown, purpose: "INSTALLATION" | "IDENTITY" = "INSTALLATION"): Promise<{
    installUrl: string; cookieState: string;
  }> {
    const parsed = z.uuid().safeParse(repositoryId);
    if (!parsed.success) throw new GitHubError("GITHUB_INVALID_REQUEST");
    if (purpose === "INSTALLATION" && actor.role !== "ADMIN") throw new GitHubError("GITHUB_FORBIDDEN");
    const repo = await client.query(
      `SELECT r.id FROM repositories r JOIN projects p ON p.id=r.project_id
        WHERE r.id=$1 AND r.project_id=$2 AND p.organization_id=$3`,
      [parsed.data, projectId, actor.organizationId]
    );
    if (repo.rowCount !== 1) throw new GitHubError("GITHUB_FORBIDDEN");
    const state = randomBytes(32).toString("base64url");
    // Bound outstanding state per session and remove expired state at issuance.
    await client.query("DELETE FROM github_installation_requests WHERE organization_id=$2 AND (expires_at<=NOW() OR session_id=$1)", [actor.sessionId, actor.organizationId]);
    await client.query(
      `INSERT INTO github_installation_requests
        (state_hash,organization_id,project_id,repository_id,user_id,session_id,expires_at,purpose)
        VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 minutes',$7)`,
      [hash(state), actor.organizationId, projectId, parsed.data, actor.id, actor.sessionId, purpose]
    );
    const url = new URL(`https://github.com/apps/${this.configuration.slug}/installations/new`);
    url.searchParams.set("state", state);
    return { installUrl: purpose === "IDENTITY" ? this.authorizeUrl(state) : url.toString(), cookieState: state };
  }

  private authorizeUrl(state: string): string {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.configuration.clientId);
    url.searchParams.set("redirect_uri", this.configuration.callbackUrl);
    url.searchParams.set("state", state);
    return url.toString();
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    try {
      const response = await this.fetcher(url, {
        ...init, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Accept: "application/json", "User-Agent": "JEV-GitHub-App", ...init.headers }
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      throw new GitHubError("GITHUB_UNAVAILABLE");
    }
  }

  private async audit(pool: Pool | PoolClient, pending: Pending, result: "SUCCESS" | "BLOCKED" | "FAILED", correlationId: string, code?: string, action = "GITHUB_COMPLETE_INSTALLATION"): Promise<void> {
    await recordAudit(pool, {
      actor: { id: pending.user_id, organizationId: pending.organization_id }, correlationId
    }, {
      commandId: correlationId, projectId: pending.project_id,
      targetId: pending.repository_id, action
    }, result, code ? { code } : undefined);
  }

  async callback(pool: Pool, input: {
    state?: string; cookieState?: string; installationId?: number; code?: string;
  }, correlationId: string): Promise<{ authorizeUrl: string } | { repositoryId: string; installationId: number } | { identityConnected: true }> {
    const state = stateSchema.safeParse(input.state);
    const cookie = stateSchema.safeParse(input.cookieState);
    if (!state.success || !cookie.success ||
        !timingSafeEqual(Buffer.from(state.data), Buffer.from(cookie.data))) {
      throw new GitHubError("GITHUB_FORBIDDEN");
    }
    const key = hash(state.data);
    const client = await pool.connect();
    let pending: Pending | undefined;
    try {
      await client.query("BEGIN");
      const result = await client.query<Pending>(
        `SELECT q.* FROM github_installation_requests q
          JOIN auth_sessions s ON s.id=q.session_id AND s.user_id=q.user_id
          JOIN users u ON u.id=q.user_id AND u.organization_id=q.organization_id
          JOIN projects p ON p.id=q.project_id AND p.organization_id=q.organization_id
          WHERE q.state_hash=$1 AND q.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp()
            AND u.status='ACTIVE' AND (q.purpose='IDENTITY' OR u.role='ADMIN')
          FOR UPDATE OF q`, [key]
      );
      pending = result.rows[0];
      if (!pending) throw new GitHubError("GITHUB_FORBIDDEN");
      // A row lock can outlive the statement's original snapshot. Recheck after acquiring it.
      await this.assertPendingActor(client, pending);
      if (input.code === undefined) {
        const installationId = id.safeParse(input.installationId);
        if (!installationId.success || pending.installation_id !== null || pending.purpose !== "INSTALLATION") throw new GitHubError("GITHUB_FORBIDDEN");
        const updated = await client.query("UPDATE github_installation_requests SET installation_id=$2 WHERE state_hash=$1 AND expires_at>clock_timestamp() RETURNING state_hash", [key, installationId.data]);
        if (updated.rowCount !== 1) throw new GitHubError("GITHUB_FORBIDDEN");
        await this.audit(client, pending, "SUCCESS", correlationId, undefined, "GITHUB_INSTALLATION_CALLBACK_ACCEPTED");
        await client.query("COMMIT");
        return { authorizeUrl: this.authorizeUrl(state.data) };
      }
      if (!z.string().min(1).max(256).safeParse(input.code).success ||
          (pending.purpose === "INSTALLATION" && !pending.installation_id)) {
        throw new GitHubError("GITHUB_FORBIDDEN");
      }
      // Consume once before OAuth exchange; ambiguous failures require a new install attempt.
      const consumed = await client.query("DELETE FROM github_installation_requests WHERE state_hash=$1 AND expires_at>clock_timestamp() RETURNING state_hash", [key]);
      if (consumed.rowCount !== 1) throw new GitHubError("GITHUB_FORBIDDEN");
      await this.audit(client, pending, "SUCCESS", correlationId, undefined, "GITHUB_INSTALLATION_STATE_CONSUMED");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (pending) await this.audit(client, pending, "BLOCKED", correlationId, "GITHUB_FORBIDDEN");
      throw error;
    } finally {
      client.release();
    }

    try {
      const token = z.object({ access_token: z.string().min(1), token_type: z.literal("bearer") }).safeParse(
        await this.request("https://github.com/login/oauth/access_token", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: this.configuration.clientId,
            client_secret: this.configuration.clientSecret, code: input.code,
            redirect_uri: this.configuration.callbackUrl })
        })
      );
      if (!token.success) throw new GitHubError("GITHUB_FORBIDDEN");
      const headers = { Authorization: `Bearer ${token.data.access_token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
      const identity = z.object({ id, login: z.string().regex(/^[A-Za-z0-9-]+$/) }).safeParse(
        await this.request("https://api.github.com/user", { headers }));
      if (!identity.success) throw new GitHubError("GITHUB_FORBIDDEN");
      if (pending.purpose === "IDENTITY") {
        const db = await pool.connect();
        try {
          await db.query("BEGIN");
          const active = await db.query(
            `SELECT u.* FROM users u JOIN auth_sessions s ON s.user_id=u.id
              WHERE u.id=$1 AND u.organization_id=$2 AND u.status='ACTIVE' AND s.id=$3 AND s.expires_at>clock_timestamp() FOR SHARE OF s`,
            [pending.user_id, pending.organization_id, pending.session_id]);
          if (active.rowCount !== 1) throw new GitHubError("GITHUB_FORBIDDEN");
          await this.assertPendingActor(db, pending);
          await this.bindIdentity(db, pending, identity.data);
          await this.audit(db, pending, "SUCCESS", correlationId, undefined, "GITHUB_IDENTITY_CONNECTED");
          await this.assertPendingActor(db, pending);
          await db.query("COMMIT");
        } catch (error) { await db.query("ROLLBACK"); throw error; }
        finally { db.release(); }
        return { identityConnected: true };
      }
      const repo = await pool.query<{ full_name: string; external_repository_id: string | null }>(
        `SELECT r.full_name,r.external_repository_id FROM repositories r JOIN projects p ON p.id=r.project_id
          WHERE r.id=$1 AND r.project_id=$2 AND p.organization_id=$3`,
        [pending.repository_id, pending.project_id, pending.organization_id]
      );
      if (repo.rowCount !== 1) throw new GitHubError("GITHUB_FORBIDDEN");
      const fullName = repo.rows[0].full_name;
      assertGitHubRepositoryName(fullName);
      const repository = z.object({ id, full_name: z.string(), permissions: z.object({ admin: z.literal(true) }) }).safeParse(
        await this.request(`https://api.github.com/repos/${fullName}`, { headers })
      );
      if (!repository.success || repository.data.full_name.toLowerCase() !== fullName.toLowerCase()) {
        throw new GitHubError("GITHUB_FORBIDDEN");
      }
      const installationId = Number(pending.installation_id);
      const installation = await this.app.installation(installationId);
      const parsedInstallation = z.object({ id, account: z.object({ id }), suspended_at: z.null() }).safeParse(installation);
      if (!parsedInstallation.success || parsedInstallation.data.id !== installationId) throw new GitHubError("GITHUB_FORBIDDEN");
      let accessible = false;
      for (let page = 1; page <= 10; page++) {
        const batch = z.object({ repositories: z.array(z.object({ id })) }).safeParse(
          await this.request(`https://api.github.com/user/installations/${installationId}/repositories?per_page=100&page=${page}`, { headers })
        );
        if (!batch.success) throw new GitHubError("GITHUB_FORBIDDEN");
        if (batch.data.repositories.some((item) => item.id === repository.data.id)) { accessible = true; break; }
        if (batch.data.repositories.length < 100) break;
      }
      if (!accessible) throw new GitHubError("GITHUB_FORBIDDEN");
      await this.app.repository({ installationId, repositoryId: repository.data.id, fullName });
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        // Revalidate the original human session and canonical tenant scope after network work.
        const active = await db.query(
          `SELECT r.id FROM repositories r JOIN projects p ON p.id=r.project_id
            JOIN users u ON u.id=$4 AND u.organization_id=p.organization_id
            JOIN auth_sessions s ON s.id=$5 AND s.user_id=u.id
            WHERE r.id=$1 AND p.id=$2 AND p.organization_id=$3 AND u.role='ADMIN'
              AND u.status='ACTIVE' AND s.expires_at>clock_timestamp() AND r.full_name=$6
              AND (r.external_repository_id IS NULL OR r.external_repository_id=$7)
            FOR UPDATE OF r FOR SHARE OF p,s`,
          [pending.repository_id, pending.project_id, pending.organization_id, pending.user_id,
            pending.session_id, fullName, String(repository.data.id)]
        );
        if (active.rowCount !== 1) throw new GitHubError("GITHUB_FORBIDDEN");
        await this.assertPendingActor(db, pending);
        const linked = await db.query(
          `INSERT INTO github_installations (installation_id,organization_id,account_id,verified_by)
            VALUES ($1,$2,$3,$4) ON CONFLICT (installation_id) DO UPDATE SET verified_at=NOW()
            WHERE github_installations.organization_id=EXCLUDED.organization_id
              AND github_installations.account_id=EXCLUDED.account_id RETURNING installation_id`,
          [installationId, pending.organization_id, parsedInstallation.data.account.id, pending.user_id]
        );
        if (linked.rowCount !== 1) throw new GitHubError("GITHUB_FORBIDDEN");
        await db.query("UPDATE repositories SET external_repository_id=$2 WHERE id=$1", [pending.repository_id, String(repository.data.id)]);
        await this.bindIdentity(db, pending, identity.data);
        await db.query(
          `INSERT INTO github_repository_installations (repository_id,installation_id) VALUES ($1,$2)
            ON CONFLICT (repository_id) DO UPDATE SET installation_id=EXCLUDED.installation_id`,
          [pending.repository_id, installationId]
        );
        await this.audit(db, pending, "SUCCESS", correlationId);
        await this.assertPendingActor(db, pending);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK"); throw error;
      } finally { db.release(); }
      return { repositoryId: pending.repository_id, installationId };
    } catch (error) {
      await this.audit(pool, pending, "FAILED", correlationId,
        error instanceof GitHubError ? error.code : "GITHUB_UNAVAILABLE");
      throw error instanceof GitHubError ? error : new GitHubError("GITHUB_UNAVAILABLE");
    }
  }

  // Fresh statement after blocking locks and again before commit: row-lock predicates
  // may have been evaluated against an older snapshot before the lock was granted.
  private async assertPendingActor(db: PoolClient, pending: Pending): Promise<void> {
    const current = await db.query(
      `SELECT u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id=$1 AND s.user_id=$2 AND u.organization_id=$3 AND s.expires_at>clock_timestamp()
          AND clock_timestamp()<$5::timestamptz AND u.status='ACTIVE' AND ($4='IDENTITY' OR u.role='ADMIN')`,
      [pending.session_id, pending.user_id, pending.organization_id, pending.purpose, pending.expires_at]);
    const actor = current.rows[0];
    if (!actor) throw new GitHubError("GITHUB_FORBIDDEN");
    await authorizeProject(db, { id: actor.id, organizationId: actor.organization_id,
      role: actor.role, sessionId: pending.session_id, email: actor.email, displayName: actor.display_name },
      pending.project_id, "project:write");
  }

  private async bindIdentity(db: PoolClient, pending: Pending, identity: { id: number; login: string }): Promise<void> {
    const bound = await db.query(
      `INSERT INTO github_user_identities(organization_id,user_id,github_user_id,github_login)
        SELECT $1,$2,$3,$4 WHERE clock_timestamp()<$5::timestamptz
        ON CONFLICT (organization_id,user_id) DO UPDATE SET github_login=EXCLUDED.github_login,verified_at=NOW()
        WHERE github_user_identities.github_user_id=EXCLUDED.github_user_id RETURNING user_id`,
      [pending.organization_id, pending.user_id, identity.id, identity.login, pending.expires_at]);
    if (bound.rowCount !== 1) throw new GitHubError("GITHUB_FORBIDDEN");
  }
}
