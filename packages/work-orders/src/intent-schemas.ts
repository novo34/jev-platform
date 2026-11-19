// Versioned copy of the Foundation JSON Schemas used to validate IntentBrief and
// AcceptanceContract documents (PLT-040).
// Origin: repository novo34/base-skills_klever, files schemas/intent-brief.schema.json
// and schemas/acceptance-contract.schema.json, commit 6e1ab76 (main at 2026-11-19).
// Do not edit by hand: change Foundation first and copy again. The test
// intent-schemas.test.ts pins the SHA-256 of each copy and, when a Foundation
// checkout is available (JEV_FOUNDATION_DIR or a sibling base-skills_klever
// directory), compares them with the source to detect divergence.

export const INTENT_BRIEF_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://klever.local/schemas/intent-brief.schema.json",
  "title": "JEV Intent Brief",
  "type": "object",
  "required": [
    "goal",
    "requested_change",
    "in_scope",
    "out_of_scope",
    "observed_context",
    "assumptions",
    "open_questions",
    "ambiguity_score",
    "change_radius",
    "risk_signals",
    "documentation_depth",
    "clarification_required",
    "evidence_needed"
  ],
  "properties": {
    "goal": {
      "type": "string",
      "minLength": 1
    },
    "requested_change": {
      "type": "string",
      "minLength": 1
    },
    "in_scope": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "out_of_scope": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "observed_context": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "assumptions": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "open_questions": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "ambiguity_score": {
      "type": "number",
      "minimum": 0,
      "maximum": 1
    },
    "change_radius": {
      "enum": [
        "LOCAL",
        "COMPONENT",
        "CROSS_LAYER",
        "ARCHITECTURAL",
        "PRODUCT"
      ]
    },
    "risk_signals": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "uniqueItems": true
    },
    "documentation_depth": {
      "enum": [
        "L0",
        "L1",
        "L2",
        "L3",
        "L4"
      ]
    },
    "clarification_required": {
      "type": "boolean"
    },
    "evidence_needed": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "additionalProperties": false
} as const;

export const ACCEPTANCE_CONTRACT_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://klever.local/schemas/acceptance-contract.schema.json",
  "title": "JEV Acceptance Contract",
  "type": "object",
  "required": [
    "intent_id",
    "acceptance_criteria",
    "constraints",
    "assumptions",
    "non_goals",
    "affected_requirements",
    "compatibility_requirements",
    "required_evidence",
    "unresolved_decisions",
    "specification_depth"
  ],
  "properties": {
    "intent_id": {
      "type": "string",
      "minLength": 1
    },
    "acceptance_criteria": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": [
          "criterion",
          "verification"
        ],
        "properties": {
          "criterion": {
            "type": "string",
            "minLength": 1
          },
          "verification": {
            "type": "string",
            "minLength": 1
          }
        },
        "additionalProperties": false
      }
    },
    "constraints": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "assumptions": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "non_goals": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "affected_requirements": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "compatibility_requirements": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "required_evidence": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "unresolved_decisions": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "specification_depth": {
      "enum": [
        "L0",
        "L1",
        "L2",
        "L3",
        "L4"
      ]
    }
  },
  "additionalProperties": false
} as const;
