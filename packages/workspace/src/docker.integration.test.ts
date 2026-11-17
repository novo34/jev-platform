import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_GIT_IMAGE, DEFAULT_IMAGE, SpawnDockerCli, WorkspaceExecutor, type WorkspaceSpec } from "./index.js";

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const orphans = () => ({
  containers: docker("ps", "-a", "--filter", "label=jev.workspace", "--format", "{{.ID}}"),
  volumes: docker("volume", "ls", "-q", "--filter", "label=jev.workspace")
});

// Opt-in: needs a real Docker daemon. Enabled in CI with JEV_DOCKER_TESTS=1.
describe.skipIf(process.env.JEV_DOCKER_TESTS !== "1")("docker workspace (real daemon)", () => {
  let source: string;
  let executor: WorkspaceExecutor;
  const spec = (over: Partial<WorkspaceSpec> = {}): WorkspaceSpec =>
    ({ taskId: "it-task", repoFullName: "local/repo", branch: "feat/it", token: "ghs_notused0000000000", ...over });

  beforeAll(() => {
    docker("pull", DEFAULT_IMAGE);
    docker("pull", DEFAULT_GIT_IMAGE);
    source = mkdtempSync(join(tmpdir(), "jev-ws-src-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: source, stdio: "pipe" });
    git("init", "-q", "-b", "feat/it");
    writeFileSync(join(source, "package.json"), JSON.stringify({
      name: "fixture", version: "1.0.0", private: true, scripts: { test: "node -e \"console.log('tests ok')\"" }
    }));
    writeFileSync(join(source, "package-lock.json"), JSON.stringify({
      name: "fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fixture", version: "1.0.0" } }
    }));
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
    executor = new WorkspaceExecutor({
      docker: new SpawnDockerCli(), unsafeLocalCloneSourceForTests: { hostDir: source }
    });
  });

  afterAll(async () => {
    await executor?.sweepOrphans();
    if (source) rmSync(source, { recursive: true, force: true });
  });

  it("isolates, limits, rejects and cleans up", async () => {
    await executor.withWorkspace(spec(), async (ws) => {
      await ws.install();
      expect((await ws.run("npm test")).output).toContain("tests ok");
      await expect(ws.run("npm install left-pad")).rejects.toMatchObject({ code: "command_not_allowed" });

      const name = ws.containerName;
      const diag = (...cmd: string[]) => docker("exec", "--user", "1000:1000", name, ...cmd);
      expect(Number(diag("id", "-u"))).not.toBe(0);
      expect(diag("sh", "-c", "grep CapEff /proc/self/status")).toMatch(/CapEff:\s+0+$/);
      expect(() => diag("sh", "-c", "wget -q -T 3 -O- http://1.1.1.1 >/dev/null")).toThrow();
      expect(docker("inspect", "-f", "{{json .NetworkSettings.Networks}}", name)).toBe("{}");

      const inspect = JSON.parse(docker("inspect", name))[0];
      expect(inspect.HostConfig.Memory).toBe(2 * 1024 ** 3);
      expect(inspect.HostConfig.MemorySwap).toBe(2 * 1024 ** 3);
      expect(inspect.HostConfig.PidsLimit).toBe(256);
      expect(inspect.HostConfig.NanoCpus).toBe(1e9);
      expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
      expect(inspect.HostConfig.CapDrop).toContain("ALL");
      expect(JSON.stringify(inspect.Mounts)).not.toContain("docker.sock");
    });
    expect(orphans()).toEqual({ containers: "", volumes: "" });
  }, 300_000);

  it("rejects main and leaves nothing behind after a failure", async () => {
    await expect(executor.create(spec({ branch: "main" }))).rejects.toMatchObject({ code: "invalid_branch" });
    await expect(executor.withWorkspace(spec(), async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(orphans()).toEqual({ containers: "", volumes: "" });
  }, 300_000);
});
