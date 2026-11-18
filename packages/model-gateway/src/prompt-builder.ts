import { createHash, createHmac } from "node:crypto";
import { ModelGatewayError } from "./types.js";

/** PLT-052 PR 1: constructor determinista del prompt. Sin red, sin proveedores, sin lectura de entorno. */

export type SegmentKind =
  | "system"
  | "rules"
  | "skills"
  | "spec"
  | "project_context"
  | "task_context"
  | "history"
  | "input";

export type Stability = "project" | "task" | "volatile";

export interface PromptSegment {
  kind: SegmentKind;
  id?: string;
  version?: string;
  content: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: unknown;
}

/** Orden canónico fijo tras `tools`. */
export const CANONICAL_KIND_ORDER: readonly SegmentKind[] = [
  "system",
  "rules",
  "skills",
  "spec",
  "project_context",
  "task_context",
  "history",
  "input"
];

export const KIND_STABILITY: Readonly<Record<SegmentKind, Stability>> = {
  system: "project",
  rules: "project",
  skills: "project",
  spec: "project",
  project_context: "project",
  task_context: "task",
  history: "volatile",
  input: "volatile"
};

/** Solo estos kind se ordenan por id y versión; el resto conserva el orden del llamador. */
export const REORDERABLE_KINDS: ReadonlySet<SegmentKind> = new Set<SegmentKind>(["rules", "skills", "spec"]);

export const TENANT_NAMESPACE_HEADER = "jev-tenant-namespace: ";
const TENANT_NAMESPACE_PATTERN = /^[0-9a-f]{64}$/;

export type PromptWarningCode = "VOLATILE_PATTERN_IN_STABLE_SEGMENT" | "UNSTABLE_PREFIX";

export interface PromptWarning {
  code: PromptWarningCode;
  message: string;
  /** Origen: `tools` o `kind:id@version`. */
  source?: string;
}

export interface PromptBlock {
  kind: SegmentKind;
  id: string;
  version: string;
  stability: Stability;
  /** Bytes exactos enviados para este bloque (cabecera + content, con el namespace si procede). */
  text: string;
}

export interface BuiltPrompt {
  /** Bloque de tools (cadena vacía sin tools). */
  toolsText: string;
  blocks: PromptBlock[];
  /** Bytes completos del prompt: tools + bloques en orden canónico. */
  text: string;
  /** tools + tenant_namespace + bloques de estabilidad project. */
  projectPrefixText: string;
  /** projectPrefixText + task_context. */
  taskPrefixText: string;
  prefix_project_sha256: string;
  prefix_task_sha256: string;
  toolsSha256: string;
  /** JSON canónico de [kind, id, version] de cada segmento project/task, en orden de envío (sin ambigüedad aunque id/version contengan separadores). */
  segmentRefs: string[];
  warnings: PromptWarning[];
}

function invalid(message: string): never {
  throw new ModelGatewayError("INVALID_REQUEST", message);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** Comparación por bytes UTF-8, independiente del locale. */
function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function requireWellFormed(value: string, what: string): void {
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)) invalid(`${what} is not well-formed UTF-16 and cannot be sent byte-exact`);
}

/** JSON canónico: claves ordenadas por bytes UTF-8, sin espacios. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      requireWellFormed(value, "JSON string");
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) invalid("Canonical JSON does not accept non-finite numbers");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        // Array.from visita también los huecos (como undefined); JSON.stringify los serializa como null.
        return `[${Array.from(value, (item: unknown) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => compareBytes(a, b));
      return `{${entries.map(([k, v]) => `${canonicalJson(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      return invalid(`Canonical JSON does not accept values of type ${typeof value}`);
  }
}

/** tenant_namespace: HMAC-SHA256 hex. El secreto se inyecta; aquí nunca se lee el entorno. */
export function deriveTenantNamespace(secret: string | Buffer, organizationId: string, projectId: string): string {
  if ((typeof secret === "string" && secret.length === 0) || (Buffer.isBuffer(secret) && secret.length === 0)) {
    invalid("Tenant namespace secret is required");
  }
  if (!organizationId || !projectId) invalid("organizationId and projectId are required for the tenant namespace");
  // Longitud como prefijo: evita ambigüedad entre ("a","bc") y ("ab","c").
  const material = `${Buffer.byteLength(organizationId, "utf8")}:${organizationId}\n${Buffer.byteLength(projectId, "utf8")}:${projectId}`;
  return createHmac("sha256", secret).update(material, "utf8").digest("hex");
}

function buildToolsText(tools: readonly ToolDefinition[] | undefined): string {
  if (!tools || tools.length === 0) return "";
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || tool.name.length === 0) invalid("Every tool requires a non-empty name");
    if (names.has(tool.name)) invalid(`Duplicate tool name: ${tool.name}`);
    if (tool.input_schema === undefined) invalid(`Tool ${tool.name} requires input_schema`);
    names.add(tool.name);
  }
  const sorted = [...tools].sort((a, b) => compareBytes(a.name, b.name));
  return `<<jev:tools count=${sorted.length}>>\n${sorted.map(tool => `${canonicalJson(tool)}\n`).join("")}`;
}

interface ResolvedSegment {
  kind: SegmentKind;
  id: string;
  version: string;
  content: string;
}

function resolveSegments(segments: readonly PromptSegment[]): ResolvedSegment[] {
  const positions = new Map<SegmentKind, number>();
  const resolved: ResolvedSegment[] = [];
  for (const segment of segments) {
    if (!segment || !Object.hasOwn(KIND_STABILITY, segment.kind)) invalid(`Unknown segment kind: ${String(segment?.kind)}`);
    if (typeof segment.content !== "string") invalid(`Segment ${segment.kind} requires string content`);
    requireWellFormed(segment.content, `Segment ${segment.kind} content`);
    const position = (positions.get(segment.kind) ?? 0) + 1;
    positions.set(segment.kind, position);
    if (segment.id !== undefined && (typeof segment.id !== "string" || segment.id.length === 0)) {
      invalid(`Segment ${segment.kind} has an invalid id`);
    }
    if (segment.version !== undefined && (typeof segment.version !== "string" || segment.version.length === 0)) {
      invalid(`Segment ${segment.kind} has an invalid version`);
    }
    if (REORDERABLE_KINDS.has(segment.kind) && segment.id === undefined) {
      invalid(`Segment of kind ${segment.kind} requires an id`);
    }
    const id = segment.id ?? `${segment.kind}#${position}`;
    requireWellFormed(id, "Segment id");
    requireWellFormed(segment.version ?? "", "Segment version");
    resolved.push({ kind: segment.kind, id, version: segment.version ?? "1", content: segment.content });
  }
  const seen = new Set<string>();
  for (const segment of resolved) {
    if (!REORDERABLE_KINDS.has(segment.kind)) continue;
    const key = `${segment.kind}\u0000${segment.id}`;
    if (seen.has(key)) invalid(`Duplicate id "${segment.id}" in kind ${segment.kind}`);
    seen.add(key);
  }
  return resolved;
}

function orderSegments(resolved: ResolvedSegment[]): ResolvedSegment[] {
  const ordered: ResolvedSegment[] = [];
  for (const kind of CANONICAL_KIND_ORDER) {
    const ofKind = resolved.filter(segment => segment.kind === kind); // filter conserva el orden del llamador
    if (REORDERABLE_KINDS.has(kind)) {
      ofKind.sort((a, b) => compareBytes(a.id, b.id) || compareBytes(a.version, b.version));
    }
    ordered.push(...ofKind);
  }
  return ordered;
}

function blockText(segment: ResolvedSegment, content: string): string {
  const header = canonicalJson({
    bytes: Buffer.byteLength(content, "utf8"),
    id: segment.id,
    kind: segment.kind,
    version: segment.version
  });
  return `<<jev:segment ${header}>>\n${content}\n`;
}

const DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function volatileWarning(source: string, text: string): PromptWarning | undefined {
  if (DATE_PATTERN.test(text) || UUID_PATTERN.test(text)) {
    return {
      code: "VOLATILE_PATTERN_IN_STABLE_SEGMENT",
      source,
      message: `Date or UUID pattern found in stable content (${source}); move it to task_context or input`
    };
  }
  return undefined;
}

/**
 * Construye el prompt. `tenant` es el tenant_namespace (HMAC-SHA256 hex de 64 caracteres, ver
 * deriveTenantNamespace); un valor ausente o que no tenga esa forma se rechaza, de modo que un ID en claro nunca llega al prompt.
 * Los avisos (fecha/UUID en contenido estable) no bloquean.
 */
export function buildPrompt(
  segments: readonly PromptSegment[],
  tools: readonly ToolDefinition[] | undefined,
  tenant: string
): BuiltPrompt {
  if (typeof tenant !== "string" || !TENANT_NAMESPACE_PATTERN.test(tenant)) {
    invalid("tenant_namespace is required (64 lowercase hex characters, HMAC-SHA256)");
  }
  if (!Array.isArray(segments)) invalid("segments must be an array");

  const toolsText = buildToolsText(tools);
  const ordered = orderSegments(resolveSegments(segments));

  const firstNonEmpty = ordered.find(segment => segment.content.length > 0);
  if (!firstNonEmpty || KIND_STABILITY[firstNonEmpty.kind] !== "project") {
    invalid("A non-empty system, rules, skills, spec or project_context segment is required to carry the tenant_namespace");
  }

  const warnings: PromptWarning[] = [];
  const toolsWarning = toolsText ? volatileWarning("tools", toolsText) : undefined;
  if (toolsWarning) warnings.push(toolsWarning);

  const blocks: PromptBlock[] = ordered.map(segment => {
    const content = segment === firstNonEmpty
      ? `${TENANT_NAMESPACE_HEADER}${tenant}\n${segment.content}`
      : segment.content;
    const stability = KIND_STABILITY[segment.kind];
    if (stability !== "volatile") {
      const warning = volatileWarning(`${segment.kind}:${segment.id}@${segment.version}`, segment.content);
      if (warning) warnings.push(warning);
    }
    return {
      kind: segment.kind,
      id: segment.id,
      version: segment.version,
      stability,
      text: blockText(segment, content)
    };
  });

  const projectText = blocks.filter(b => b.stability === "project").map(b => b.text).join("");
  const taskText = blocks.filter(b => b.stability === "task").map(b => b.text).join("");
  const projectPrefixText = toolsText + projectText;
  const taskPrefixText = projectPrefixText + taskText;

  return {
    toolsText,
    blocks,
    text: toolsText + blocks.map(b => b.text).join(""),
    projectPrefixText,
    taskPrefixText,
    prefix_project_sha256: sha256Hex(projectPrefixText),
    prefix_task_sha256: sha256Hex(taskPrefixText),
    toolsSha256: sha256Hex(toolsText),
    segmentRefs: blocks.filter(b => b.stability !== "volatile").map(b => canonicalJson([b.kind, b.id, b.version])),
    warnings
  };
}

/** Huella de una llamada para compararla con la anterior de la misma tarea. */
export interface PrefixFingerprint {
  prefix_project_sha256: string;
  prefix_task_sha256: string;
  toolsSha256: string;
  segmentRefs: string[];
}

export function fingerprintOf(built: BuiltPrompt): PrefixFingerprint {
  return {
    prefix_project_sha256: built.prefix_project_sha256,
    prefix_task_sha256: built.prefix_task_sha256,
    toolsSha256: built.toolsSha256,
    segmentRefs: [...built.segmentRefs]
  };
}

/**
 * Alerta de prefijo inestable: un hash de prefijo cambió dentro de la misma tarea sin que cambiaran
 * las tools ni la tripla [kind,id,version] de ningún segmento declarado. Si cambian tools o alguna tripla
 * [kind,id,version], el cambio está declarado y no hay alerta. No bloquea: devuelve avisos.
 */
export function detectPrefixInstability(previous: PrefixFingerprint | undefined, current: BuiltPrompt): PromptWarning[] {
  if (!previous) return [];
  const declaredChange =
    previous.toolsSha256 !== current.toolsSha256 ||
    previous.segmentRefs.length !== current.segmentRefs.length ||
    previous.segmentRefs.some((ref, index) => ref !== current.segmentRefs[index]);
  if (declaredChange) return [];
  const warnings: PromptWarning[] = [];
  if (previous.prefix_project_sha256 !== current.prefix_project_sha256) {
    warnings.push({
      code: "UNSTABLE_PREFIX",
      source: "prefix_project_sha256",
      message: "prefix_project_sha256 changed without a declared version or tools change"
    });
  }
  if (previous.prefix_task_sha256 !== current.prefix_task_sha256) {
    warnings.push({
      code: "UNSTABLE_PREFIX",
      source: "prefix_task_sha256",
      message: "prefix_task_sha256 changed without a declared version or tools change"
    });
  }
  return warnings;
}
