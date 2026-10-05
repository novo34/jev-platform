import { describe, expect, it } from "vitest";
import { buildWorkerHealthServer } from "./app.js";

describe("Worker health", () => {
  it("returns an ok health response", async () => {
    const app = buildWorkerHealthServer();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: "worker",
      status: "ok"
    });

    await app.close();
  });
});
