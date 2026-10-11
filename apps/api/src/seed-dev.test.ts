import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const seed = fileURLToPath(new URL("./seed-dev.ts", import.meta.url));

function attemptSeed(env: Record<string, string | undefined>) {
  const result = spawnSync(process.execPath, ["--import", "tsx", seed], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 6_000
  });
  return {
    status: result.status,
    output: result.stderr + result.stdout
  };
}

describe("development seed preflight", () => {
  it("rejects an omitted NODE_ENV before any database connection", () => {
    const result = attemptSeed({
      NODE_ENV: undefined,
      JEV_ALLOW_DEV_SEED: "1",
      DATABASE_URL: "postgresql://user:password@127.0.0.1:1/unsafe"
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("requires NODE_ENV=development");
  });

  it("rejects host or credential query overrides before any database migration", () => {
    for (const suffix of [
      "?host=production-db",
      "?port=5432&host=db.example.com",
      "?host=/var/run/postgresql",
      "#unexpected"
    ]) {
      const result = attemptSeed({
        NODE_ENV: "development",
        JEV_ALLOW_DEV_SEED: "1",
        DATABASE_URL: "postgresql://user:password@127.0.0.1:1/unsafe" + suffix
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("valid PostgreSQL DATABASE_URL");
    }
  });

  it("requires an explicit acknowledgement and rejects remote databases", () => {
    const unacknowledged = attemptSeed({
      NODE_ENV: "development",
      JEV_ALLOW_DEV_SEED: undefined,
      DATABASE_URL: "postgresql://user:password@127.0.0.1:1/unsafe"
    });
    expect(unacknowledged.status).not.toBe(0);
    expect(unacknowledged.output).toContain("JEV_ALLOW_DEV_SEED=1");

    const remote = attemptSeed({
      NODE_ENV: "development",
      JEV_ALLOW_DEV_SEED: "1",
      DATABASE_URL: "postgresql://user:password@db.example.com:5432/unsafe"
    });
    expect(remote.status).not.toBe(0);
    expect(remote.output).toContain("refuses non-local database endpoints");
  });
});
