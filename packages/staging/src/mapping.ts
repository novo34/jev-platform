/**
 * Isolated mapping layer between the adapter and the Dokploy HTTP API.
 *
 * Verified against the OpenAPI document of Dokploy v0.31.2 (inputs): environment.one, compose.one, compose.create,
 * compose.update, compose.saveEnvironment, compose.deploy/redeploy, domain.byComposeId and domain.create.
 * VERIFY-R4 stays only on what is NOT verified: the responses of the POST calls (e.g. that compose.create returns
 * `composeId`) and the deployment behaviour. See docs/architecture/PLT-012-PERMANENT-STAGING.md. Nothing outside
 * this file knows the wire format.
 */
import { DokployError } from "./errors.js";

export const ENDPOINTS = {
  // Verified (v0.31.2): lookup of existing composes by environment (`environment.one`, field `compose`).
  environmentOne: "environment.one",
  composeCreate: "compose.create",
  composeUpdate: "compose.update",
  composeOne: "compose.one",
  composeSaveEnvironment: "compose.saveEnvironment",
  composeDeploy: "compose.deploy",
  composeRedeploy: "compose.redeploy",
  domainCreate: "domain.create",
  domainByComposeId: "domain.byComposeId"
} as const;

export const COMPOSE_STATUSES = ["idle", "running", "done", "error"] as const;
export type ComposeStatus = (typeof COMPOSE_STATUSES)[number];

export interface ComposeRef {
  composeId: string;
  name: string;
  appName: string;
}

/** Element of `environment.one.compose[]`: the real API does NOT include `appName` there (only `compose.one` does). */
export interface ComposeListEntry {
  composeId: string;
  name: string;
  composeStatus?: string;
}

export interface ComposeDetails extends ComposeRef {
  composeStatus: ComposeStatus;
  composeFile: string;
  /** Raw `KEY=VALUE` lines as stored by Dokploy. */
  env: string;
}

export interface DomainRecord {
  domainId: string | null;
  host: string;
  serviceName: string | null;
  port: number | null;
  https: boolean;
  certificateType: string;
}

function invalid(what: string): never {
  throw new DokployError("invalid_response", `dokploy_invalid_response:${what}`);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(what);
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") return invalid(what);
  return value;
}

export function composeCreateBody(input: { name: string; appName: string; environmentId: string; composeFile: string; serverId?: string }): Record<string, unknown> {
  return {
    name: input.name,
    appName: input.appName,
    environmentId: input.environmentId,
    composeType: "docker-compose",
    // Verified (v0.31.2 input): raw source with the generated file (no Git source configured by this step).
    sourceType: "raw",
    composeFile: input.composeFile,
    ...(input.serverId ? { serverId: input.serverId } : {})
  };
}

export function composeUpdateBody(input: { composeId: string; composeFile: string }): Record<string, unknown> {
  return { composeId: input.composeId, sourceType: "raw", composeFile: input.composeFile };
}

/** Verified (v0.31.2 input): body of compose.saveEnvironment is `{composeId, env}` with `KEY=VALUE` lines. */
export function saveEnvironmentBody(composeId: string, env: Record<string, string>): Record<string, unknown> {
  return { composeId, env: serializeEnv(env) };
}

export function domainCreateBody(input: { composeId: string; host: string; serviceName: string; port: number }): Record<string, unknown> {
  return {
    host: input.host,
    composeId: input.composeId,
    serviceName: input.serviceName,
    port: input.port,
    https: true,
    certificateType: "letsencrypt",
    // Verified (v0.31.2 input): domainType "compose" binds the domain to a compose service.
    domainType: "compose"
  };
}

export function parseComposeCreated(raw: unknown): { composeId: string } {
  return { composeId: asString(asObject(raw, "compose.create").composeId, "compose.create.composeId") };
}

function toComposeListEntry(raw: unknown, what: string): ComposeListEntry {
  const object = asObject(raw, what);
  return {
    composeId: asString(object.composeId, `${what}.composeId`),
    name: asString(object.name, `${what}.name`),
    ...(typeof object.composeStatus === "string" ? { composeStatus: object.composeStatus } : {})
  };
}

function toComposeRef(raw: unknown, what: string): ComposeRef {
  const object = asObject(raw, what);
  return {
    composeId: asString(object.composeId, `${what}.composeId`),
    name: asString(object.name, `${what}.name`),
    appName: asString(object.appName, `${what}.appName`)
  };
}

export function parseEnvironmentComposes(raw: unknown): ComposeListEntry[] {
  const object = asObject(raw, "environment.one");
  const list = object.compose ?? object.composes;
  if (!Array.isArray(list)) return invalid("environment.one.compose");
  return list.map((entry, index) => toComposeListEntry(entry, `environment.one.compose[${index}]`));
}

export function parseCompose(raw: unknown): ComposeDetails {
  const object = asObject(raw, "compose.one");
  const status = object.composeStatus;
  if (typeof status !== "string" || !(COMPOSE_STATUSES as readonly string[]).includes(status)) return invalid("compose.one.composeStatus");
  const composeFile = object.composeFile ?? "";
  const env = object.env ?? "";
  if (typeof composeFile !== "string") return invalid("compose.one.composeFile");
  if (typeof env !== "string") return invalid("compose.one.env");
  return { ...toComposeRef(object, "compose.one"), composeStatus: status as ComposeStatus, composeFile, env };
}

export function parseDomains(raw: unknown): DomainRecord[] {
  if (!Array.isArray(raw)) return invalid("domain.byComposeId");
  return raw.map((entry, index) => {
    const object = asObject(entry, `domain[${index}]`);
    if (typeof object.https !== "boolean") return invalid(`domain[${index}].https`);
    return {
      domainId: typeof object.domainId === "string" ? object.domainId : null,
      host: asString(object.host, `domain[${index}].host`),
      serviceName: typeof object.serviceName === "string" ? object.serviceName : null,
      port: typeof object.port === "number" ? object.port : null,
      https: object.https,
      certificateType: asString(object.certificateType, `domain[${index}].certificateType`)
    };
  });
}

export function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) result[match[1]!] = match[2]!;
  }
  return result;
}

export function serializeEnv(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${env[key]}`)
    .join("\n");
}
