import { codeForStatus, DokployError } from "./errors.js";
import { sanitizeText } from "./sanitize.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DokployClientEvent {
  method: string;
  path: string;
  status: number | null;
  outcome: "ok" | "error";
  code?: string;
}

export interface DokployClientOptions {
  /** Instance URL; `/api/` is appended. Must be https (http only for loopback). */
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Receives method/path/status only: never headers, bodies or the key. */
  onEvent?: (event: DokployClientEvent) => void;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class DokployClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly onEvent?: (event: DokployClientEvent) => void;

  constructor(options: DokployClientOptions) {
    if (!options.apiKey) throw new DokployError("unauthorized", "dokploy_api_key_required");
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new DokployError("invalid_response", "dokploy_base_url_invalid");
    }
    // The key travels in a header: never send it over clear text off-host.
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
      throw new DokployError("invalid_response", "dokploy_base_url_must_be_https");
    }
    if (url.username || url.password) throw new DokployError("invalid_response", "dokploy_base_url_must_not_embed_credentials");
    this.base = `${url.origin}${url.pathname.replace(/\/+$/, "")}/api/`;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.onEvent = options.onEvent;
  }

  get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    return this.request("GET", path, { query });
  }

  post(path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", path, { body });
  }

  private emit(event: DokployClientEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      /* observers must not break calls */
    }
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    options: { query?: Record<string, string>; body?: Record<string, unknown> }
  ): Promise<unknown> {
    if (!/^[a-zA-Z]+\.[a-zA-Z]+$/.test(path)) throw new DokployError("invalid_response", "dokploy_path_invalid");
    const url = new URL(path, this.base);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const secrets = [this.apiKey];
    const fail = (error: DokployError, status: number | null): never => {
      this.emit({ method, path, status, outcome: "error", code: error.code });
      throw error;
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          "x-api-key": this.apiKey,
          accept: "application/json",
          ...(options.body ? { "content-type": "application/json" } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        return fail(new DokployError("timeout", `dokploy_timeout:${path}`, { secrets }), null);
      }
      return fail(new DokployError("upstream", `dokploy_unreachable:${path}:${sanitizeText(String((error as Error).message), secrets).slice(0, 120)}`, { secrets }), null);
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      return fail(new DokployError("timeout", `dokploy_timeout_reading_body:${path}`, { secrets }), response.status);
    }

    if (!response.ok) {
      const retry = Number(response.headers.get("retry-after"));
      return fail(
        new DokployError(codeForStatus(response.status), `dokploy_http_${response.status}:${path}:${text.slice(0, 200)}`, {
          status: response.status,
          retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : null,
          secrets
        }),
        response.status
      );
    }

    let parsed: unknown;
    try {
      parsed = text.trim() === "" ? null : JSON.parse(text);
    } catch {
      return fail(new DokployError("invalid_response", `dokploy_non_json_response:${path}`, { status: response.status, secrets }), response.status);
    }
    this.emit({ method, path, status: response.status, outcome: "ok" });
    return parsed;
  }
}
