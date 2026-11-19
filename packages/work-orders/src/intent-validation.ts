import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import {
  ACCEPTANCE_CONTRACT_SCHEMA,
  INTENT_BRIEF_SCHEMA
} from "./intent-schemas.js";
import {
  IntentAcceptanceError,
  type AcceptanceContractDocument,
  type IntentBriefDocument
} from "./types.js";

// additionalProperties=false in the schemas makes extra fields fail. Ajv's
// strict type inference warnings are off because the Foundation schemas use
// bare `enum` keywords; the schemas themselves are pinned by a test.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
const validateIntent = ajv.compile(INTENT_BRIEF_SCHEMA);
const validateContract = ajv.compile(ACCEPTANCE_CONTRACT_SCHEMA);

function describeErrors(
  errors: ErrorObject[] | null | undefined
): string[] {
  return (errors ?? []).map(
    (error: ErrorObject) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
  );
}

export function validateIntentBriefDocument(
  document: unknown
): IntentBriefDocument {
  if (!validateIntent(document)) {
    throw new IntentAcceptanceError(
      "INVALID_DOCUMENT",
      "IntentBrief does not match intent-brief.schema.json",
      describeErrors(validateIntent.errors)
    );
  }
  return document as unknown as IntentBriefDocument;
}

export function validateAcceptanceContractDocument(
  document: unknown
): AcceptanceContractDocument {
  if (!validateContract(document)) {
    throw new IntentAcceptanceError(
      "INVALID_DOCUMENT",
      "AcceptanceContract does not match acceptance-contract.schema.json",
      describeErrors(validateContract.errors)
    );
  }
  return document as unknown as AcceptanceContractDocument;
}

export const DEFAULT_AMBIGUITY_BLOCK_THRESHOLD = 0.5;

/**
 * Fixed blocking rule (operator decision 2026-11-19): implementation is blocked
 * when clarification is required or ambiguity_score >= threshold (default 0.5).
 * Pure; not wired into task creation yet (PLT-040 PR 2).
 */
export function isImplementationBlocked(
  intent: Pick<IntentBriefDocument, "ambiguity_score" | "clarification_required">,
  threshold: number = DEFAULT_AMBIGUITY_BLOCK_THRESHOLD
): boolean {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError("ambiguity threshold must be a number between 0 and 1");
  }
  return (
    intent.clarification_required === true ||
    intent.ambiguity_score >= threshold
  );
}
