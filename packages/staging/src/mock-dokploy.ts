/**
 * Local HTTP server that imitates the subset of the Dokploy API used by the
 * adapter. It records every call and lets a test program failures and the
 * deployment outcome. It also serves the "public" staging app under /public.
 * Test support only: not exported from the package index.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  authenticated: boolean;
}

export interface ProgrammedFailure {
  path: string;
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** How many matching calls fail; default 1. */
  times?: number;
  /** Delay before answering (to provoke client timeouts). */
  delayMs?: number;
}

interface MockCompose {
  composeId: string;
  name: string;
  appName: string;
  environmentId: string;
  composeFile: string;
  env: string;
  composeStatus: "idle" | "running" | "done" | "error";
}

export class MockDokploy {
  readonly calls: RecordedCall[] = [];
  readonly composes = new Map<string, MockCompose>();
  readonly domains = new Map<string, Array<Record<string, unknown>>>();
  readonly publicResponses = new Map<string, { status: number; body: string }>();
  /** Statuses returned by successive compose.one reads after a deploy; the last one sticks. */
  deployStatuses: Array<MockCompose["composeStatus"]> = ["running", "done"];
  private failures: ProgrammedFailure[] = [];
  private pending = new Map<string, Array<MockCompose["composeStatus"]>>();
  private server: Server | null = null;
  private sequence = 0;
  url = "";

  constructor(
    readonly apiKey: string,
    readonly environmentId = "env_1"
  ) {}

  private randomSuffix(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  }

  fail(failure: ProgrammedFailure): void {
    this.failures.push({ times: 1, ...failure });
  }

  paths(): string[] {
    return this.calls.map((call) => call.path);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    if (url.pathname.startsWith("/public/")) {
      const programmed = this.publicResponses.get(url.pathname.slice("/public".length)) ?? { status: 200, body: "ok" };
      res.writeHead(programmed.status, { "content-type": "text/plain" });
      res.end(programmed.body);
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = url.pathname.replace(/^\/api\//, "");
    const call: RecordedCall = {
      method: req.method ?? "GET",
      path,
      query: Object.fromEntries(url.searchParams),
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      authenticated: req.headers["x-api-key"] === this.apiKey
    };
    this.calls.push(call);

    if (!call.authenticated) return send(401, { message: "Unauthorized" });
    const failure = this.failures.find((f) => f.path === path && (f.times ?? 1) > 0);
    if (failure) {
      failure.times = (failure.times ?? 1) - 1;
      if (failure.delayMs) await new Promise((resolve) => setTimeout(resolve, failure.delayMs));
      return send(failure.status, failure.body ?? { message: "programmed failure" }, failure.headers);
    }
    return this.route(call, send);
  }

  private route(call: RecordedCall, send: (status: number, body: unknown) => void): void {
    const body = call.body ?? {};
    const need = (...keys: string[]): boolean => keys.every((key) => body[key] !== undefined && body[key] !== "");
    switch (`${call.method} ${call.path}`) {
      case "GET environment.one": {
        if (call.query.environmentId !== this.environmentId) return send(404, { message: "Environment not found" });
        return send(200, { environmentId: this.environmentId, compose: [...this.composes.values()].map(({ composeId, name, composeStatus }) => ({ composeId, name, composeStatus, description: null, icon: null, server: null, serverId: null, createdAt: "2026-01-01T00:00:00.000Z" })) });
      }
      case "POST compose.create": {
        if (!need("name", "environmentId", "composeType", "sourceType")) return send(400, { message: "invalid body" });
        const composeId = `cmp_${++this.sequence}`;
        // Real Dokploy always appends "-<6 chars [a-z0-9]>" to the requested appName.
        const requested = String(body.appName ?? body.name);
        const appName = `${requested}-${this.randomSuffix()}`;
        this.composes.set(composeId, {
          composeId,
          name: String(body.name),
          appName,
          environmentId: String(body.environmentId),
          composeFile: String(body.composeFile ?? ""),
          env: "",
          composeStatus: "idle"
        });
        return send(200, { composeId, name: body.name, appName });
      }
      case "POST compose.update": {
        const compose = this.composes.get(String(body.composeId));
        if (!compose) return send(404, { message: "Compose not found" });
        if (typeof body.composeFile === "string") compose.composeFile = body.composeFile;
        return send(200, true);
      }
      case "POST compose.saveEnvironment": {
        const compose = this.composes.get(String(body.composeId));
        if (!compose) return send(404, { message: "Compose not found" });
        compose.env = String(body.env ?? "");
        return send(200, true);
      }
      case "GET compose.one": {
        const compose = this.composes.get(call.query.composeId ?? "");
        if (!compose) return send(404, { message: "Compose not found" });
        const queue = this.pending.get(compose.composeId);
        if (queue && queue.length > 0) compose.composeStatus = queue.length > 1 ? queue.shift()! : queue[0]!;
        return send(200, compose);
      }
      case "GET domain.byComposeId": {
        if (!this.composes.has(call.query.composeId ?? "")) return send(404, { message: "Compose not found" });
        return send(200, this.domains.get(call.query.composeId!) ?? []);
      }
      case "POST domain.create": {
        if (!need("host", "composeId", "serviceName", "port") || !this.composes.has(String(body.composeId))) return send(400, { message: "invalid body" });
        const list = this.domains.get(String(body.composeId)) ?? [];
        if (list.some((d) => d.host === body.host)) return send(409, { message: "Domain exists" });
        const record = { domainId: `dom_${++this.sequence}`, host: body.host, serviceName: body.serviceName, port: body.port, https: body.https, certificateType: body.certificateType };
        list.push(record);
        this.domains.set(String(body.composeId), list);
        return send(200, record);
      }
      case "POST compose.deploy":
      case "POST compose.redeploy": {
        const compose = this.composes.get(String(body.composeId));
        if (!compose) return send(404, { message: "Compose not found" });
        this.pending.set(compose.composeId, [...this.deployStatuses]);
        compose.composeStatus = "running";
        return send(200, true);
      }
      default:
        return send(404, { message: `Unknown route ${call.path}` });
    }
  }
}
