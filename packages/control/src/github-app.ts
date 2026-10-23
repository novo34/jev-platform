import { createPrivateKey, sign, type KeyObject } from "node:crypto";

export type GitHubFailureCode =
  | "GITHUB_INVALID_CONFIGURATION"
  | "GITHUB_INVALID_REQUEST"
  | "GITHUB_FORBIDDEN"
  | "GITHUB_UNAVAILABLE"
  | "GITHUB_RATE_LIMITED"
  | "GITHUB_CONFLICT";

export class GitHubError extends Error {
  readonly code: GitHubFailureCode;
  readonly retryAfterSeconds?: number;

  constructor(code: GitHubFailureCode, retryAfterSeconds?: number) {
    // Upstream bodies, URLs and credentials must never enter error messages.
    super(code);
    this.name = "GitHubError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface GitHubAppConfiguration {
  appId: string;
  privateKey: string;
}

export interface GitHubRepositoryScope {
  installationId: number;
  repositoryId: number;
  fullName: string;
}

type Fetch = typeof globalThis.fetch;
type GitHubPermissions = Partial<Record<"contents" | "pull_requests" | "checks" | "actions", "read" | "write">> & { administration?: "read" };

function positiveId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new GitHubError("GITHUB_INVALID_REQUEST");
  }
}

export function assertGitHubRepositoryName(fullName: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(fullName) ||
      [".", ".."].includes(fullName.split("/")[1])) {
    throw new GitHubError("GITHUB_INVALID_REQUEST");
  }
}

function repositoryPath(scope: GitHubRepositoryScope): string {
  positiveId(scope.installationId);
  positiveId(scope.repositoryId);
  assertGitHubRepositoryName(scope.fullName);
  return `/repos/${scope.fullName}`;
}

export function assertTaskBranch(branch: string): void {
  // Canonicalize nothing: refs/heads/main and other ref aliases must fail closed.
  if (
    typeof branch !== "string" || branch.length > 200 ||
    !/^(feat|fix|chore)\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) ||
    branch.includes("..") || branch.includes("//") || branch.includes("@{") ||
    branch.endsWith("/") || branch.split("/").some((part) =>
      part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
  ) {
    throw new GitHubError("GITHUB_FORBIDDEN");
  }
}

function assertSha(sha: string): void {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new GitHubError("GITHUB_INVALID_REQUEST");
}

/** Transport only. The ControlService owns actor, tenant, task and merge policy. */
export class GitHubAppClient {
  private readonly key: KeyObject;
  private readonly appId: string;
  private readonly fetcher: Fetch;
  private readonly now: () => number;

  constructor(
    configuration: GitHubAppConfiguration,
    options: { fetch?: Fetch; now?: () => number } = {}
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.appId = configuration.appId;
    try {
      if (!/^[1-9][0-9]*$/.test(this.appId)) throw new Error();
      this.key = createPrivateKey(configuration.privateKey);
      if (this.key.asymmetricKeyType !== "rsa" ||
          (this.key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error();
    } catch {
      throw new GitHubError("GITHUB_INVALID_CONFIGURATION");
    }
  }

  private jwt(): string {
    const now = Math.floor(this.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId })).toString("base64url");
    const unsigned = `${header}.${payload}`;
    return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), this.key).toString("base64url")}`;
  }

  private async request<T>(path: string, token: string, method = "GET", body?: unknown, beforeSend?: () => Promise<void>): Promise<T> {
    if (beforeSend) await beforeSend();
    let response: Response;
    try {
      response = await this.fetcher(`https://api.github.com${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${token}`,
          "User-Agent": "JEV-GitHub-App",
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch {
      // Mutations are never retried automatically: timeout may follow a committed write.
      throw new GitHubError("GITHUB_UNAVAILABLE");
    }
    if (!response.ok) {
      if (response.status === 429 ||
          (response.status === 403 && (response.headers.has("retry-after") ||
            response.headers.get("x-ratelimit-remaining") === "0"))) {
        const seconds = Number(response.headers.get("retry-after"));
        throw new GitHubError("GITHUB_RATE_LIMITED",
          Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 3600) : undefined);
      }
      if ([401, 403, 404].includes(response.status)) throw new GitHubError("GITHUB_FORBIDDEN");
      if ([409, 422].includes(response.status)) throw new GitHubError("GITHUB_CONFLICT");
      throw new GitHubError("GITHUB_UNAVAILABLE");
    }
    try {
      const result: unknown = await response.json();
      if (result === null || typeof result !== "object") throw new Error();
      return result as T;
    } catch {
      throw new GitHubError("GITHUB_UNAVAILABLE");
    }
  }

  async installation(installationId: number): Promise<{ id: number; account: { id: number; login: string }; suspended_at: string | null }> {
    positiveId(installationId);
    return this.request(`/app/installations/${installationId}`, this.jwt());
  }

  private async token(scope: GitHubRepositoryScope, permissions: GitHubPermissions): Promise<string> {
    repositoryPath(scope);
    const result = await this.request<{
      token: string;
      expires_at: string;
      repositories?: Array<{ id: number }>;
      permissions?: Record<string, string>;
    }>(`/app/installations/${scope.installationId}/access_tokens`, this.jwt(), "POST", {
      repository_ids: [scope.repositoryId],
      permissions
    });
    const expiry = Date.parse(result.expires_at);
    if (typeof result.token !== "string" || !result.token ||
        !Number.isFinite(expiry) || expiry <= this.now() + 30_000 ||
        expiry > this.now() + 3_660_000 ||
        !Array.isArray(result.repositories) || result.repositories.length !== 1 ||
        result.repositories[0]?.id !== scope.repositoryId ||
        !result.permissions || typeof result.permissions !== "object" ||
        Object.entries(permissions).some(([name, value]) => result.permissions?.[name] !== value) ||
        Object.entries(result.permissions).some(([name, value]) =>
          !(name === "metadata" && value === "read") &&
          permissions[name as keyof GitHubPermissions] !== value)) {
      throw new GitHubError("GITHUB_FORBIDDEN");
    }
    // No persistent cache. Each operation obtains a fresh repository-scoped token.
    return result.token;
  }

  async repository(scope: GitHubRepositoryScope): Promise<{ id: number; full_name: string; default_branch: string }> {
    const path = repositoryPath(scope);
    const result = await this.request<{ id: number; full_name: string; default_branch: string }>(path, await this.token(scope, { contents: "read" }));
    if (result.id !== scope.repositoryId || typeof result.full_name !== "string" ||
        result.full_name.toLowerCase() !== scope.fullName.toLowerCase()) {
      throw new GitHubError("GITHUB_FORBIDDEN");
    }
    // GitHub can include temporary credentials (for example temp_clone_token).
    // Return only the public contract, never the upstream response object.
    return { id: result.id, full_name: result.full_name, default_branch: result.default_branch };
  }

  async createBranch(scope: GitHubRepositoryScope, branch: string, baseSha: string, beforeSend?: () => Promise<void>): Promise<{ ref: string; object: { sha: string } }> {
    assertTaskBranch(branch);
    assertSha(baseSha);
    const result = await this.request<{ ref: string; object: { sha: string } }>(`${repositoryPath(scope)}/git/refs`, await this.token(scope, { contents: "write" }), "POST", {
      ref: `refs/heads/${branch}`, sha: baseSha
    }, beforeSend);
    if (result?.ref !== `refs/heads/${branch}` || result?.object?.sha !== baseSha) throw new GitHubError("GITHUB_UNAVAILABLE");
    return result;
  }

  async branch(scope: GitHubRepositoryScope, branch: string): Promise<{ commit: { sha: string } }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes("..")) {
      throw new GitHubError("GITHUB_INVALID_REQUEST");
    }
    const result = await this.request<{ commit: { sha: string } }>(
      `${repositoryPath(scope)}/branches/${encodeURIComponent(branch)}`, await this.token(scope, { contents: "read" }));
    if (!result.commit || !/^[a-f0-9]{40}$/.test(result.commit.sha)) throw new GitHubError("GITHUB_UNAVAILABLE");
    return result;
  }

  async writeFile(scope: GitHubRepositoryScope, input: {
    branch: string; path: string; content: string; message: string; previousBlobSha?: string;
  }, beforeSend?: () => Promise<void>): Promise<{ commit: { sha: string } }> {
    assertTaskBranch(input.branch);
    if (!input.path || input.path.length > 1024 ||
        input.path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
        /[\\\x00-\x1f\x7f]/.test(input.path) ||
        !input.message.trim() || input.message.length > 4096 ||
        Buffer.byteLength(input.content) > 1_000_000) throw new GitHubError("GITHUB_INVALID_REQUEST");
    if (input.previousBlobSha !== undefined) assertSha(input.previousBlobSha);
    return this.request(`${repositoryPath(scope)}/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`,
      await this.token(scope, { contents: "write" }), "PUT", {
        branch: input.branch, message: input.message,
        content: Buffer.from(input.content).toString("base64"),
        ...(input.previousBlobSha ? { sha: input.previousBlobSha } : {})
      }, beforeSend);
  }

  async createPullRequest(scope: GitHubRepositoryScope, input: {
    branch: string; base: string; title: string; body: string;
  }, beforeSend?: () => Promise<void>): Promise<{ number: number; html_url: string; head: { sha: string } }> {
    assertTaskBranch(input.branch);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(input.base) ||
        input.base.includes("..") || input.base === input.branch ||
        !input.title.trim() || input.title.length > 256 || input.body.length > 65_536) {
      throw new GitHubError("GITHUB_INVALID_REQUEST");
    }
    return this.request(`${repositoryPath(scope)}/pulls`, await this.token(scope, { contents: "read", pull_requests: "write" }), "POST", {
      head: input.branch, base: input.base, title: input.title, body: input.body
    }, beforeSend);
  }

  async pullRequest(scope: GitHubRepositoryScope, number: number): Promise<{
    number: number; state: string; draft: boolean; html_url: string;
    head: { sha: string; ref: string; repo: { id: number } };
    base: { ref: string; repo: { id: number } };
    user: { id: number; login: string };
  }> {
    positiveId(number);
    return this.request(`${repositoryPath(scope)}/pulls/${number}`, await this.token(scope, { pull_requests: "read" }));
  }

  async mergePullRequest(scope: GitHubRepositoryScope, number: number, approvedSha: string, beforeSend?: () => Promise<void>): Promise<{ merged: boolean; sha: string }> {
    positiveId(number); assertSha(approvedSha);
    const result = await this.request<{ merged: boolean; sha: string }>(`${repositoryPath(scope)}/pulls/${number}/merge`,
      await this.token(scope, { contents: "write", pull_requests: "write" }), "PUT", { sha: approvedSha, merge_method: "squash" }, beforeSend);
    if (result.merged === false) throw new GitHubError("GITHUB_CONFLICT");
    if (result.merged !== true || !/^[a-f0-9]{40}$/.test(result.sha)) throw new GitHubError("GITHUB_UNAVAILABLE");
    return { merged: result.merged, sha: result.sha };
  }

  async checks(scope: GitHubRepositoryScope, sha: string): Promise<{
    checkRuns: unknown; status: unknown; workflowRuns: unknown; observationsOnly: true;
  }> {
    assertSha(sha);
    const path = repositoryPath(scope);
    const token = await this.token(scope, { contents: "read", checks: "read", actions: "read" });
    const [checkRuns, status, workflowRuns] = await Promise.all([
      this.request(`${path}/commits/${sha}/check-runs?per_page=100`, token),
      this.request(`${path}/commits/${sha}/status?per_page=100`, token),
      this.request(`${path}/actions/runs?head_sha=${sha}&per_page=100`, token)
    ]);
    // Raw observations are evidence, never an automatic merge authorization.
    return { checkRuns, status, workflowRuns, observationsOnly: true };
  }

  async pullRequestCommits(scope: GitHubRepositoryScope, number: number): Promise<unknown[]> {
    positiveId(number);
    const path = repositoryPath(scope);
    const token = await this.token(scope, { pull_requests: "read" });
    const commits: unknown[] = [];
    for (let page = 1; page <= 3; page++) {
      const result = await this.request<unknown[]>(`${path}/pulls/${number}/commits?per_page=100&page=${page}`, token);
      if (!Array.isArray(result)) throw new GitHubError("GITHUB_UNAVAILABLE");
      commits.push(...result);
      // GitHub caps this endpoint at 250 commits; never accept its truncated limit.
      if (commits.length >= 250) throw new GitHubError("GITHUB_FORBIDDEN");
      if (result.length < 100) return commits;
    }
    throw new GitHubError("GITHUB_UNAVAILABLE");
  }

  async branchProtection(scope: GitHubRepositoryScope, branch: string): Promise<unknown> {
    return this.request(`${repositoryPath(scope)}/branches/${encodeURIComponent(branch)}/protection`, await this.token(scope, { administration: "read" }));
  }

  async branchBypassAllowances(scope: GitHubRepositoryScope, branch: string): Promise<unknown> {
    repositoryPath(scope);
    const [owner, name] = scope.fullName.split("/");
    return this.request("/graphql", await this.token(scope, { administration: "read", contents: "read" }), "POST", {
      query: "query JEVBranchBypass($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){branchProtectionRule{bypassPullRequestAllowances(first:1){totalCount}}}}}",
      variables: { owner, name, ref: `refs/heads/${branch}` }
    });
  }

  async codeOwnerErrors(scope: GitHubRepositoryScope, branch: string): Promise<unknown> {
    return this.request(`${repositoryPath(scope)}/codeowners/errors?ref=${encodeURIComponent(branch)}`, await this.token(scope, { contents: "read" }));
  }

  async collaboratorPermission(scope: GitHubRepositoryScope, login: string): Promise<unknown> {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new GitHubError("GITHUB_INVALID_REQUEST");
    return this.request(`${repositoryPath(scope)}/collaborators/${login}/permission`, await this.token(scope, {}));
  }

  async codeOwners(scope: GitHubRepositoryScope, branch: string): Promise<unknown> {
    return this.request(`${repositoryPath(scope)}/contents/.github/CODEOWNERS?ref=${encodeURIComponent(branch)}`,
      await this.token(scope, { contents: "read" }));
  }

  async publicIdentity(scope: GitHubRepositoryScope, login: string): Promise<unknown> {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new GitHubError("GITHUB_INVALID_REQUEST");
    return this.request(`/users/${login}`, await this.token(scope, {}));
  }

  async reviews(scope: GitHubRepositoryScope, number: number): Promise<unknown[]> {
    positiveId(number);
    const path = repositoryPath(scope);
    const token = await this.token(scope, { pull_requests: "read" });
    const reviews: unknown[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await this.request<unknown[]>(`${path}/pulls/${number}/reviews?per_page=100&page=${page}`, token);
      if (!Array.isArray(result)) throw new GitHubError("GITHUB_UNAVAILABLE");
      reviews.push(...result);
      if (result.length < 100) return reviews;
    }
    // Bounded retrieval must not silently report a partial review history as complete.
    throw new GitHubError("GITHUB_UNAVAILABLE");
  }
}
