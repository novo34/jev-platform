import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  canonicalJson,
  deriveTenantNamespace,
  detectPrefixInstability,
  fingerprintOf,
  type PromptSegment,
  type ToolDefinition
} from "./prompt-builder.js";
import { ModelGatewayError } from "./types.js";

const SECRET = "test-secret-injected";
const T1 = deriveTenantNamespace(SECRET, "org-1", "proj-1");
const T2 = deriveTenantNamespace(SECRET, "org-2", "proj-1");

const base = (): PromptSegment[] => [
  { kind: "input", content: "pregunta" },
  { kind: "history", content: "h1" },
  { kind: "task_context", content: "tarea" },
  { kind: "project_context", content: "proyecto" },
  { kind: "spec", id: "s1", content: "spec" },
  { kind: "skills", id: "k1", content: "skill" },
  { kind: "rules", id: "r1", content: "regla" },
  { kind: "system", content: "sistema" }
];

const kinds = (p: ReturnType<typeof buildPrompt>) => p.blocks.map(b => b.kind);

describe("PLT-052 buildPrompt", () => {
  it("impone el orden canónico sin importar el de entrada", () => {
    expect(kinds(buildPrompt(base(), undefined, T1))).toEqual([
      "system", "rules", "skills", "spec", "project_context", "task_context", "history", "input"
    ]);
  });

  it("es determinista byte a byte", () => {
    const a = buildPrompt(base(), undefined, T1);
    const b = buildPrompt([...base()].reverse(), undefined, T1);
    expect(a.text).toBe(b.text);
    expect(a.prefix_project_sha256).toBe(b.prefix_project_sha256);
    expect(a.prefix_task_sha256).toBe(b.prefix_task_sha256);
  });

  it("conserva CRLF y espacios finales literalmente", () => {
    const content = "linea con dos espacios  \r\nsegunda\r\n  ";
    const p = buildPrompt([{ kind: "system", content }], undefined, T1);
    expect(p.text).toContain(content);
    expect(p.text).toContain(`${T1}\n${content}`);
    const again = buildPrompt([{ kind: "system", content }], undefined, T1);
    expect(Buffer.from(again.projectPrefixText).equals(Buffer.from(p.projectPrefixText))).toBe(true);
    const trimmed = buildPrompt([{ kind: "system", content: content.trimEnd() }], undefined, T1);
    expect(trimmed.prefix_project_sha256).not.toBe(p.prefix_project_sha256);
  });

  it("ordena rules/skills/spec por id y versión en bytes, el resto conserva el orden", () => {
    const rules: PromptSegment[] = [
      { kind: "rules", id: "b", version: "2", content: "b2" },
      { kind: "rules", id: "a", version: "2", content: "a2" },
      { kind: "rules", id: "a", version: "10", content: "a10" }
    ];
    // ids duplicados dentro del kind reordenable se rechazan, así que probamos ids distintos
    expect(() => buildPrompt(rules, undefined, T1)).toThrow(ModelGatewayError);
    const ok: PromptSegment[] = [
      { kind: "system", content: "s" },
      { kind: "rules", id: "b", content: "B" },
      { kind: "rules", id: "Z", content: "Z" },
      { kind: "rules", id: "a", content: "A" },
      { kind: "rules", id: "é", content: "E" }
    ];
    const ids = buildPrompt(ok, undefined, T1).blocks.filter(b => b.kind === "rules").map(b => b.id);
    expect(ids).toEqual(["Z", "a", "b", "é"]);
    const sys = buildPrompt([
      { kind: "system", id: "z", content: "1" },
      { kind: "system", id: "a", content: "2" }
    ], undefined, T1).blocks.map(b => b.id);
    expect(sys).toEqual(["z", "a"]);
  });

  it("conserva history con msg-10 antes que msg-2 y no exige ids únicos", () => {
    const p = buildPrompt([
      { kind: "system", content: "s" },
      { kind: "history", id: "msg-10", content: "diez" },
      { kind: "history", id: "msg-2", content: "dos" },
      { kind: "history", id: "msg-2", content: "dos bis" }
    ], undefined, T1);
    expect(p.blocks.filter(b => b.kind === "history").map(b => b.id)).toEqual(["msg-10", "msg-2", "msg-2"]);
  });

  it("asigna id por defecto kind#posición y version \"1\" sin influir en el orden", () => {
    const p = buildPrompt([
      { kind: "system", content: "s" },
      { kind: "history", content: "a", version: "9" },
      { kind: "history", content: "b" },
      { kind: "history", content: "c" }
    ], undefined, T1);
    const h = p.blocks.filter(b => b.kind === "history");
    expect(h.map(b => b.id)).toEqual(["history#1", "history#2", "history#3"]);
    expect(h.map(b => b.version)).toEqual(["9", "1", "1"]);
  });

  it("rechaza ids duplicados o ausentes en kind reordenables", () => {
    expect(() => buildPrompt([
      { kind: "spec", id: "x", content: "1" }, { kind: "spec", id: "x", version: "2", content: "2" }
    ], undefined, T1)).toThrow(/Duplicate id/);
    for (const kind of ["rules", "skills", "spec"] as const) {
      expect(() => buildPrompt([{ kind, content: "x" }], undefined, T1)).toThrow(/requires an id/);
    }
  });

  it("el cambio de versión cambia el hash de prefijo", () => {
    const v = (version: string) => buildPrompt([{ kind: "rules", id: "r", version, content: "x" }], undefined, T1);
    expect(v("1").prefix_project_sha256).not.toBe(v("2").prefix_project_sha256);
  });

  it("tenants distintos dan prefijos distintos y el ID no aparece en claro", () => {
    const a = buildPrompt(base(), undefined, T1);
    const b = buildPrompt(base(), undefined, T2);
    expect(a.prefix_project_sha256).not.toBe(b.prefix_project_sha256);
    expect(a.prefix_task_sha256).not.toBe(b.prefix_task_sha256);
    expect(a.text).not.toContain("org-1");
    expect(deriveTenantNamespace(SECRET, "org-1", "proj-1")).toBe(T1);
    expect(deriveTenantNamespace("otro", "org-1", "proj-1")).not.toBe(T1);
    expect(deriveTenantNamespace(SECRET, "a", "bc")).not.toBe(deriveTenantNamespace(SECRET, "ab", "c"));
    expect(() => deriveTenantNamespace("", "o", "p")).toThrow(ModelGatewayError);
  });

  it("tenant ausente o en claro se rechaza; el namespace es el primer texto tras tools y no es segmento", () => {
    expect(() => buildPrompt(base(), undefined, undefined as unknown as string)).toThrow(ModelGatewayError);
    expect(() => buildPrompt(base(), undefined, "org-1")).toThrow(ModelGatewayError);
    const p = buildPrompt(base(), undefined, T1);
    expect(p.blocks).toHaveLength(8);
    expect(p.blocks[0]!.text).toContain(`jev-tenant-namespace: ${T1}\nsistema`);
    expect(p.blocks.slice(1).some(b => b.text.includes(T1))).toBe(false);
  });

  it("exige un bloque de proyecto no vacío para llevar el namespace", () => {
    expect(() => buildPrompt([{ kind: "input", content: "x" }], undefined, T1)).toThrow(ModelGatewayError);
    expect(() => buildPrompt([{ kind: "system", content: "" }, { kind: "input", content: "x" }], undefined, T1)).toThrow(ModelGatewayError);
  });

  it("tabla kind -> hash: task_context solo en task; history e input en ninguno", () => {
    const run = (extra: PromptSegment[]) => buildPrompt([{ kind: "system", content: "s" }, ...extra], undefined, T1);
    const ref = run([]);
    expect(ref.prefix_task_sha256).toBe(ref.prefix_project_sha256);
    const withTask = run([{ kind: "task_context", content: "t" }]);
    expect(withTask.prefix_project_sha256).toBe(ref.prefix_project_sha256);
    expect(withTask.prefix_task_sha256).not.toBe(ref.prefix_task_sha256);
    const volatile = run([{ kind: "history", content: "h" }, { kind: "input", content: "i" }]);
    expect(volatile.prefix_project_sha256).toBe(ref.prefix_project_sha256);
    expect(volatile.prefix_task_sha256).toBe(ref.prefix_task_sha256);
    const proj = run([{ kind: "project_context", content: "p" }]);
    expect(proj.prefix_project_sha256).not.toBe(ref.prefix_project_sha256);
  });

  it("tools: ordenadas por name, JSON canónico, duplicados rechazados, entran en ambos hashes", () => {
    const t1: ToolDefinition = { name: "b", description: "  d  ", input_schema: { z: 1, a: { y: 2, x: 3 } } };
    const t2: ToolDefinition = { name: "a", input_schema: { type: "object" } };
    const segs: PromptSegment[] = [{ kind: "system", content: "s" }];
    const p = buildPrompt(segs, [t1, t2], T1);
    const q = buildPrompt(segs, [t2, t1], T1);
    expect(p.text).toBe(q.text);
    expect(p.toolsText.indexOf('"name":"a"')).toBeLessThan(p.toolsText.indexOf('"name":"b"'));
    expect(p.toolsText).toContain('{"description":"  d  ","input_schema":{"a":{"x":3,"y":2},"z":1},"name":"b"}');
    expect(p.text.startsWith(p.toolsText)).toBe(true);
    expect(p.toolsText).not.toContain(T1);
    expect(() => buildPrompt(segs, [t1, { ...t1 }], T1)).toThrow(/Duplicate tool name/);
    const none = buildPrompt(segs, undefined, T1);
    expect(none.toolsText).toBe("");
    expect(p.prefix_project_sha256).not.toBe(none.prefix_project_sha256);
    expect(p.prefix_task_sha256).not.toBe(none.prefix_task_sha256);
  });

  it("canonicalJson ordena claves por bytes y rechaza valores no serializables", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
    expect(() => canonicalJson({ a: Infinity })).toThrow(ModelGatewayError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(ModelGatewayError);
  });

  it("avisa (sin bloquear) de fecha o UUID en segmentos estables y tools, no en input", () => {
    const p = buildPrompt([
      { kind: "system", content: "hoy es 2026-11-18" },
      { kind: "task_context", content: "id 123e4567-e89b-12d3-a456-426614174000" },
      { kind: "input", content: "2026-11-18" }
    ], [{ name: "t", description: "v 2026-01-01", input_schema: {} }], T1);
    expect(p.warnings.map(w => w.source)).toEqual(["tools", "system:system#1@1", "task_context:task_context#1@1"]);
    expect(buildPrompt([{ kind: "system", content: "limpio" }, { kind: "input", content: "2026-11-18" }], undefined, T1).warnings).toEqual([]);
  });

  it("detecta prefijo inestable solo sin cambio declarado de versión o tools", () => {
    const mk = (content: string, version = "1", task = "t") => buildPrompt([
      { kind: "rules", id: "r", version, content },
      { kind: "task_context", content: task }
    ], undefined, T1);
    const first = fingerprintOf(mk("a"));
    expect(detectPrefixInstability(undefined, mk("a"))).toEqual([]);
    expect(detectPrefixInstability(first, mk("a"))).toEqual([]);
    const proj = detectPrefixInstability(first, mk("b"));
    expect(proj.map(w => w.source)).toEqual(["prefix_project_sha256", "prefix_task_sha256"]);
    expect(detectPrefixInstability(first, mk("b", "2"))).toEqual([]);
    const taskOnly = detectPrefixInstability(first, mk("a", "1", "otra"));
    expect(taskOnly.map(w => w.source)).toEqual(["prefix_task_sha256"]);
    const withTools = buildPrompt([{ kind: "system", content: "s" }], [{ name: "n", input_schema: {} }], T1);
    const noTools = buildPrompt([{ kind: "system", content: "s" }], [{ name: "n", input_schema: { a: 1 } }], T1);
    expect(detectPrefixInstability(fingerprintOf(withTools), noTools)).toEqual([]);
  });

  it("segmentRefs distingue ids y versiones que contienen '@' (sin falsos UNSTABLE_PREFIX)", () => {
    const mk = (id: string, version: string) => buildPrompt([{ kind: "rules", id, version, content: "x" }], undefined, T1);
    const a = mk("a@b", "c");
    const b = mk("a", "b@c");
    expect(a.segmentRefs).not.toEqual(b.segmentRefs);
    expect(a.prefix_project_sha256).not.toBe(b.prefix_project_sha256);
    expect(detectPrefixInstability(fingerprintOf(a), b)).toEqual([]);
    expect(detectPrefixInstability(fingerprintOf(b), a)).toEqual([]);
  });

  it("canonicalJson serializa los huecos de un array como null, igual que JSON.stringify", () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    expect(canonicalJson(sparse)).toBe("[1,null,3]");
    expect(canonicalJson(sparse)).toBe(JSON.stringify(sparse));
    expect(canonicalJson({ a: new Array(2) })).toBe('{"a":[null,null]}');
  });

  it("rechaza kinds heredados del prototipo con INVALID_REQUEST", () => {
    for (const kind of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      const segments = [{ kind: "system" as const, content: "s" }, { kind: kind as never, content: "a" }];
      expect(() => buildPrompt(segments, undefined, T1), kind).toThrow(ModelGatewayError);
      try {
        buildPrompt(segments, undefined, T1);
      } catch (error) {
        expect((error as ModelGatewayError).code).toBe("INVALID_REQUEST");
        expect((error as ModelGatewayError).message).toContain("Unknown segment kind");
      }
    }
  });

  it("rechaza kinds desconocidos y UTF-16 mal formado", () => {
    expect(() => buildPrompt([{ kind: "x" as never, content: "a" }], undefined, T1)).toThrow(ModelGatewayError);
    expect(() => buildPrompt([{ kind: "system", content: "\ud800" }], undefined, T1)).toThrow(ModelGatewayError);
  });
});
