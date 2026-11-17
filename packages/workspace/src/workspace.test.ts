import { describe, expect, it } from "vitest";
import { assertTaskBranch } from "@jev/control";
import {
  COMMAND_ALLOWLIST, FakeDockerCli, WorkspaceError, WorkspaceExecutor, isTaskBranch, sanitizeOutput,
  type WorkspaceSpec
} from "./index.js";

const TOKEN = "ghs_FAKETOKEN1234567890abcdefghij";
const spec = (over: Partial<WorkspaceSpec> = {}): WorkspaceSpec => ({
  taskId: "task-1", repoFullName: "acme/app", branch: "feat/thing", token: TOKEN, ...over
});

/** Fake whose inspect reports one network until `network disconnect` runs. */
function fakeDocker(opts: { disconnectExit?: number; stillAttached?: boolean } = {}) {
  const fake = new FakeDockerCli();
  let attached = true;
  fake.when(["inspect"], () => ({ stdout: attached ? '{"bridge":{}}' : "{}" }));
  fake.when(["network", "disconnect"], () => {
    if (opts.disconnectExit) return { exitCode: opts.disconnectExit, stderr: "boom" };
    if (!opts.stillAttached) attached = false;
    return {};
  });
  return fake;
}
const executor = (fake: FakeDockerCli, extra: Partial<ConstructorParameters<typeof WorkspaceExecutor>[0]> = {}) =>
  new WorkspaceExecutor({ docker: fake, idGenerator: () => "abc123", ...extra });
const argvAll = (fake: FakeDockerCli) => fake.calls.map((c) => c.args);

describe("create", () => {
  it("builds hardened argv with limits, labels and no docker.sock", async () => {
    const fake = fakeDocker();
    await executor(fake).create(spec());
    const create = fake.callsMatching(["create"])[0]!.args;
    const joined = create.join(" ");
    for (const flag of [
      "--user 1000:1000", "--cap-drop ALL", "--security-opt no-new-privileges", "--read-only",
      "--tmpfs /tmp:rw,noexec,nosuid,size=256m", "--cpus 1", "--memory 2g", "--memory-swap 2g", "--pids-limit 256",
      "--label jev.workspace=abc123", "--label jev.task=task-1", "-v jev-ws-abc123:/workspace", "node:22-alpine sleep infinity"
    ]) expect(joined).toContain(flag);
    expect(fake.callsMatching(["volume", "create"])[0]!.args).toContain("jev.workspace=abc123");
    expect(fake.callsMatching(["start"])).toHaveLength(1);
    expect(JSON.stringify(argvAll(fake))).not.toContain("docker.sock");
    // only the named volume is mounted, no host path
    for (const args of argvAll(fake)) {
      args.forEach((a, i) => { if (args[i - 1] === "-v") expect(a).toMatch(/^jev-ws-abc123:\/workspace$/); });
    }
  });

  it("sends the token only through stdin and never to argv or logs", async () => {
    const fake = fakeDocker();
    const logs: string[] = [];
    const ws = await executor(fake, { logger: (e) => logs.push(JSON.stringify(e)) }).create(spec());
    await ws.install();
    expect(JSON.stringify(argvAll(fake))).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);
    const clone = fake.callsMatching(["run"])[0]!;
    expect(clone.stdin).toBe(`${TOKEN}\n`);
    expect(clone.args).toContain("--depth");
    expect(clone.args).toContain("feat/thing");
    expect(clone.args.some((a) => a.includes("@") && a.includes("github.com"))).toBe(false);
    expect(clone.args).toContain("https://github.com/acme/app.git");
    expect(clone.args.join(" ")).not.toMatch(/-e [A-Z_]*TOKEN/);
  });

  it("redacts the token from errors", async () => {
    const fake = fakeDocker();
    fake.when(["run"], { exitCode: 128, stderr: `fatal: https://x-access-token:${TOKEN}@github.com failed ${TOKEN}` });
    const error = await executor(fake).create(spec()).catch((e) => e as WorkspaceError);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).code).toBe("clone_failed");
    expect((error as WorkspaceError).message).not.toContain(TOKEN);
    // failed create cleans up
    expect(fake.callsMatching(["volume", "rm"])).toHaveLength(1);
  });

  it.each(["main", "master", "refs/heads/main", "develop", "feat/../x", "feat/x.lock", "feat//x", "-x", "feat/", "feat/x@{1}", "chore/.hidden"])(
    "rejects branch %s before touching docker", async (branch) => {
      const fake = fakeDocker();
      await expect(executor(fake).create(spec({ branch }))).rejects.toMatchObject({ code: "invalid_branch" });
      expect(fake.calls).toHaveLength(0);
    });

  it("rejects invalid taskId, repo and token", async () => {
    const fake = fakeDocker();
    for (const bad of [{ taskId: "a b" }, { taskId: "" }, { repoFullName: "acme" }, { repoFullName: "a/b/c" }, { repoFullName: "acme/.." }, { token: "" }, { token: "a\nb" }]) {
      await expect(executor(fake).create(spec(bad))).rejects.toMatchObject({ code: "invalid_spec" });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps assertTaskBranch of @jev/control and isTaskBranch in agreement", () => {
    const samples = ["main", "master", "feat/ok", "fix/a.b-c", "chore/x/y", "feat/a..b", "feat//a", "feat/a/", "feat/a.lock", "feat/.a", "feat/a.", "feat/a@{b}", "x/y", "", "feat/" + "a".repeat(200), "refs/heads/main", "feat/ñ", "feat/a b"];
    for (const s of samples) {
      let controlOk = true;
      try { assertTaskBranch(s); } catch { controlOk = false; }
      expect(isTaskBranch(s), s).toBe(controlOk);
    }
  });

  it("does not mount host paths unless test-only option is given", async () => {
    const fake = fakeDocker();
    await executor(fake, { unsafeLocalCloneSourceForTests: { hostDir: "/tmp/src" } }).create(spec());
    const clone = fake.callsMatching(["run"])[0]!.args;
    expect(clone).toContain("/tmp/src:/src:ro");
    expect(fake.callsMatching(["create"])[0]!.args.join(" ")).not.toContain("/tmp/src");
  });
});

describe("install and run", () => {
  it("runs npm ci, disconnects every network, verifies, then allows run", async () => {
    const fake = fakeDocker();
    const ws = await executor(fake).create(spec());
    const record = await ws.install();
    expect(record).toMatchObject({ command: "npm ci", exitCode: 0, timedOut: false });
    const execCall = fake.callsMatching(["exec"])[0]!.args;
    expect(execCall).toEqual(["exec", "--user", "1000:1000", "-w", "/workspace", "jev-ws-abc123", "npm", "ci"]);
    expect(fake.callsMatching(["network", "disconnect"])[0]!.args).toEqual(["network", "disconnect", "--force", "bridge", "jev-ws-abc123"]);
    await ws.run("npm test");
    expect(fake.callsMatching(["exec"])[1]!.args.slice(-2)).toEqual(["npm", "test"]);
  });

  it("destroys and errors when the network cannot be disconnected; run never executes", async () => {
    for (const opts of [{ disconnectExit: 1 }, { stillAttached: true }]) {
      const fake = fakeDocker(opts);
      const ws = await executor(fake).create(spec());
      await expect(ws.install()).rejects.toMatchObject({ code: "network_disconnect_failed" });
      expect(fake.callsMatching(["rm", "-f"])).toHaveLength(1);
      const before = fake.callsMatching(["exec"]).length;
      await expect(ws.run("npm test")).rejects.toBeInstanceOf(WorkspaceError);
      expect(fake.callsMatching(["exec"]).length).toBe(before);
    }
  });

  it("refuses run() before install()", async () => {
    const fake = fakeDocker();
    const ws = await executor(fake).create(spec());
    await expect(ws.run("npm test")).rejects.toMatchObject({ code: "install_required" });
    await expect(ws.run("npm ci")).rejects.toMatchObject({ code: "use_install" });
  });

  it.each(["npm install", "npm test -- --x", "rm -rf /", "npm test; id", "", "NPM TEST", "git push", "sh", "constructor", "__proto__"])(
    "rejects %j as command_not_allowed", async (command) => {
      const fake = fakeDocker();
      const ws = await executor(fake).create(spec());
      await ws.install();
      const before = fake.calls.length;
      await expect(ws.run(command)).rejects.toMatchObject({ code: "command_not_allowed" });
      await expect(ws.run(undefined as unknown as string)).rejects.toMatchObject({ code: "command_not_allowed" });
      expect(fake.calls.length).toBe(before);
    });

  it("allowlist is exactly the seven documented commands", () => {
    expect([...COMMAND_ALLOWLIST.keys()]).toEqual(["npm ci", "npm test", "npm run build", "npm run lint", "git status", "git diff", "git log"]);
  });

  it("records sanitized, truncated output", async () => {
    const fake = fakeDocker();
    const big = "x".repeat(40_000);
    fake.when(["exec"], { stdout: `${big}\nTOKEN ${TOKEN}\nAuthorization: Bearer abcdefghijk\n`, exitCode: 3 });
    const ws = await executor(fake).create(spec());
    const record = await ws.install();
    expect(record.exitCode).toBe(3);
    expect(record.output.length).toBeLessThanOrEqual(16 * 1024);
    expect(record.output).not.toContain(TOKEN);
    expect(record.output).not.toContain("abcdefghijk");
    expect(ws.records).toHaveLength(1);
  });

  it("applies the per-command timeout, kills the container on timeout", async () => {
    const fake = fakeDocker();
    const ws = await executor(fake, { limits: { commandTimeoutMs: 5000 } }).create(spec());
    await ws.install();
    fake.when(["exec"], { timedOut: true, exitCode: 137 });
    const record = await ws.run("npm test");
    expect(fake.callsMatching(["exec"]).at(-1)!.timeoutMs).toBe(5000);
    expect(record.timedOut).toBe(true);
    expect(fake.callsMatching(["rm", "-f"])).toHaveLength(1);
    await expect(ws.run("npm test")).rejects.toMatchObject({ code: "workspace_destroyed" });
  });

  it("honours the total task deadline", async () => {
    const fake = fakeDocker();
    let now = 1_000_000;
    const ws = await executor(fake, { now: () => now, limits: { commandTimeoutMs: 600_000, taskTimeoutMs: 700_000 } }).create(spec());
    await ws.install();
    now += 500_000;
    await ws.run("npm test");
    expect(fake.callsMatching(["exec"]).at(-1)!.timeoutMs).toBe(200_000);
    now += 250_000;
    const before = fake.callsMatching(["exec"]).length;
    await expect(ws.run("npm test")).rejects.toMatchObject({ code: "task_timeout" });
    expect(fake.callsMatching(["exec"]).length).toBe(before);
    expect(fake.callsMatching(["rm", "-f"])).toHaveLength(1);
  });

  it("aborts, destroys and throws when the signal fires", async () => {
    const fake = fakeDocker();
    const controller = new AbortController();
    const ws = await executor(fake).create(spec({ signal: controller.signal }));
    await ws.install();
    controller.abort();
    await expect(ws.run("npm test")).rejects.toMatchObject({ code: "aborted" });
    expect(fake.callsMatching(["exec"])).toHaveLength(1);
  });
});

describe("withWorkspace and destroy", () => {
  it("destroys on success, error and abort", async () => {
    const ok = fakeDocker();
    await expect(executor(ok).withWorkspace(spec(), async () => 42)).resolves.toBe(42);
    expect(ok.callsMatching(["volume", "rm"])).toHaveLength(1);

    const failing = fakeDocker();
    await expect(executor(failing).withWorkspace(spec(), async () => { throw new Error("fn failed"); })).rejects.toThrow("fn failed");
    expect(failing.callsMatching(["rm", "-f"])).toHaveLength(1);
    expect(failing.callsMatching(["volume", "rm"])).toHaveLength(1);

    const aborted = fakeDocker();
    const controller = new AbortController();
    await expect(executor(aborted).withWorkspace(spec({ signal: controller.signal }), async (ws) => {
      await ws.install();
      controller.abort();
      await ws.run("npm test");
    })).rejects.toMatchObject({ code: "aborted" });
    expect(aborted.callsMatching(["volume", "rm"])).toHaveLength(1);
  });

  it("destroy is idempotent and does not throw", async () => {
    const fake = fakeDocker();
    const ws = await executor(fake).create(spec());
    expect(await ws.destroy()).toBe(true);
    expect(await ws.destroy()).toBe(true);
    expect(fake.callsMatching(["volume", "rm"])).toHaveLength(1);
    expect(fake.callsMatching(["rm", "-f"])[0]!.args).toEqual(["rm", "-f", "jev-clone-abc123", "jev-ws-abc123"]);
  });

  it("destroy swallows docker errors and reports false, retrying later", async () => {
    const fake = fakeDocker();
    const ws = await executor(fake).create(spec());
    fake.when(["rm"], { exitCode: 1, stderr: "daemon error" }, { once: true });
    expect(await ws.destroy()).toBe(false);
    expect(await ws.destroy()).toBe(true);
  });
});

describe("sweepOrphans", () => {
  it("removes labelled containers then volumes", async () => {
    const fake = new FakeDockerCli();
    fake.when(["ps"], { stdout: "c1\nc2\n" });
    fake.when(["volume", "ls"], { stdout: "jev-ws-a\n" });
    const result = await executor(fake).sweepOrphans();
    expect(result).toEqual({ containers: ["c1", "c2"], volumes: ["jev-ws-a"] });
    expect(fake.calls[0]!.args).toContain("label=jev.workspace");
    expect(fake.callsMatching(["rm", "-f"])[0]!.args).toEqual(["rm", "-f", "c1", "c2"]);
    expect(fake.callsMatching(["volume", "rm"])[0]!.args).toEqual(["volume", "rm", "-f", "jev-ws-a"]);
  });

  it("ignores unsafe names and skips removal when nothing is found", async () => {
    const fake = new FakeDockerCli();
    fake.when(["ps"], { stdout: "--all\n" });
    const result = await executor(fake).sweepOrphans();
    expect(result).toEqual({ containers: [], volumes: [] });
    expect(fake.callsMatching(["rm"])).toHaveLength(0);
  });
});

describe("sanitizeOutput", () => {
  it("removes the token and credential patterns", () => {
    const text = [
      `token ${TOKEN}`, "ghp_abcdefghijklmnopqrstuvwxyz0123", "github_pat_11ABCDEFG0abcdefghijklmn",
      "https://x-access-token:s3cret@github.com/a/b", "Authorization: Basic eC1hY2Nlc3M6dG9rZW4=",
      "authorization=Bearer qwertyuiop", `b64 ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`
    ].join("\n");
    const out = sanitizeOutput(text, [TOKEN]);
    for (const leak of [TOKEN, "ghp_abcdef", "github_pat_11", "s3cret", "eC1hY2Nlc3M6", "qwertyuiop"]) expect(out).not.toContain(leak);
    expect(out).toContain("x-access-token:[REDACTED]@github.com");
  });

  it("keeps harmless text", () => {
    expect(sanitizeOutput("npm test ok\n3 passed")).toBe("npm test ok\n3 passed");
  });
});
