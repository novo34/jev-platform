import { describe, expect, it } from "vitest";
import { CachePolicy, ModelGatewayError, isCacheAttributableError } from "./index.js";

describe("CachePolicy.fromEnv", () => {
  it("defaults to off when JEV_PROMPT_CACHE is absent", () => {
    const policy = CachePolicy.fromEnv({});
    expect(policy.enabled).toBe(false);
    expect(policy.decide("openai").enabled).toBe(false);
  });

  it("accepts exactly on and off", () => {
    expect(CachePolicy.fromEnv({ JEV_PROMPT_CACHE: "on" }).decide("anthropic").enabled).toBe(true);
    expect(CachePolicy.fromEnv({ JEV_PROMPT_CACHE: "off" }).decide("anthropic")).toMatchObject({
      enabled: false, reason: expect.stringMatching(/off/)
    });
  });

  it.each(["", "ON", "On", "true", "1", "yes", " on", "on ", "enabled"])(
    "rejects the invalid value %j instead of treating it as on", (value) => {
      expect(() => CachePolicy.fromEnv({ JEV_PROMPT_CACHE: value })).toThrowError(
        expect.objectContaining({ code: "CACHE_CONFIG_INVALID" }) as unknown as Error
      );
    });

  it("limits the cache to the listed providers when on", () => {
    const policy = CachePolicy.fromEnv({
      JEV_PROMPT_CACHE: "on", JEV_PROMPT_CACHE_PROVIDERS: "anthropic,openai"
    });
    expect(policy.decide("anthropic").enabled).toBe(true);
    expect(policy.decide("openai").enabled).toBe(true);
    expect(policy.decide("deepseek")).toMatchObject({
      enabled: false, reason: expect.stringMatching(/not in JEV_PROMPT_CACHE_PROVIDERS/)
    });
  });

  it("applies to every provider when on without a list; the list never enables an off switch", () => {
    expect(CachePolicy.fromEnv({ JEV_PROMPT_CACHE: "on" }).decide("deepseek").enabled).toBe(true);
    expect(CachePolicy.fromEnv({ JEV_PROMPT_CACHE_PROVIDERS: "anthropic" }).decide("anthropic").enabled)
      .toBe(false);
  });

  it.each(["", "anthropic,", "claude", "Anthropic", "openai, deepseek"])(
    "rejects the invalid provider list %j, even when the switch is off", (value) => {
      expect(() => CachePolicy.fromEnv({ JEV_PROMPT_CACHE_PROVIDERS: value })).toThrowError(
        expect.objectContaining({ code: "CACHE_CONFIG_INVALID" }) as unknown as Error
      );
    });
});

describe("isCacheAttributableError", () => {
  const http = (status: number, message: string) =>
    new ModelGatewayError("PROVIDER_HTTP_ERROR", message, status >= 500 || status === 429, status);

  it("accepts a 400 or 422 that names the cache parameters", () => {
    expect(isCacheAttributableError(http(400, "cache_control: invalid ttl"))).toBe(true);
    expect(isCacheAttributableError(http(422, "too many cache breakpoints"))).toBe(true);
  });

  it("rejects an unrelated 400 and every non-400 status", () => {
    expect(isCacheAttributableError(http(400, "max_tokens is too large"))).toBe(false);
    for (const status of [401, 403, 404, 429, 500, 502, 503]) {
      expect(isCacheAttributableError(http(status, "cache_control rejected"))).toBe(false);
    }
    expect(isCacheAttributableError(
      new ModelGatewayError("PROVIDER_TIMEOUT", "cache timed out", true)
    )).toBe(false);
    expect(isCacheAttributableError(new Error("cache"))).toBe(false);
  });
});
