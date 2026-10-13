import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApi } from "./app.js";

describe("API readiness", () => {
  it("returns 200 when the database query succeeds", async () => {
    const pool = { query: async () => ({ rows: [{ "?column?": 1 }] }) } as unknown as Pool;
    const app = buildApi({ pool });
    const result = await app.inject({ method: "GET", url: "/ready" });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ status: "ready" });
    await app.close();
  });

  it("returns 503 when database access fails", async () => {
    const pool = { query: async () => { throw new Error("offline"); } } as unknown as Pool;
    const app = buildApi({ pool });
    const result = await app.inject({ method: "GET", url: "/ready" });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toMatchObject({ status: "unavailable" });
    await app.close();
  });
});
