import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubError, type ControlService } from "@jev/control";
import { registerControlRoutes } from "./control.js";

const state = "a".repeat(43);
const callback = vi.fn();
const execute = vi.fn();
const app = () => {
  const server = Fastify({ logger: false });
  const pool = { query: async (sql: string) => ({ rows: sql.includes("FROM auth_sessions") ? [{
    id: "user", organization_id: "org", session_id: "session", status: "ACTIVE", role: "ADMIN"
  }] : [] }) } as unknown as Pool;
  registerControlRoutes(server, pool, { execute, completeGitHubInstallation: callback } as unknown as ControlService);
  return server;
};
afterEach(() => { vi.resetAllMocks(); });

describe("GitHub installation HTTP contract (simulated control boundary)", () => {
  it("sets a host-only secure HttpOnly cookie without returning cookieState", async () => {
    const server = app();
    execute.mockResolvedValue({ ok: true, action: "START_GITHUB_INSTALLATION", data: {
      installUrl: `https://github.com/apps/jev-test/installations/new?state=${state}`, cookieState: state
    } });
    const result = await server.inject({ method: "POST", url: "/control/commands", headers: { authorization: "Bearer test" },
      payload: { action: "START_GITHUB_INSTALLATION", projectId: "11111111-1111-4111-8111-111111111111", payload: { repositoryId: "22222222-2222-4222-8222-222222222222" } } });
    expect(result.statusCode).toBe(200);
    expect(result.headers["set-cookie"]).toBe(`__Host-jev_github_install=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    expect(result.json().data).not.toHaveProperty("cookieState");
    await server.close();
  });

  it("forwards the exact state cookie and redirects to server-generated OAuth authorization", async () => {
    const server = app();
    callback.mockResolvedValue({ authorizeUrl: "https://github.com/login/oauth/authorize?state=opaque" });
    const result = await server.inject({ url: `/integrations/github/callback?state=${state}&installation_id=17&setup_action=install`,
      headers: { cookie: `__Host-jev_github_install=${state}` } });
    expect(result.statusCode).toBe(302);
    expect(result.headers.location).toBe("https://github.com/login/oauth/authorize?state=opaque");
    expect(callback.mock.calls[0][0]).toEqual({ state, cookieState: state, installationId: 17, code: undefined });
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    await server.close();
  });

  it("clears state cookie after successful callback and returns no OAuth token", async () => {
    const server = app();
    callback.mockResolvedValue({ repositoryId: "repository", installationId: 17 });
    const result = await server.inject({ url: `/integrations/github/callback?state=${state}&code=test-code`, headers: { cookie: `__Host-jev_github_install=${state}` } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ ok: true, repositoryId: "repository", installationId: 17 });
    expect(result.headers["set-cookie"]).toContain("Max-Age=0");
    await server.close();
  });

  it("returns a static return-to-JEV page for a browser without exposing callback inputs", async () => {
    const server = app();
    callback.mockResolvedValue({ identityConnected: true });
    const result = await server.inject({ url: `/integrations/github/callback?state=${state}&code=test-code`,
      headers: { cookie: `__Host-jev_github_install=${state}`, accept: "text/html" } });
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toContain("text/html");
    expect(result.body).toContain('href="/"');
    expect(result.body).not.toContain("test-code");
    expect(result.body).not.toContain(state);
    await server.close();
  });

  it("rejects duplicate cookies and preserves typed errors without secret bodies", async () => {
    const server = app();
    callback.mockRejectedValue(new GitHubError("GITHUB_FORBIDDEN"));
    const result = await server.inject({ url: `/integrations/github/callback?state=${state}&code=test-code`,
      headers: { cookie: `__Host-jev_github_install=${state}; __Host-jev_github_install=${state}` } });
    expect(callback.mock.calls[0][0].cookieState).toBeUndefined();
    expect(result.statusCode).toBe(403);
    expect(result.body).not.toContain("test-code");
    expect(result.headers["set-cookie"]).toContain("Max-Age=0");
    await server.close();
  });

  it("rejects malformed callback input and OAuth denial without invoking control", async () => {
    const server = app();
    expect((await server.inject({ url: "/integrations/github/callback?state=bad" })).statusCode).toBe(400);
    expect((await server.inject({ url: "/integrations/github/callback?error=access_denied" })).statusCode).toBe(403);
    expect(callback).not.toHaveBeenCalled();
    await server.close();
  });

  it.each([
    ["GITHUB_CONFLICT", 409, "CONFLICT"],
    ["GITHUB_RATE_LIMITED", 429, "RATE_LIMITED"],
    ["GITHUB_UNAVAILABLE", 503, "UPSTREAM_UNAVAILABLE"]
  ] as const)("maps %s to stable HTTP failure and bounded retry metadata", async (code, status, failureCode) => {
    const server = app();
    execute.mockRejectedValue(new GitHubError(code, code === "GITHUB_RATE_LIMITED" ? 12 : undefined));
    const response = await server.inject({ method: "POST", url: "/control/commands", headers: { authorization: "Bearer test" },
      payload: { action: "GITHUB_READ_REPOSITORY", projectId: "11111111-1111-4111-8111-111111111111" } });
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(failureCode);
    if (code === "GITHUB_RATE_LIMITED") expect(response.headers["retry-after"]).toBe("12");
    await server.close();
  });
});
