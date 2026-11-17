import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderStagingCompose, STAGING_ROLES_COMMAND, STAGING_ROLES_SQL } from "./compose-template.js";

const REV = "7baa286" + "0".repeat(33);
const base = {
  appName: "x",
  appEnvKeys: ["DATABASE_URL"],
  appPort: 3000,
  postgresImage: "postgres:16-alpine",
  revision: REV,
  app: { buildContext: `https://github.com/o/r.git#${REV}` },
  migrationCommand: "npm run migrate",
  seedCommand: "npm run seed",
  limits: { appMemory: "1m", appCpus: "1", dbMemory: "1m", dbCpus: "1" }
};

/** Text of a top-level service block. */
function service(file: string, name: string): string {
  const match = new RegExp(`^ {2}${name}:\\n((?: {4}.*\\n|\\n)*)`, "m").exec(file);
  if (!match) throw new Error(`service ${name} not found`);
  return match[1]!;
}

describe("staging compose: runtime role provisioning", () => {
  const file = renderStagingCompose(base);

  it("has no initdb script nor configs.content (initdb only runs on an empty volume)", () => {
    expect(file).not.toContain("docker-entrypoint-initdb.d");
    expect(file).not.toMatch(/^configs:/m);
    expect(file).not.toContain("init_roles");
  });

  it("the role SQL only uses psql variables it defines", () => {
    const defined = new Set([...STAGING_ROLES_SQL.matchAll(/\\getenv (\w+) /g)].map((m) => m[1]!));
    const used = new Set([...STAGING_ROLES_SQL.matchAll(/:["']([a-z_]+)["']/g)].map((m) => m[1]!));
    expect(defined.size).toBeGreaterThan(0);
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) expect(defined, `undefined psql variable :${name}`).toContain(name);
    expect(STAGING_ROLES_SQL).not.toContain("DBNAME");
    expect(STAGING_ROLES_COMMAND).toContain("ON_ERROR_STOP=1");
  });

  it("does not put secrets on the command line nor use compose interpolation inside the script", () => {
    expect(STAGING_ROLES_COMMAND).not.toContain("$");
    expect(STAGING_ROLES_COMMAND).not.toMatch(/-v\s+rt_pw/);
    const roles = service(file, "db-roles");
    expect(roles).toContain('PGPASSWORD: "${STAGING_DB_OWNER_PASSWORD}"');
    expect(roles).toContain('STAGING_DB_RUNTIME_PASSWORD: "${STAGING_DB_RUNTIME_PASSWORD}"');
    expect(roles).toContain("db: { condition: service_healthy }");
    expect(roles).toContain('restart: "no"');
  });

  it("app, migrate and seed wait for db-roles (and seed for migrate)", () => {
    for (const name of ["app", "migrate", "seed"]) {
      expect(service(file, name), name).toContain("db-roles: { condition: service_completed_successfully }");
    }
    expect(service(file, "seed")).toContain("migrate: { condition: service_completed_successfully }");
    expect(service(file, "migrate")).not.toContain("seed:");
  });

  it("db-roles exists even without migrate/seed, and gates the app", () => {
    const plain = renderStagingCompose({ ...base, migrationCommand: undefined, seedCommand: undefined });
    expect(plain).toMatch(/^ {2}db-roles:/m);
    expect(service(plain, "app")).toContain("db-roles: { condition: service_completed_successfully }");
  });

  it("db healthcheck uses TCP so the temporary init server is not considered healthy", () => {
    expect(service(file, "db")).toContain("pg_isready -h 127.0.0.1 -U $${POSTGRES_USER} -d $${POSTGRES_DB}");
  });
});

const adminUrl = process.env.DATABASE_URL;
const hasPsql = spawnSync("psql", ["--version"]).status === 0;

describe.skipIf(!adminUrl || !hasPsql)("role SQL against a real PostgreSQL", () => {
  it("is idempotent and lets the runtime role read and write tables created by the owner", () => {
    const url = new URL(adminUrl!);
    const conn = { PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) };
    const suffix = randomBytes(4).toString("hex");
    const dbName = `jev_roles_${suffix}`;
    const runtime = `rt_${suffix}`;
    const passwords = ["first'pw\"x", "second pw;x"];
    const psql = (env: Record<string, string>, args: string[]) =>
      spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", ...args], { env: { ...process.env, ...conn, ...env }, encoding: "utf8" });
    const ok = (result: ReturnType<typeof psql>) => {
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      return result.stdout.trim();
    };
    const provision = (password: string) =>
      spawnSync("sh", ["-c", STAGING_ROLES_COMMAND], { env: { ...process.env, ...conn, PGDATABASE: dbName, STAGING_DB_RUNTIME: runtime, STAGING_DB_RUNTIME_PASSWORD: password }, encoding: "utf8" });
    ok(psql({ PGDATABASE: "postgres" }, ["-c", `CREATE DATABASE ${dbName}`]));
    try {
      for (const password of passwords) {
        // The same command the db-roles service runs, with the secrets only in env.
        const run = provision(password);
        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
      }
      // Table created by the owner AFTER provisioning (what `migrate` does).
      ok(psql({ PGDATABASE: dbName }, ["-c", "CREATE TABLE public.t (id serial PRIMARY KEY, v text)"]));
      const asRuntime = (sql: string, password: string) => psql({ PGDATABASE: dbName, PGUSER: runtime, PGPASSWORD: password }, ["-c", sql]);
      expect(ok(psql({ PGDATABASE: dbName }, ["-c", `SELECT rolcanlogin::text || rolsuper::text || rolcreatedb::text || rolcreaterole::text FROM pg_roles WHERE rolname = '${runtime}'`]))).toBe("truefalsefalsefalse");
      ok(asRuntime("INSERT INTO public.t (v) VALUES ('a')", passwords[1]!));
      expect(ok(asRuntime("SELECT count(*) FROM public.t", passwords[1]!))).toBe("1");
      expect(asRuntime("CREATE TABLE public.nope (x int)", passwords[1]!).status).not.toBe(0);
      // A table created before a run (existing volume) is covered by the GRANT ON ALL.
      ok(psql({ PGDATABASE: dbName }, ["-c", `ALTER DEFAULT PRIVILEGES FOR ROLE ${conn.PGUSER} IN SCHEMA public REVOKE ALL ON TABLES FROM ${runtime}`]));
      ok(psql({ PGDATABASE: dbName }, ["-c", "CREATE TABLE public.legacy (x int)"]));
      expect(asRuntime("SELECT * FROM public.legacy", passwords[1]!).status).not.toBe(0);
      expect(provision(passwords[1]!).status).toBe(0);
      ok(asRuntime("SELECT * FROM public.legacy", passwords[1]!));
    } finally {
      psql({ PGDATABASE: "postgres" }, ["-c", `DROP DATABASE IF EXISTS ${dbName}`]);
      psql({ PGDATABASE: "postgres" }, ["-c", `DROP ROLE IF EXISTS ${runtime}`]);
    }
  });
});
