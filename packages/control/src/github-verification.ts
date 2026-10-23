import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { GitHubError } from "./github-app.js";

// A trust root configured by the operator, never supplied by a command or report.
// The private key belongs exclusively to the independent verification process.
const trustSchema = z.array(z.object({ keyId: z.string().min(1).max(128),
  issuer: z.string().min(1).max(128), purpose: z.literal("independent_verifier"),
  publicKey: z.string().max(8192).startsWith("-----BEGIN PUBLIC KEY-----") }).strict()).max(32);
const reportSchema = z.object({ version: z.literal(1), keyId: z.string(), issuer: z.string(),
  organizationId: z.uuid(), projectId: z.uuid(), repositoryId: z.uuid(), taskId: z.uuid(), verificationCycleId: z.uuid(),
  repositoryFullName: z.string(), pullRequestNumber: z.number().int().positive(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/), result: z.literal("PASS"),
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime() }).strict();
const envelopeSchema = z.object({ payload: z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export const GITHUB_VERIFICATION_DOMAIN = "JEV/PLT-010/technical-verification/v1\n";
export type GitHubVerificationScope = Pick<z.infer<typeof reportSchema>,
  "organizationId" | "projectId" | "repositoryId" | "taskId" | "verificationCycleId" | "repositoryFullName" | "pullRequestNumber" | "commitSha">;

/** Signature verification only; Task lifecycle/history remains the canonical writer. */
export class GitHubTechnicalVerification {
  private readonly keys = new Map<string, { issuer: string; key: KeyObject }>();
  constructor(configuration: unknown = []) {
    try {
      for (const item of trustSchema.parse(configuration)) {
        const key = createPublicKey(item.publicKey);
        if (key.asymmetricKeyType !== "ed25519" || this.keys.has(item.keyId)) throw new Error("invalid key");
        this.keys.set(item.keyId, { issuer: item.issuer, key });
      }
    } catch { throw new GitHubError("GITHUB_INVALID_CONFIGURATION"); }
  }

  assert(evidence: unknown, scope: GitHubVerificationScope, cycleStartedAt: Date, recordedAt: Date, now = Date.now()): void {
    try {
      const envelope = envelopeSchema.parse(evidence);
      const payload = Buffer.from(envelope.payload, "base64url");
      if (payload.toString("base64url") !== envelope.payload) throw new Error("noncanonical payload");
      const report = reportSchema.parse(JSON.parse(payload.toString("utf8")));
      const trusted = this.keys.get(report.keyId);
      if (!trusted || trusted.issuer !== report.issuer || !verify(null,
        Buffer.concat([Buffer.from(GITHUB_VERIFICATION_DOMAIN), payload]), trusted.key,
        Buffer.from(envelope.signature, "base64url"))) throw new Error("untrusted report");
      for (const key of Object.keys(scope) as Array<keyof GitHubVerificationScope>) {
        if (report[key] !== scope[key]) throw new Error("scope mismatch");
      }
      const issued = Date.parse(report.issuedAt), expires = Date.parse(report.expiresAt);
      if (issued < cycleStartedAt.getTime() || issued > recordedAt.getTime() + 1000 || issued > now ||
          expires <= now || expires <= issued || expires - issued > 86_400_000) throw new Error("stale report");
    } catch { throw new GitHubError("GITHUB_FORBIDDEN"); }
  }
}
