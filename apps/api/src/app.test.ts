import { describe, expect, it } from "vitest";
import { buildApi } from "./app.js";

describe("API health", () => {
  it("returns an ok health response", async () => {
    const app = buildApi();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: "api",
      status: "ok"
    });

    await app.close();
  });
});
