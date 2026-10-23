import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { GitHubAppClient, GitHubError, assertTaskBranch } from "../dist/github-app.js";

// Disposable test-only key, generated in memory; never persisted or logged.
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = { appId: "123", privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }) };
const now = Date.parse("2026-10-22T17:00:00Z");
const scope = { installationId: 17, repositoryId: 42, fullName: "owner/repository" };
const sha = "a".repeat(40);

function fixture(handler = () => ({ id: 42, full_name: scope.fullName, default_branch: "main" })) {
  const calls = [];
  const client = new GitHubAppClient(config, {
    now: () => now,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const data = url.endsWith("/access_tokens") ? {
        token: "test-installation-secret",
        expires_at: new Date(now + 3_600_000).toISOString(),
        repositories: [{ id: 42 }],
        permissions: JSON.parse(init.body).permissions
      } : await handler(url, init);
      return data instanceof Response ? data : Response.json(data);
    }
  });
  return { client, calls };
}

test("App JWT is signed, backdated and expires inside ten minutes", async () => {
  const { client, calls } = fixture();
  await client.repository(scope);
  const token = calls[0].init.headers.Authorization.slice(7);
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), {
    iss: "123", iat: now / 1000 - 60, exp: now / 1000 + 540
  });
  assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, "base64url")), true);
  assert.equal(calls[1].init.headers.Authorization, "Bearer test-installation-secret");
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("tokens are limited to one repository and refreshed per operation", async () => {
  const { client, calls } = fixture();
  await client.repository(scope);
  await client.repository(scope);
  assert.equal(calls.length, 4);
  for (const index of [0, 2]) assert.deepEqual(JSON.parse(calls[index].init.body), {
    repository_ids: [42],
    permissions: { contents: "read" }
  });
});

test("repository results exclude temporary credentials and unknown upstream fields", async () => {
  const expected = { id: 42, full_name: scope.fullName, default_branch: "main" };
  const { client } = fixture(() => ({
    ...expected,
    temp_clone_token: "test-only-temporary-credential",
    future_credential: "test-only-future-credential",
    owner: { unexpected_secret: "test-only-nested-credential" }
  }));
  assert.deepEqual(await client.repository(scope), expected);
});

test("invalid configuration is rejected without exposing key material", () => {
  for (const configuration of [
    { appId: "0", privateKey: "private-test-marker" },
    { appId: "123", privateKey: "private-test-marker" }
  ]) assert.throws(() => new GitHubAppClient(configuration), (error) => {
    assert.equal(error.code, "GITHUB_INVALID_CONFIGURATION");
    assert.equal(error.message.includes("private-test-marker"), false);
    return true;
  });
});

test("PR, reviews, checks and workflow observations use deep public allowlists", async () => {
  const extra = { temp_clone_token: "test-only-clone-secret", future_credential: "test-only-unknown-secret" };
  const repo = { id: 42, ...extra };
  const user = { id: 7, login: "reviewer", ...extra };
  const pr = { number: 9, state: "open", draft: false, html_url: "https://github.com/owner/repository/pull/9",
    head: { sha, ref: "feat/task", repo, ...extra }, base: { ref: "main", repo, ...extra }, user, ...extra };
  const review = { id: 1, commit_id: sha, state: "APPROVED", user, ...extra };
  const check = { id: 1, name: "validate", head_sha: sha, status: "completed", conclusion: "success", app: { id: 8, ...extra }, ...extra };
  const status = { id: 2, context: "validate", state: "success", ...extra };
  const workflow = { id: 3, head_sha: sha, status: "completed", conclusion: "success",
    repository: repo, head_repository: repo, pull_requests: [pr], ...extra };
  const { client } = fixture((url) => url.includes("/reviews?") ? [review] :
    url.includes("/check-runs") ? { total_count: 1, check_runs: [check], ...extra } :
    url.includes("/actions/runs") ? { total_count: 1, workflow_runs: [workflow], ...extra } :
    url.includes("/status?") ? { state: "success", statuses: [status], ...extra } : pr);
  const actualPr = await client.pullRequest(scope, 9);
  assert.deepEqual(actualPr.head.repo, { id: 42 });
  assert.deepEqual(actualPr.base.repo, { id: 42 });
  assert.deepEqual(actualPr.user, { id: 7, login: "reviewer" });
  const reviews = await client.reviews(scope, 9);
  const checks = await client.checks(scope, sha);
  assert.deepEqual(checks.workflowRuns, { total_count: 1, workflow_runs: [{ id: 3, head_sha: sha, status: "completed", conclusion: "success" }] });
  assert.deepEqual(checks.checkRuns.check_runs[0].app, { id: 8 });
  assert.equal(reviews[0].commit_id, sha);
  const serialized = JSON.stringify({ actualPr, reviews, checks });
  assert.equal(serialized.includes("test-only-"), false);
  assert.equal(serialized.includes("temp_clone_token"), false);
  assert.equal(serialized.includes("future_credential"), false);
});

test("malformed public observations fail closed without upstream error details", async () => {
  const { client } = fixture(() => ({ malformed: "test-only-upstream-secret" }));
  await assert.rejects(client.pullRequest(scope, 9), { message: "GITHUB_UNAVAILABLE" });
  await assert.rejects(client.reviews(scope, 9), { message: "GITHUB_UNAVAILABLE" });
  await assert.rejects(client.checks(scope, sha), { message: "GITHUB_UNAVAILABLE" });
});

test("PR observations preserve deleted fork and deleted author nulls without upstream extras", async () => {
  const expected = { number: 9, state: "closed", draft: false, html_url: "https://github.com/owner/repository/pull/9",
    head: { sha, ref: "feat/deleted", repo: null }, base: { ref: "main", repo: { id: 42 } }, user: null };
  const { client } = fixture(() => ({ ...expected, temp_clone_token: "test-only-deleted-fork-secret" }));
  assert.deepEqual(await client.pullRequest(scope, 9), expected);
});

test("main/master, ref aliases and malformed task branches never reach GitHub", async () => {
  const { client, calls } = fixture();
  for (const branch of ["main", "master", "MAIN", "refs/heads/main", "heads/master", "feat/../main",
    "feat/x.lock", "feat/.hidden", "feat/a//b", "feat/a.", "feat/a/", "feat/a@{1}", "feat/a\\b", "feat/a\nb"]) {
    await assert.rejects(client.createBranch(scope, branch, sha), { code: "GITHUB_FORBIDDEN" });
  }
  assert.equal(calls.length, 0);
  for (const branch of ["feat/plt-010-github", "fix/task-1", "chore/task-2/nested"]) assert.doesNotThrow(() => assertTaskBranch(branch));
});

test("invalid repository scope and SHA are rejected before token issuance", async () => {
  const { client, calls } = fixture();
  for (const fullName of ["owner/.", "owner/..", "owner/repo/extra", "../repo", "owner/repo?x", "owner/repo#x", "owner/repo\n"]) {
    await assert.rejects(client.repository({ ...scope, fullName }), { code: "GITHUB_INVALID_REQUEST" });
  }
  for (const repositoryId of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(client.repository({ ...scope, repositoryId }), { code: "GITHUB_INVALID_REQUEST" });
  }
  await assert.rejects(client.createBranch(scope, "feat/task", "main"), { code: "GITHUB_INVALID_REQUEST" });
  assert.equal(calls.length, 0);
});

test("expired, overlong, malformed and incorrectly scoped tokens fail closed", async () => {
  for (const delta of [
    { expires_at: new Date(now + 29_000).toISOString() },
    { expires_at: new Date(now + 3_661_000).toISOString() },
    { expires_at: "bad" }, { token: "" }, { repositories: [{ id: 999 }] },
    { repositories: [{ id: 42 }, { id: 999 }] }, { repositories: [null] },
    { permissions: { contents: "write" } }, { permissions: { contents: "read", administration: "write" } }
  ]) {
    let calls = 0;
    const client = new GitHubAppClient(config, { now: () => now, fetch: async () => {
      calls++;
      return Response.json({ token: "secret", expires_at: new Date(now + 3_600_000).toISOString(),
        repositories: [{ id: 42 }], permissions: { contents: "read" }, ...delta });
    } });
    await assert.rejects(client.repository(scope), { code: "GITHUB_FORBIDDEN" });
    assert.equal(calls, 1);
  }
});

test("repository identity mismatch is rejected", async () => {
  for (const data of [{ id: 999, full_name: scope.fullName }, { id: 42, full_name: "different/repo" }]) {
    const { client } = fixture(() => data);
    await assert.rejects(client.repository(scope), { code: "GITHUB_FORBIDDEN" });
  }
});

test("malformed successful JSON has a stable typed error", async () => {
  for (const data of [null, false, "secret-marker", 123]) {
    const client = new GitHubAppClient(config, { fetch: async () => Response.json(data) });
    await assert.rejects(client.repository(scope), { code: "GITHUB_UNAVAILABLE" });
  }
  for (const data of [{ id: 42, full_name: null }, { id: 42 }]) {
    const { client } = fixture(() => data);
    await assert.rejects(client.repository(scope), { code: "GITHUB_FORBIDDEN" });
  }
});

test("controlled branch creation uses an explicit commit and write-scoped temporary token", async () => {
  const { client, calls } = fixture(() => ({ ref: "refs/heads/feat/task", object: { sha } }));
  await client.createBranch(scope, "feat/task", sha);
  assert.deepEqual(JSON.parse(calls[1].init.body), { ref: "refs/heads/feat/task", sha });
  assert.equal(JSON.parse(calls[0].init.body).permissions.contents, "write");
  assert.deepEqual(JSON.parse(calls[0].init.body).permissions, { contents: "write" });
});

test("file commits reject traversal and protected branches; encode contents and blob concurrency check", async () => {
  const { client, calls } = fixture(() => ({ commit: { sha } }));
  const input = { branch: "feat/task", path: "src/file.ts", content: "ñ", message: "feat: task", previousBlobSha: sha };
  for (const path of ["../x", "/x", "x/./y", "x//y", ".git/config", "x\\y", "x\ny"]) {
    await assert.rejects(client.writeFile(scope, { ...input, path }), { code: "GITHUB_INVALID_REQUEST" });
  }
  await assert.rejects(client.writeFile(scope, { ...input, branch: "main" }), { code: "GITHUB_FORBIDDEN" });
  assert.equal(calls.length, 0);
  await client.writeFile(scope, input);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    branch: "feat/task", message: "feat: task", content: Buffer.from("ñ").toString("base64"), sha
  });
});

test("PR creation validates source and uses explicit base", async () => {
  const { client, calls } = fixture(() => ({ number: 1, html_url: "https://github.com/owner/repository/pull/1", head: { sha } }));
  const input = { branch: "feat/task", base: "main", title: "feat: task", body: "Task evidence" };
  await assert.rejects(client.createPullRequest(scope, { ...input, branch: "master" }), { code: "GITHUB_FORBIDDEN" });
  await client.createPullRequest(scope, input);
  assert.deepEqual(JSON.parse(calls[1].init.body), { head: "feat/task", base: "main", title: input.title, body: input.body });
  assert.deepEqual(JSON.parse(calls[0].init.body).permissions, { contents: "read", pull_requests: "write" });
});

test("errors redact upstream secrets; rate limits have bounded retry hints and no automatic retry", async () => {
  for (const [status, headers, code, retry] of [
    [401, {}, "GITHUB_FORBIDDEN"], [404, {}, "GITHUB_FORBIDDEN"],
    [422, {}, "GITHUB_CONFLICT"], [500, {}, "GITHUB_UNAVAILABLE"],
    [429, { "retry-after": "999999" }, "GITHUB_RATE_LIMITED", 3600],
    [403, { "x-ratelimit-remaining": "0" }, "GITHUB_RATE_LIMITED"]
  ]) {
    let calls = 0;
    const client = new GitHubAppClient(config, { fetch: async () => {
      calls++;
      return new Response("secret-upstream-body", { status, headers });
    } });
    await assert.rejects(client.repository(scope), (error) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.code, code);
      assert.equal(error.retryAfterSeconds, retry);
      assert.equal(error.message.includes("secret-upstream-body"), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("ambiguous network failure is sanitized and never retried", async () => {
  let calls = 0;
  const client = new GitHubAppClient(config, { fetch: async () => {
    calls++;
    throw new Error("secret-network-marker");
  } });
  await assert.rejects(client.createBranch(scope, "feat/task", sha), { message: "GITHUB_UNAVAILABLE" });
  assert.equal(calls, 1);
});

test("checks read the exact SHA and label results as observations, not authorization", async () => {
  const { client, calls } = fixture((url) => url.includes("/check-runs") ? { total_count: 0, check_runs: [] } :
    url.includes("/actions/runs") ? { total_count: 0, workflow_runs: [] } : { state: "success", statuses: [] });
  const result = await client.checks(scope, sha);
  assert.equal(result.observationsOnly, true);
  assert.equal("reviews" in result, false);
  assert.equal(calls.length, 4);
  assert.ok(calls.slice(1).every((call) => call.init.method === "GET" && call.url.includes(sha)));
});

test("review history paginates and refuses to silently truncate", async () => {
  const review = (id) => ({ id, commit_id: sha, state: "APPROVED", user: { id: 7, login: "reviewer" } });
  const { client, calls } = fixture((url) => url.endsWith("page=1") ? Array.from({ length: 100 }, (_, id) => review(id + 1)) : [review(101)]);
  assert.equal((await client.reviews(scope, 1)).length, 101);
  assert.equal(calls.length, 3);
  const bounded = fixture(() => Array(100).fill(review(1)));
  await assert.rejects(bounded.client.reviews(scope, 1), { code: "GITHUB_UNAVAILABLE" });
  assert.equal(bounded.calls.length, 11);
});

test("policy is rechecked after token issuance and before each mutating HTTP request", async () => {
  const operations = [
    (client, gate) => client.createBranch(scope, "feat/task", sha, gate),
    (client, gate) => client.writeFile(scope, { branch: "feat/task", path: "x", content: "x", message: "feat: x" }, gate),
    (client, gate) => client.createPullRequest(scope, { branch: "feat/task", base: "main", title: "feat: x", body: "x" }, gate),
    (client, gate) => client.mergePullRequest(scope, 1, sha, gate)
  ];
  for (const operation of operations) {
    const { client, calls } = fixture();
    await assert.rejects(operation(client, async () => { throw new GitHubError("GITHUB_FORBIDDEN"); }), { code: "GITHUB_FORBIDDEN" });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/access_tokens"));
  }
});

test("merge sends an exact approved SHA without bypass flags", async () => {
  const { client, calls } = fixture(() => ({ merged: true, sha }));
  assert.deepEqual(await client.mergePullRequest(scope, 1, sha), { merged: true, sha });
  assert.equal(calls[1].init.method, "PUT");
  assert.deepEqual(JSON.parse(calls[1].init.body), { sha, merge_method: "squash" });
  assert.deepEqual(JSON.parse(calls[0].init.body).permissions, { contents: "write", pull_requests: "write" });
});

 test("branch creation rejects malformed or mismatched successful upstream responses", async () => {
  for (const body of [{}, null, { ref: "refs/heads/feat/other", object: { sha } }, { ref: "refs/heads/feat/task", object: { sha: "b".repeat(40) } }]) {
    const { client, calls } = fixture(() => body);
    await assert.rejects(client.createBranch(scope, "feat/task", sha), { code: "GITHUB_UNAVAILABLE" });
    assert.equal(calls.length, 2);
  }
});


test("merge policy inspection uses explicit read-only App permissions", async () => {
  const { client, calls } = fixture(() => ({}));
  await client.branchProtection(scope, "main");
  await client.codeOwners(scope, "main");
  await client.codeOwnerErrors(scope, "main");
  await client.publicIdentity(scope, "trusted-reviewer");
  await client.collaboratorPermission(scope, "trusted-reviewer");
  const permissions = calls.filter(call => call.url.endsWith("/access_tokens")).map(call => JSON.parse(call.init.body).permissions);
  assert.deepEqual(permissions, [{ administration: "read" }, { contents: "read" }, { contents: "read" }, {}, {}]);
  assert.ok(calls.filter(call => !call.url.endsWith("/access_tokens")).every(call => call.init.method === "GET"));
  await assert.rejects(client.publicIdentity(scope, "../attacker"), { code: "GITHUB_INVALID_REQUEST" });
});

test("PR commit provenance paginates and refuses GitHub's 250-commit truncation limit", async () => {
  const { client } = fixture(url => url.endsWith("page=1") ? Array(100).fill({ sha }) : [{ sha }]);
  assert.equal((await client.pullRequestCommits(scope, 9)).length, 101);
  const capped = fixture(url => url.endsWith("page=3") ? Array(50).fill({ sha }) : Array(100).fill({ sha }));
  await assert.rejects(capped.client.pullRequestCommits(scope, 9), { code: "GITHUB_FORBIDDEN" });
});


test("optional bypass inspection is a fixed read-only GraphQL query with variables", async () => {
  const { client, calls } = fixture(() => ({}));
  await client.branchBypassAllowances(scope, "main");
  const body = JSON.parse(calls[1].init.body);
  assert.equal(calls[1].url, "https://api.github.com/graphql");
  assert.match(body.query, /^query JEVBranchBypass/);
  assert.equal(body.query.includes("mutation"), false);
  assert.equal(body.variables.ref, "refs/heads/main");
  assert.deepEqual(JSON.parse(calls[0].init.body).permissions, { administration: "read", contents: "read" });
});
