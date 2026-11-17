import { describe, expect, it } from "vitest";
import { FakeDockerCli, WorkspaceExecutor } from "@jev/workspace";
import type { QueueJob } from "@jev/queue";
import { WorkerRuntime } from "./runtime.js";
import { WORKSPACE_JOB_TYPE, createWorkspaceJobHandler, parseWorkspacePayload, workspaceHandlers, type TokenProvider } from "./workspace-job.js";

const TOKEN = "ghs_FAKEJOBTOKEN1234567890abcdefgh";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const payload = (over: Record<string, unknown> = {}) => ({
  taskId: "task-1", projectId: PROJECT, repoFullName: "acme/app", branch: "feat/thing", commands: ["npm test", "git status"], ...over
});
const job = (p: unknown, over: Partial<QueueJob> = {}): QueueJob => ({
  id: "job-1", queue: "default", jobType: WORKSPACE_JOB_TYPE, payload: p as Record<string, unknown>, status: "RUNNING",
  attemptCount: 1, maxAttempts: 1, correlationId: "c", projectId: null, orderId: null, taskId: null, ...over
});
const provider = (calls: Array<[string, string]> = []): TokenProvider => async (p, r) => {
  calls.push([p, r]);
  return { token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
};

function fakeDocker() {
  const fake = new FakeDockerCli();
  let attached = true;
  fake.when(["inspect"], () => ({ stdout: attached ? '{"bridge":{}}' : "{}" }));
  fake.when(["network", "disconnect"], () => { attached = false; return {}; });
  return fake;
}
const setup = (fake = fakeDocker(), tokenProvider = provider()) => {
  const executor = new WorkspaceExecutor({ docker: fake, idGenerator: () => "abc123" });
  return { fake, handler: createWorkspaceJobHandler({ executor, tokenProvider }) };
};
const ctx = (signal = new AbortController().signal) => ({ signal });
const destroyed = (fake: FakeDockerCli) => fake.callsMatching(["volume", "rm"]).length === 1;

describe("parseWorkspacePayload", () => {
  it.each([
    ["extra field", payload({ extra: 1 })],
    ["missing field", (() => { const { branch, ...rest } = payload(); return rest; })()],
    ["main branch", payload({ branch: "main" })],
    ["bad repo", payload({ repoFullName: "acme" })],
    ["bad task id", payload({ taskId: "a b" })],
    ["bad project id", payload({ projectId: "nope" })],
    ["empty commands", payload({ commands: [] })],
    ["too many commands", payload({ commands: Array(11).fill("npm test") })],
    ["npm ci requested", payload({ commands: ["npm ci"] })],
    ["command outside allowlist", payload({ commands: ["rm -rf /"] })],
    ["non-string command", payload({ commands: [1] })],
    ["array payload", []],
    ["null payload", null]
  ])("rejects %s", (_name, bad) => {
    expect(() => parseWorkspacePayload(bad)).toThrowError(/invalid workspace job payload/);
  });

  it("accepts a valid payload and exactly 10 commands", () => {
    expect(parseWorkspacePayload(payload()).commands).toEqual(["npm test", "git status"]);
    expect(parseWorkspacePayload(payload({ commands: Array(10).fill("npm run lint") })).commands).toHaveLength(10);
  });
});

describe("workspace job handler", () => {
  it("rejects an invalid payload without asking for a token or touching docker", async () => {
    const calls: Array<[string, string]> = [];
    const { fake, handler } = setup(fakeDocker(), provider(calls));
    await expect(handler(job(payload({ extra: 1 })), ctx())).rejects.toMatchObject({ code: "invalid_payload" });
    await expect(handler(job(payload(), { taskId: "other" }), ctx())).rejects.toMatchObject({ code: "invalid_payload" });
    expect(calls).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("asks the provider for the project/repo, installs first, runs commands in order, destroys, and keeps the token out", async () => {
    const calls: Array<[string, string]> = [];
    const { fake, handler } = setup(fakeDocker(), provider(calls));
    fake.when(["exec"], { stdout: `out ${TOKEN}` });
    const result = await handler(job(payload()), ctx()) as any;
    expect(calls).toEqual([[PROJECT, "acme/app"]]);
    expect(result.status).toBe("PASSED");
    expect(result).toMatchObject({ workspaceId: "abc123", branch: "feat/thing" });
    expect(result.commands.map((c: any) => c.command)).toEqual(["npm ci", "npm test", "git status"]);
    expect(Object.keys(result.commands[0]).sort()).toEqual(["command", "durationMs", "exitCode", "output", "timedOut"]);
    const order = fake.calls.map((c) => c.args[0] === "exec" ? c.args.slice(-2).join(" ") : c.args[0] === "run" && c.args.includes("jev-git-abc123") ? "git" : c.args[0]);
    expect(order.filter((x) => x === "npm test" || x === "git")).toEqual(["npm test", "git"]);
    expect(order.indexOf("npm ci")).toBeLessThan(order.indexOf("npm test"));
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(destroyed(fake)).toBe(true);
  });

  it("returns FAILED with detail, stops at the first failing command and still destroys", async () => {
    const { fake, handler } = setup();
    fake.when(["exec"], (call) => call.args.includes("test") ? { exitCode: 1, stdout: `boom ${TOKEN}` } : {});
    const result = await handler(job(payload({ commands: ["npm test", "npm run lint"] })), ctx()) as any;
    expect(result.status).toBe("FAILED");
    expect(result.commands.map((c: any) => [c.command, c.exitCode])).toEqual([["npm ci", 0], ["npm test", 1]]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(destroyed(fake)).toBe(true);
  });

  it("reports a failing install as FAILED without running the requested commands", async () => {
    const { fake, handler } = setup();
    fake.when(["exec"], { exitCode: 1, stderr: "npm ERR" });
    const result = await handler(job(payload()), ctx()) as any;
    expect(result.status).toBe("FAILED");
    expect(result.commands).toHaveLength(1);
    expect(destroyed(fake)).toBe(true);
  });

  it("throws sanitized errors on clone failure and destroys the workspace", async () => {
    const { fake, handler } = setup();
    fake.when(["run"], { exitCode: 128, stderr: `fatal: https://x-access-token:${TOKEN}@github.com ${TOKEN}` });
    const error: any = await handler(job(payload()), ctx()).catch((e: any) => e);
    expect(error).toMatchObject({ code: "workspace_failed" });
    expect(error.message).not.toContain(TOKEN);
    expect(String(error.stack)).not.toContain(TOKEN);
    expect(destroyed(fake)).toBe(true);
  });

  it("never echoes provider errors", async () => {
    const { fake, handler } = setup(fakeDocker(), async () => { throw new Error(`leak ${TOKEN}`); });
    const error: any = await handler(job(payload()), ctx()).catch((e: any) => e);
    expect(error).toMatchObject({ code: "token_unavailable" });
    expect(error.message).not.toContain(TOKEN);
    expect(fake.calls).toHaveLength(0);
    const expired = setup(fakeDocker(), async () => ({ token: TOKEN, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    await expect(expired.handler(job(payload()), ctx())).rejects.toMatchObject({ code: "token_unavailable" });
  });

  it("aborts mid-run: throws and destroys the workspace", async () => {
    const abort = new AbortController();
    const { fake, handler } = setup();
    fake.when(["exec"], (call) => { if (call.args.includes("test")) abort.abort(new Error("job_timeout")); return {}; });
    const error: any = await handler(job(payload()), ctx(abort.signal)).catch((e: any) => e);
    expect(error).toMatchObject({ code: "workspace_failed" });
    expect(error.message).toContain("aborted");
    expect(destroyed(fake)).toBe(true);
    expect(fake.callsMatching(["rm", "-f"]).length).toBeGreaterThan(0);
  });

  it("does not start when already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const { fake, handler } = setup();
    await expect(handler(job(payload()), ctx(abort.signal))).rejects.toMatchObject({ code: "workspace_failed" });
    expect(fake.calls).toHaveLength(0);
  });

  it("exposes the handler under WORKSPACE_RUN and is not part of the default runtime handlers", () => {
    const { handler } = setup();
    expect(Object.keys(workspaceHandlers({ executor: new WorkspaceExecutor({ docker: new FakeDockerCli() }), tokenProvider: provider() }))).toEqual(["WORKSPACE_RUN"]);
    expect(typeof handler).toBe("function");
  });
});

describe("runtime timeout integration", () => {
  it("the runtime job timeout aborts the in-flight workspace, which is destroyed", async () => {
    const fake = fakeDocker();
    // a command that only finishes when the docker call is aborted
    fake.when(["exec"], (call) => call.args.includes("test")
      ? new Promise((resolve) => call.signal?.addEventListener("abort", () => resolve({ exitCode: 137 }), { once: true }))
      : {});
    const executor = new WorkspaceExecutor({ docker: fake, idGenerator: () => "abc123" });
    const outcomes: string[] = [];
    const queue = {
      claimNext: async () => job(payload()),
      complete: async () => { outcomes.push("complete"); },
      fail: async (_w: string, _j: QueueJob, error: unknown) => { outcomes.push(`fail:${(error as Error).message}`); },
      registerWorker: async () => {}
    };
    const runtime = new WorkerRuntime(queue as any, {
      workerId: "w", jobTimeoutMs: 50, handlers: workspaceHandlers({ executor, tokenProvider: provider() })
    });
    (runtime as any).running = true;
    await runtime.pollOnce();
    expect(outcomes[0]).toBe("fail:job_timeout");
    // the handler settles after the abort and cleans up
    for (let i = 0; i < 50 && !destroyed(fake); i++) await new Promise((r) => setTimeout(r, 10));
    expect(destroyed(fake)).toBe(true);
    expect(outcomes.join()).not.toContain(TOKEN);
  });
});
