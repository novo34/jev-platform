// Scope every staging runtime to its private PostgreSQL container.
const secret = process.env.JEV_STAGING_RUNTIME_DB_PASSWORD;
if (!secret) throw new Error("JEV_STAGING_RUNTIME_DB_PASSWORD is required");
const url = new URL("postgresql://jev_runtime@postgres:5432/jev_staging");
url.password = secret;
process.env.DATABASE_URL = url.toString();
if (process.env.JEV_ENTRYPOINT === "api") {
  await import("../../apps/api/dist/server.js");
} else if (process.env.JEV_ENTRYPOINT === "worker") {
  await import("../../apps/worker/dist/server.js");
} else {
  throw new Error("Unknown JEV_ENTRYPOINT");
}
