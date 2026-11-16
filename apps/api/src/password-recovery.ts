import { createHash, randomBytes } from "node:crypto";
import { hashPassword } from "@jev/auth";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

type SendResetEmail = (recipient: string, url: string) => Promise<void>;

export interface PasswordRecoveryOptions {
  origin: string;
  send: SendResetEmail;
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

function limiter(max: number) {
  let windowEnd = 0;
  let count = 0;
  return () => {
    const now = Date.now();
    if (now >= windowEnd) {
      windowEnd = now + 60_000;
      count = 0;
    }
    return count < max && ++count <= max;
  };
}

export function registerPasswordRecovery(
  app: FastifyInstance, pool: Pool, options?: PasswordRecoveryOptions
): void {
  const admitRequest = limiter(60);
  const admitReset = limiter(30);
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
    if (admitRequest() && deliveries.size < 8) {
      const { organizationId, email } = request.body;
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
    if (!admitReset()) return reply.code(429).send({ error: "RATE_LIMITED" });
    const { token, password } = request.body;
    const result = await pool.query<{ applied: boolean }>(
      "SELECT jev_consume_password_reset($1::text, $2::text) AS applied",
      [digest(token), hashPassword(password)]
    );
    if (!result.rows[0]?.applied) return reply.code(400).send({ error: "INVALID_RESET_TOKEN" });
    return reply.code(204).send();
  });
}
