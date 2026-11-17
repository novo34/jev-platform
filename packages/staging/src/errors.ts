import { sanitizeText } from "./sanitize.js";

export type DokployErrorCode =
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "upstream"
  | "timeout"
  | "invalid_response";

/** Typed Dokploy failure. The message is always sanitized before construction. */
export class DokployError extends Error {
  readonly code: DokployErrorCode;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: DokployErrorCode,
    message: string,
    options: { status?: number | null; retryAfterSeconds?: number | null; secrets?: readonly string[] } = {}
  ) {
    super(sanitizeText(message, options.secrets ?? []));
    this.name = "DokployError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export function codeForStatus(status: number): DokployErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  return "upstream";
}

/** The Dokploy compose (or one of its hosts) belongs to another project/repository. Nothing has been modified. */
export class StagingOwnershipError extends Error {
  readonly code = "staging_resource_owned_by_other_project";
  constructor() {
    super("staging_resource_owned_by_other_project");
    this.name = "StagingOwnershipError";
  }
}

/** More than one compose of the environment matches the expected name/appName. Nothing is adopted or modified. */
export class StagingAmbiguousComposeError extends Error {
  readonly code = "staging_compose_ambiguous";
  constructor(readonly count: number) {
    super("staging_compose_ambiguous");
    this.name = "StagingAmbiguousComposeError";
  }
}
