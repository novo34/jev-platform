import { createHash, randomBytes } from "node:crypto";
import { hashPassword } from "@jev/auth";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

type SendResetEmail = (recipient: string, url: string) => Promise<void>;

export interface PasswordRecoveryOptions {
  origin: string;
  send: SendResetEmail;
  // Cap on in-flight issuances; exists for tests and operational tuning.
  maxPendingDeliveries?: number;
}

export function resendPasswordRecovery(env: NodeJS.ProcessEnv): PasswordRecoveryOptions | undefined {
  const { JEV_RESET_ORIGIN: origin, JEV_RESET_FROM: from, JEV_RESET_RESEND_API_KEY: key } = env;
  if (!origin && !from && !key) return undefined;
  if (!origin || !from || !key) throw new Error("PASSWORD_RECOVERY_CONFIGURATION_INCOMPLETE");
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash) throw new Error("PASSWORD_RECOVERY_ORIGIN_INVALID");
  return {
    origin: url.origin,
    async send(recipient, resetUrl) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from, to: [recipient], subject: "Restablece tu contraseña de JEV",
          text: `Abre este enlace para cambiar tu contraseña de JEV. Caduca en 20 minutos.\n\n${resetUrl}\n\nSi no lo solicitaste, puedes ignorar este correo.`
        })
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("PASSWORD_RECOVERY_DELIVERY_FAILED");
    }
  };
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Per-key fixed windows. Anonymous callers cannot exhaust a shared bucket:
// a full map evicts expired keys first and then the oldest key, which only
// resets that key's counter (the database still throttles issuance per account).
function limiter(max: number, maxKeys = 10_000) {
  const buckets = new Map<string, { end: number; count: number }>();
  return (key: string) => {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.end) {
      buckets.delete(key);
      if (buckets.size >= maxKeys) {
        for (const [stale, entry] of buckets) if (now >= entry.end) buckets.delete(stale);
        if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value!);
      }
      bucket = { end: now + 60_000, count: 0 };
      buckets.set(key, bucket);
    }
    if (bucket.count >= max) return false;
    bucket.count += 1;
    return true;
  };
}

// Secondary bound on fire-and-forget issuance work. Each request costs one
// short query, so only a sustained volumetric flood keeps this saturated.
const MAX_PENDING_DELIVERIES = 32;

export function registerPasswordRecovery(
  app: FastifyInstance, pool: Pool, options?: PasswordRecoveryOptions
): void {
  const maxPending = options?.maxPendingDeliveries ?? MAX_PENDING_DELIVERIES;
  const admitAccount = limiter(3);
  const admitToken = limiter(5);
  // Secondary ceiling on password hashing. Only holders of a live link reach it.
  const admitHashing = limiter(120, 1);
  const deliveries = new Set<Promise<void>>();
  app.addHook("onClose", async () => { await Promise.all(deliveries); });

  app.post<{ Body: { organizationId: string; email: string } }>("/auth/password-recovery", {
    schema: { body: {
      type: "object", additionalProperties: false, required: ["organizationId", "email"],
      properties: {
        organizationId: { type: "string", pattern: "^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$" },
        email: { type: "string", minLength: 3, maxLength: 320 }
      }
    } }
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!options) return reply.code(503).send({ error: "PASSWORD_RECOVERY_UNAVAILABLE" });
    const { organizationId, email } = request.body;
    const account = organizationId.toLowerCase() + ":" + email.trim().toLowerCase();
    // Check capacity first so a dropped request does not consume the account budget.
    if (deliveries.size < maxPending && admitAccount(account)) {
      const delivery = (async () => {
        const token = randomBytes(32).toString("base64url");
        const result = await pool.query<{ recipient: string | null }>(
          "SELECT jev_issue_password_reset($1::uuid, $2::text, $3::text) AS recipient",
          [organizationId, email.trim(), digest(token)]
        );
        const recipient = result.rows[0]?.recipient;
        if (!recipient) return;
        const link = new URL(options.origin);
        link.hash = new URLSearchParams({ reset: token }).toString();
        await options.send(recipient, link.toString());
      })().catch(() => { app.log.warn("Password recovery delivery failed"); })
        .finally(() => { deliveries.delete(delivery); });
      deliveries.add(delivery);
    }
    return reply.code(202).send({ accepted: true });
  });

  app.post<{ Body: { token: string; password: string } }>("/auth/password-reset", {
    schema: { body: {
      type: "object", additionalProperties: false, required: ["token", "password"],
      properties: {
        token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
        password: { type: "string", minLength: 12, maxLength: 1024 }
      }
    } }
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const { token, password } = request.body;
    const tokenHash = digest(token);
    // Unknown or expired links are rejected before scrypt, so random tokens
    // cost one indexed lookup and cannot consume the hashing budget.
    const live = await pool.query(
      "SELECT 1 FROM password_reset_tokens WHERE token_hash = $1 AND expires_at > clock_timestamp()",
      [tokenHash]
    );
    if (!live.rowCount) return reply.code(400).send({ error: "INVALID_RESET_TOKEN" });
    if (!admitToken(tokenHash) || !admitHashing("global")) {
      return reply.code(429).send({ error: "RATE_LIMITED" });
    }
    const result = await pool.query<{ applied: boolean }>(
      "SELECT jev_consume_password_reset($1::text, $2::text) AS applied",
      [tokenHash, hashPassword(password)]
    );
    if (!result.rows[0]?.applied) return reply.code(400).send({ error: "INVALID_RESET_TOKEN" });
    return reply.code(204).send();
  });
}
