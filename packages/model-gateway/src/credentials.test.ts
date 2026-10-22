import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { ProviderCredentialStore } from "./credentials.js";
import { ModelGatewayError } from "./types.js";

const validKey = Buffer.alloc(32, 42).toString("base64");
const unreachablePool = {
  connect: () => { throw new Error("unexpected database access"); }
} as unknown as Pool;

describe("PLT-009 encryption key fail-closed validation", () => {
  it.each([
    "",
    "hello",
    validKey.slice(0, -1),
    validKey + "!",
    validKey + "\n",
    validKey.replace(/=$/, "=="),
    Buffer.alloc(31, 42).toString("base64"),
    Buffer.alloc(33, 42).toString("base64"),
    validKey.slice(0, -2) + "B=" // noncanonical trailing bits
  ])("rejects malformed encryption keys before database access", async badKey => {
    const store = new ProviderCredentialStore(unreachablePool, badKey);
    await expect(
      store.configure("org-id", "openai", "valid-secret-value", "actor-id")
    ).rejects.toMatchObject({ code: "SECRET_STORE_UNAVAILABLE" } satisfies Partial<ModelGatewayError>);
  });

  it("accepts canonical 32-byte keys and persists only encrypted material", async () => {
    const writes: { sql: string; args: unknown[] }[] = [];
    const client = {
      query: async (sql: string, args: unknown[] = []) => {
        writes.push({ sql, args });
        return { rows: sql.includes("RETURNING updated_at") ? [{ updated_at: new Date("2026-01-01T00:00:00Z") }] : [] };
      },
      release: () => {}
    };
    const store = new ProviderCredentialStore(
      { connect: async () => client } as unknown as Pool,
      randomBytes(32).toString("base64")
    );
    const result = await store.configure("org-id", "openai", "secret-not-in-database", "actor-id");
    expect(result).toMatchObject({ provider: "openai", configured: true });
    const insert = writes.find(w => w.sql.includes("INSERT INTO provider_credentials"));
    expect(insert).toBeDefined();
    expect(insert?.args[2]).not.toBe("secret-not-in-database");
    expect(insert?.args[3]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(insert?.args[4]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(writes.some(w => w.sql === "COMMIT")).toBe(true);
  });
});
