import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import {
  MODEL_PROVIDERS,
  ModelGatewayError,
  type ModelProvider,
  type ProviderCredentialMetadata
} from "./types.js";

function parseKey(value: string | undefined): Buffer {
  if (!value) {
    throw new ModelGatewayError(
      "SECRET_STORE_UNAVAILABLE",
      "JEV_SECRET_ENCRYPTION_KEY is required"
    );
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    throw new ModelGatewayError(
      "SECRET_STORE_UNAVAILABLE",
      "JEV_SECRET_ENCRYPTION_KEY must be 32 bytes encoded as base64"
    );
  }
  return decoded;
}

function assertProvider(provider: string): asserts provider is ModelProvider {
  if (!MODEL_PROVIDERS.includes(provider as ModelProvider)) {
    throw new ModelGatewayError("INVALID_REQUEST", "unsupported provider");
  }
}

export class ProviderCredentialStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionKey?: string
  ) {}

  async configure(
    organizationId: string,
    providerInput: string,
    secretInput: string,
    actorUserId: string
  ): Promise<ProviderCredentialMetadata> {
    assertProvider(providerInput);
    const secret = secretInput.trim();
    if (secret.length < 8) {
      throw new ModelGatewayError("INVALID_REQUEST", "provider credential is too short");
    }

    const key = parseKey(this.encryptionKey);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const lastFour = secret.slice(-4);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<{ updated_at: Date }>(
        `INSERT INTO provider_credentials (
           organization_id, provider, ciphertext, iv, auth_tag, last_four, configured_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (organization_id, provider)
         DO UPDATE SET
           ciphertext = EXCLUDED.ciphertext,
           iv = EXCLUDED.iv,
           auth_tag = EXCLUDED.auth_tag,
           last_four = EXCLUDED.last_four,
           configured_by = EXCLUDED.configured_by,
           updated_at = NOW()
         RETURNING updated_at`,
        [
          organizationId,
          providerInput,
          ciphertext.toString("base64"),
          iv.toString("base64"),
          authTag.toString("base64"),
          lastFour,
          actorUserId
        ]
      );

      await client.query(
        `INSERT INTO audit_events (
           organization_id, actor_type, actor_id, action, target_type,
           target_id, result, evidence
         ) VALUES ($1, 'USER', $2, 'PROVIDER_CREDENTIAL_CONFIGURED',
                   'PROVIDER_CREDENTIAL', $3, 'SUCCESS', $4::jsonb)`,
        [
          organizationId,
          actorUserId,
          providerInput,
          JSON.stringify({ provider: providerInput, lastFour })
        ]
      );
      await client.query("COMMIT");

      return {
        provider: providerInput,
        configured: true,
        lastFour,
        updatedAt: result.rows[0].updated_at.toISOString()
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async list(organizationId: string): Promise<ProviderCredentialMetadata[]> {
    const result = await this.pool.query<{
      provider: ModelProvider;
      last_four: string;
      updated_at: Date;
    }>(
      `SELECT provider, last_four, updated_at
         FROM provider_credentials
        WHERE organization_id = $1
        ORDER BY provider`,
      [organizationId]
    );

    return result.rows.map((row) => ({
      provider: row.provider,
      configured: true,
      lastFour: row.last_four,
      updatedAt: row.updated_at.toISOString()
    }));
  }

  async getSecret(organizationId: string, providerInput: string): Promise<string> {
    assertProvider(providerInput);
    const result = await this.pool.query<{
      ciphertext: string;
      iv: string;
      auth_tag: string;
    }>(
      `SELECT ciphertext, iv, auth_tag
         FROM provider_credentials
        WHERE organization_id = $1 AND provider = $2
        LIMIT 1`,
      [organizationId, providerInput]
    );

    const row = result.rows[0];
    if (!row) {
      throw new ModelGatewayError(
        "PROVIDER_CREDENTIAL_MISSING",
        `credential missing for ${providerInput}`
      );
    }

    const key = parseKey(this.encryptionKey);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(row.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
  }

  async remove(
    organizationId: string,
    providerInput: string,
    actorUserId: string
  ): Promise<void> {
    assertProvider(providerInput);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM provider_credentials WHERE organization_id = $1 AND provider = $2",
        [organizationId, providerInput]
      );
      await client.query(
        `INSERT INTO audit_events (
           organization_id, actor_type, actor_id, action, target_type,
           target_id, result, evidence
         ) VALUES ($1, 'USER', $2, 'PROVIDER_CREDENTIAL_DELETED',
                   'PROVIDER_CREDENTIAL', $3, 'SUCCESS', $4::jsonb)`,
        [
          organizationId,
          actorUserId,
          providerInput,
          JSON.stringify({ provider: providerInput })
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
