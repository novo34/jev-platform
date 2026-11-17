import { randomBytes } from "node:crypto";

export class StagingEnvError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StagingEnvError";
  }
}

const VAR_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** Names that reference production by convention (PROD_*, *_PRODUCTION, ...). */
const PRODUCTION_NAME = /(^|_)PROD(UCTION)?(_|$)/;
const DB_URL = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]*/gi;

export interface EnvGuardOptions {
  /** Host of the staging database inside the Compose network. */
  stagingDbHost: string;
  /** Extra markers (hosts, DB names, URLs) that identify production. */
  productionMarkers?: readonly string[];
}

/**
 * Rejects variables whose name or value points to production (FND-026: staging
 * never receives production values). Any datastore URL must target the
 * project's own staging database host.
 */
export function assertStagingEnv(env: Record<string, string>, options: EnvGuardOptions): void {
  const markers = (options.productionMarkers ?? []).map((m) => m.toLowerCase()).filter(Boolean);
  for (const [name, value] of Object.entries(env)) {
    if (!VAR_NAME.test(name)) throw new StagingEnvError(`env_name_invalid:${name}`);
    if (PRODUCTION_NAME.test(name)) throw new StagingEnvError(`env_production_name_rejected:${name}`);
    if (/[\r\n]/.test(value)) throw new StagingEnvError(`env_value_multiline_rejected:${name}`);
    const lower = value.toLowerCase();
    if (markers.some((marker) => lower.includes(marker))) throw new StagingEnvError(`env_production_value_rejected:${name}`);
    for (const match of value.match(DB_URL) ?? []) {
      let host = "";
      try {
        host = new URL(match).hostname.toLowerCase();
      } catch {
        throw new StagingEnvError(`env_database_url_invalid:${name}`);
      }
      if (host !== options.stagingDbHost.toLowerCase()) throw new StagingEnvError(`env_database_host_not_staging:${name}`);
      if (/(^|[-_.])prod(uction)?([-_.]|$)/.test(match.toLowerCase())) throw new StagingEnvError(`env_production_value_rejected:${name}`);
    }
  }
}

export function randomPassword(): string {
  return randomBytes(24).toString("hex");
}
