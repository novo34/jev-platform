export const REDACTED = "[REDACTED]";

const PATTERNS: RegExp[] = [
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9_]{10,}/g,
  // Header-style lines: the whole value is dropped.
  /(?:authorization|x-api-key)\s*[:=]\s*[^\r\n]*/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g
];

/**
 * Removes the concrete secrets and known credential shapes from any text that
 * leaves this package (error messages, logs, adapter results).
 */
export function sanitizeText(text: string, secrets: readonly string[] = []): string {
  let result = String(text);
  for (const secret of secrets) {
    if (!secret) continue;
    const variants = new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")]);
    for (const variant of variants) if (variant) result = result.split(variant).join(REDACTED);
  }
  for (const pattern of PATTERNS) result = result.replace(pattern, REDACTED);
  // Credentials embedded in URLs (postgres://user:password@host).
  result = result.replace(/:\/\/[^\s/:@]+:[^\s/@]+@/g, `://${REDACTED}@`);
  return result;
}
