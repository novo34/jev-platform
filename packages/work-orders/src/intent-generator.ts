import { randomUUID } from "node:crypto";
import {
  MODEL_PROVIDERS,
  type ModelGatewayRequest,
  type ModelGatewayResult,
  type ModelProvider,
  type ProviderTarget,
  type PromptSegment
} from "@jev/model-gateway";
import { INTENT_BRIEF_SCHEMA } from "./intent-schemas.js";
import { validateIntentBriefDocument } from "./intent-validation.js";
import {
  IntentAcceptanceError,
  IntentGenerationError,
  type IntentBriefDocument
} from "./types.js";

// PLT-040 PR 4: automatic IntentBrief generation. The Model Gateway is INJECTED
// (structurally typed: ModelGateway satisfies it); nothing here calls a provider
// by itself and nothing reads credentials. Gateway errors (PRICING_REQUIRED,
// credentials, circuit...) propagate unchanged: they are never retried here.

export const INTENT_PROMPT_VERSION = "1";

export interface IntentModelGateway {
  execute(request: ModelGatewayRequest): Promise<ModelGatewayResult>;
}

export interface GenerateIntentInput {
  /** Order text / objective. */
  objective: string;
  organizationId: string;
  projectId: string;
  /**
   * Task the gateway bills the call to. The gateway checks that the task exists
   * and belongs to the project, so the caller must supply an existing one
   * (e.g. an intake task of the project); see PROGRESO.md.
   */
  taskId: string;
  orderId?: string;
  projectName?: string;
  /** Order requirements, one text each (key, title and description). Volatile: sent in the input segment. */
  knownRequirements?: string[];
  /** Order constraints as text. Volatile: sent in the input segment. */
  constraints?: string[];
  /** Order acceptance criteria. Volatile: sent in the input segment. */
  acceptanceCriteria?: string[];
}

export interface GeneratedIntent {
  document: IntentBriefDocument;
  /** 1 or 2 (one validation retry at most). */
  attempts: number;
  provider: ModelProvider;
  model: string;
}

export interface IntentBriefGeneratorOptions {
  gateway: IntentModelGateway;
  /** Explicit targets; otherwise JEV_INTENT_MODEL ("provider:model[,provider:model]"). */
  targets?: ProviderTarget[];
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Injectable for deterministic tests. */
  newRequestId?: () => string;
}

export function parseIntentModelTargets(raw: string): ProviderTarget[] {
  const targets: ProviderTarget[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const index = entry.indexOf(":");
    const provider = index > 0 ? entry.slice(0, index).trim() : "";
    const model = index > 0 ? entry.slice(index + 1).trim() : "";
    if (!(MODEL_PROVIDERS as readonly string[]).includes(provider) || !model) {
      throw new IntentGenerationError(
        "INTENT_MODEL_NOT_CONFIGURED",
        `invalid JEV_INTENT_MODEL entry "${entry}" (expected provider:model)`
      );
    }
    targets.push({ provider: provider as ModelProvider, model });
  }
  if (targets.length === 0) {
    throw new IntentGenerationError(
      "INTENT_MODEL_NOT_CONFIGURED",
      "no intent model configured (set JEV_INTENT_MODEL=provider:model or pass targets)"
    );
  }
  return targets;
}

const SYSTEM_TEXT = [
  "You turn a work order request into an IntentBrief JSON document.",
  "Reply with ONE JSON object and nothing else: no prose, no markdown, no code fences.",
  "The object MUST validate against this JSON Schema (additionalProperties is false: never add fields, never omit required ones):",
  JSON.stringify(INTENT_BRIEF_SCHEMA)
].join("\n");

const RULES_TEXT = [
  "Anti-silence rule: when you cannot decide something from the request, DECLARE the ambiguity; never infer or invent it.",
  "- Put every undecided point in open_questions.",
  "- Raise ambiguity_score (0 to 1) proportionally; use 0.5 or more when a material decision is unknown.",
  "- Set clarification_required to true when an open question blocks safe implementation.",
  "- Put in assumptions only what the request states or implies without doubt.",
  "- observed_context may only contain facts given in the request or the project context below; never invent repository facts.",
  "- When in doubt, choose the wider change_radius, the deeper documentation_depth and the higher ambiguity_score."
].join("\n");

/** Deterministic segments: stable first (system, rules, project context), volatile input last. */
export function buildIntentSegments(
  input: Pick<GenerateIntentInput, "objective" | "projectName" | "knownRequirements" | "constraints" | "acceptanceCriteria">,
  retry?: { previousOutput: string; validationError: string }
): PromptSegment[] {
  const segments: PromptSegment[] = [
    { kind: "system", id: "intent-system", version: INTENT_PROMPT_VERSION, content: SYSTEM_TEXT },
    { kind: "rules", id: "intent-rules", version: INTENT_PROMPT_VERSION, content: RULES_TEXT }
  ];
  const contextLines: string[] = [];
  if (input.projectName?.trim()) contextLines.push(`Project name: ${input.projectName.trim()}`);
  if (contextLines.length) {
    segments.push({ kind: "project_context", id: "intent-project", content: contextLines.join("\n") });
  }
  // Order-specific texts are volatile, so they go in the input segment (after the stable prefix).
  const clean = (items?: string[]) => (items ?? []).map((r) => r.trim()).filter(Boolean);
  const lines = ["Work order request:", input.objective.trim()];
  for (const [title, items] of [
    ["Requirements:", clean(input.knownRequirements)],
    ["Constraints:", clean(input.constraints)],
    ["Acceptance criteria:", clean(input.acceptanceCriteria)]
  ] as const) {
    if (items.length) lines.push("", title, ...items.map((r) => `- ${r}`));
  }
  if (retry) {
    lines.push(
      "",
      "Your previous answer was rejected.",
      `Previous answer: ${retry.previousOutput}`,
      `Validation error: ${retry.validationError}`,
      "Reply again with ONE corrected JSON object."
    );
  }
  segments.push({ kind: "input", id: "intent-input", content: lines.join("\n") });
  return segments;
}

export interface ClarifyIntentInput extends GenerateIntentInput {
  /** Current (blocking) brief the model must update. */
  brief: IntentBriefDocument;
}

const CLARIFY_RULES_TEXT = [
  "Clarification task: you receive a CURRENT IntentBrief that is blocked by open questions, plus all the context available for the work order.",
  "Reply with ONE UPDATED IntentBrief JSON object (same schema, same rules, nothing else).",
  "Anti-invention rule: you may resolve an open question ONLY with information that is explicitly PRESENT in the work order text, requirements, constraints, acceptance criteria or project name below.",
  "- If the context answers a question, remove it from open_questions and record the answer in assumptions or observed_context.",
  "- If the context does NOT answer it, KEEP the question in open_questions and keep ambiguity_score and clarification_required as they are (or higher). Never guess, never invent facts.",
  "- Lower ambiguity_score or set clarification_required to false ONLY when every question that blocked implementation is answered by the context."
].join("\n");

/** Stable prefix (system, rules, clarify rules, project); volatile brief and context last. */
export function buildClarifySegments(
  input: Pick<ClarifyIntentInput, "objective" | "projectName" | "knownRequirements" | "constraints" | "acceptanceCriteria" | "brief">,
  retry?: { previousOutput: string; validationError: string }
): PromptSegment[] {
  const segments = buildIntentSegments(input, retry);
  const last = segments.pop()!;
  const rulesIndex = segments.findIndex((s) => s.id === "intent-rules");
  segments.splice(rulesIndex + 1, 0, {
    kind: "rules", id: "intent-clarify-rules", version: INTENT_PROMPT_VERSION, content: CLARIFY_RULES_TEXT
  });
  const open = input.brief.open_questions;
  segments.push({
    ...last,
    id: "intent-clarify-input",
    content: [
      last.content.split("\n\nYour previous answer was rejected.")[0],
      "",
      "Current IntentBrief:",
      JSON.stringify(input.brief),
      "",
      "Open questions to resolve (only from the context above):",
      ...(open.length ? open.map((q) => `- ${q}`) : ["- (none listed; ambiguity_score or clarification_required still blocks)"]),
      ...(retry
        ? [
            "",
            "Your previous answer was rejected.",
            `Previous answer: ${retry.previousOutput}`,
            `Validation error: ${retry.validationError}`,
            "Reply again with ONE corrected JSON object."
          ]
        : [])
    ].join("\n")
  });
  return segments;
}

function parseStrict(content: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(content.trim()) };
  } catch (error) {
    return { error: `response is not valid JSON: ${(error as Error).message}` };
  }
}

export class IntentBriefGenerator {
  private readonly gateway: IntentModelGateway;
  private readonly explicitTargets?: ProviderTarget[];
  private readonly maxOutputTokens: number;
  private readonly timeoutMs?: number;
  private readonly newRequestId: () => string;

  constructor(options: IntentBriefGeneratorOptions) {
    this.gateway = options.gateway;
    this.explicitTargets = options.targets;
    this.maxOutputTokens = options.maxOutputTokens ?? 2000;
    this.timeoutMs = options.timeoutMs;
    this.newRequestId = options.newRequestId ?? randomUUID;
  }

  async generate(input: GenerateIntentInput): Promise<GeneratedIntent> {
    return this.run(input, "intent", (retry) => buildIntentSegments(input, retry));
  }

  /**
   * PLT-040 PR 5: one clarification round. Same infrastructure as generate
   * (injected gateway, strict parse, ajv, one retry, maxRetries 0). The caller
   * decides how many rounds to run; each round is a separate paid attempt pair.
   */
  async clarify(input: ClarifyIntentInput): Promise<GeneratedIntent> {
    return this.run(input, "clarify", (retry) => buildClarifySegments(input, retry));
  }

  private async run(
    input: GenerateIntentInput,
    label: "intent" | "clarify",
    segmentsFor: (retry?: { previousOutput: string; validationError: string }) => PromptSegment[]
  ): Promise<GeneratedIntent> {
    if (!input.objective?.trim()) {
      throw new IntentGenerationError("INTENT_GENERATION_FAILED", "objective is required");
    }
    const targets =
      this.explicitTargets && this.explicitTargets.length > 0
        ? this.explicitTargets
        : parseIntentModelTargets(process.env.JEV_INTENT_MODEL ?? "");
    const baseId = this.newRequestId();
    let retry: { previousOutput: string; validationError: string } | undefined;
    const failures: string[] = [];

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await this.gateway.execute({
        requestId: `${baseId}-${label}-${attempt}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        orderId: input.orderId,
        taskId: input.taskId,
        agentRole: label === "intent" ? "intent-brief-generator" : "intent-brief-clarifier",
        segments: segmentsFor(retry),
        targets,
        maxOutputTokens: this.maxOutputTokens,
        timeoutMs: this.timeoutMs,
        // No gateway-level retries: any extra paid call is decided here (max one).
        maxRetries: 0
      });
      const parsed = parseStrict(result.content);
      let error = parsed.error;
      if (!error) {
        try {
          const document = validateIntentBriefDocument(parsed.value);
          return { document, attempts: attempt, provider: result.provider, model: result.model };
        } catch (caught) {
          if (!(caught instanceof IntentAcceptanceError)) throw caught;
          error = caught.details.join("; ") || caught.message;
        }
      }
      failures.push(`attempt ${attempt}: ${error}`);
      retry = { previousOutput: result.content.slice(0, 4000), validationError: error };
    }
    throw new IntentGenerationError(
      "INTENT_GENERATION_FAILED",
      `the model did not produce a valid IntentBrief (${label}) after one retry`,
      failures
    );
  }
}
