import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_CONTRACT_SCHEMA,
  INTENT_BRIEF_SCHEMA,
  IntentAcceptanceError,
  isImplementationBlocked,
  validateAcceptanceContractDocument,
  validateIntentBriefDocument
} from "./index.js";

// Payloads of examples/adaptive/intent-brief.json and acceptance-contract.json
// in novo34/base-skills_klever (commit 6e1ab76).
const intent = () => ({
  goal: "Change a local UI element safely",
  requested_change: "Replace hero image",
  in_scope: ["hero image"],
  out_of_scope: ["layout redesign"],
  observed_context: ["existing hero component"],
  assumptions: [],
  open_questions: [],
  ambiguity_score: 0.1,
  change_radius: "LOCAL",
  risk_signals: [],
  documentation_depth: "L0",
  clarification_required: false,
  evidence_needed: ["browser_runtime_evidence"]
});
const contract = () => ({
  intent_id: "INT-1",
  acceptance_criteria: [
    { criterion: "Hero image is replaced", verification: "browser screenshot" }
  ],
  constraints: [],
  assumptions: [],
  non_goals: ["layout redesign"],
  affected_requirements: [],
  compatibility_requirements: [],
  required_evidence: ["browser screenshot"],
  unresolved_decisions: [],
  specification_depth: "L0"
});

function rejects(fn: () => unknown): IntentAcceptanceError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(IntentAcceptanceError);
    expect((error as IntentAcceptanceError).code).toBe("INVALID_DOCUMENT");
    return error as IntentAcceptanceError;
  }
  throw new Error("expected INVALID_DOCUMENT");
}

describe("IntentBrief validation", () => {
  it("accepts the Foundation example and boundary scores", () => {
    expect(validateIntentBriefDocument(intent())).toEqual(intent());
    for (const ambiguity_score of [0, 1]) {
      expect(() => validateIntentBriefDocument({ ...intent(), ambiguity_score })).not.toThrow();
    }
  });

  it.each([
    ["extra field", { ...intent(), surprise: true }],
    ["missing required field", (({ goal, ...rest }) => rest)(intent())],
    ["empty goal", { ...intent(), goal: "" }],
    ["change_radius out of range", { ...intent(), change_radius: "GLOBAL" }],
    ["documentation_depth out of range", { ...intent(), documentation_depth: "L5" }],
    ["ambiguity_score above 1", { ...intent(), ambiguity_score: 1.01 }],
    ["ambiguity_score below 0", { ...intent(), ambiguity_score: -0.01 }],
    ["ambiguity_score as string", { ...intent(), ambiguity_score: "0.1" }],
    ["clarification_required as string", { ...intent(), clarification_required: "false" }],
    ["duplicate risk_signals", { ...intent(), risk_signals: ["a", "a"] }],
    ["not an object", "intent"],
    ["null", null]
  ])("rejects %s", (_name, document) => {
    const error = rejects(() => validateIntentBriefDocument(document));
    expect(error.details.length).toBeGreaterThan(0);
  });
});

describe("AcceptanceContract validation", () => {
  it("accepts the Foundation example", () => {
    expect(validateAcceptanceContractDocument(contract())).toEqual(contract());
  });

  it.each([
    ["extra field", { ...contract(), surprise: 1 }],
    ["empty acceptance_criteria", { ...contract(), acceptance_criteria: [] }],
    ["criterion without verification", { ...contract(), acceptance_criteria: [{ criterion: "x" }] }],
    ["criterion with extra field", { ...contract(), acceptance_criteria: [{ criterion: "x", verification: "y", extra: 1 }] }],
    ["blank verification", { ...contract(), acceptance_criteria: [{ criterion: "x", verification: "" }] }],
    ["specification_depth out of range", { ...contract(), specification_depth: "L9" }],
    ["empty intent_id", { ...contract(), intent_id: "" }],
    ["missing unresolved_decisions", (({ unresolved_decisions, ...rest }) => rest)(contract())]
  ])("rejects %s", (_name, document) => {
    rejects(() => validateAcceptanceContractDocument(document));
  });
});

describe("isImplementationBlocked", () => {
  const brief = (ambiguity_score: number, clarification_required = false) => ({
    ambiguity_score,
    clarification_required
  });

  it("uses 0.5 as the default threshold (inclusive)", () => {
    expect(isImplementationBlocked(brief(0.49))).toBe(false);
    expect(isImplementationBlocked(brief(0.5))).toBe(true);
    expect(isImplementationBlocked(brief(1))).toBe(true);
    expect(isImplementationBlocked(brief(0))).toBe(false);
  });

  it("blocks whenever clarification_required is true, whatever the score", () => {
    expect(isImplementationBlocked(brief(0, true))).toBe(true);
    expect(isImplementationBlocked(brief(0.49, true))).toBe(true);
  });

  it("accepts a configurable threshold and rejects an invalid one", () => {
    expect(isImplementationBlocked(brief(0.3), 0.3)).toBe(true);
    expect(isImplementationBlocked(brief(0.7), 0.8)).toBe(false);
    for (const bad of [-0.1, 1.1, Number.NaN, Infinity]) {
      expect(() => isImplementationBlocked(brief(0.1), bad)).toThrow(RangeError);
    }
  });
});

describe("versioned Foundation schemas", () => {
  const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

  it("match the pinned copy of Foundation commit 6e1ab76", () => {
    expect(sha(INTENT_BRIEF_SCHEMA)).toBe(
      "4da899aaa985ec5e003460fa8fa2ff2204039be01a3a9f9ba46940ad0a2c3f6e"
    );
    expect(sha(ACCEPTANCE_CONTRACT_SCHEMA)).toBe(
      "94b50e1bf04ee732d2ec74c2cf05f33a5f3f81988427b90e697d9eb7bef1109c"
    );
  });

  // Divergence detector: runs only where a Foundation checkout is available
  // (JEV_FOUNDATION_DIR, or a sibling base-skills_klever directory).
  const foundation =
    process.env.JEV_FOUNDATION_DIR ??
    path.resolve(process.cwd(), "../../../base-skills_klever");
  const available = existsSync(path.join(foundation, "schemas", "intent-brief.schema.json"));

  it.skipIf(!available)("do not diverge from the Foundation checkout", () => {
    for (const [file, copy] of [
      ["intent-brief.schema.json", INTENT_BRIEF_SCHEMA],
      ["acceptance-contract.schema.json", ACCEPTANCE_CONTRACT_SCHEMA]
    ] as const) {
      const source = JSON.parse(readFileSync(path.join(foundation, "schemas", file), "utf8"));
      expect(copy).toEqual(source);
    }
  });
});
