import type { Pool, PoolClient } from "pg";
import {
  validateAcceptanceContractDocument,
  validateIntentBriefDocument
} from "./intent-validation.js";
import {
  IntentAcceptanceError,
  type AcceptanceContractRecord,
  type IntentBriefRecord
} from "./types.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VERSION_ATTEMPTS = 3;

function assertOrganization(organizationId: unknown): asserts organizationId is string {
  if (typeof organizationId !== "string" || !UUID_PATTERN.test(organizationId)) {
    throw new IntentAcceptanceError(
      "INVALID_ORGANIZATION",
      "organizationId must be a UUID"
    );
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** UUIDs are compared case-insensitively by PostgreSQL but stored as lowercase text. */
function canon(value: string): string {
  return value.toLowerCase();
}

/**
 * Per-order lock shared by every writer/reader that must see a consistent
 * "latest IntentBrief version" (saveIntentBrief, reevaluateBlockedTasks).
 * Transaction-scoped advisory lock, released on COMMIT/ROLLBACK.
 *
 * LOCK ORDER (to avoid deadlocks): this advisory lock is ALWAYS acquired first,
 * before any row lock (projects/orders/tasks, including the project-first lock
 * taken inside jev_transition_task / jev_create_task). createOrder creates the
 * order in its own transaction and saves all its versions there: the order id
 * is not visible to anyone else yet, so taking the lock there cannot contend.
 * Never take it after a row lock of the same transaction.
 */
export async function lockOrderIntentVersions(
  db: Pick<PoolClient, "query">,
  orderId: string
): Promise<void> {
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [`jev:intent-order:${canon(orderId)}`]
  );
}

function pgCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: string }).code
    : undefined;
}

function checkViolation(): IntentAcceptanceError {
  return new IntentAcceptanceError(
    "INVALID_DOCUMENT",
    "the document does not match the stored columns (database CHECK violation)"
  );
}

function mapIntent(row: any): IntentBriefRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    orderId: row.order_id,
    version: row.version,
    document: row.document,
    ambiguityScore: Number(row.ambiguity_score),
    changeRadius: row.change_radius,
    documentationDepth: row.documentation_depth,
    clarificationRequired: row.clarification_required,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function mapContract(row: any): AcceptanceContractRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    intentId: row.intent_id,
    orderId: row.order_id,
    version: row.version,
    document: row.document,
    specificationDepth: row.specification_depth,
    createdAt: new Date(row.created_at).toISOString()
  };
}

/**
 * Persistence of IntentBrief and AcceptanceContract (PLT-040 PR 1). Rows are
 * append-only: saving again creates a new version. Every call takes the
 * organization explicitly and never reads or links across organizations.
 */
export class IntentAcceptanceService {
  constructor(private readonly pool: Pool) {}

  async saveIntentBrief(
    organizationId: string,
    input: { orderId?: string | null; document: unknown },
    /**
     * Optional client with an open transaction (PLT-040 PR 3): the order lookup
     * and the INSERT run on it, so the caller can commit the IntentBrief
     * together with its order. Without it, behaviour is unchanged. Inside a
     * transaction a failed INSERT aborts it, so the version retry is skipped.
     */
    executor?: Pick<PoolClient, "query">
  ): Promise<IntentBriefRecord> {
    assertOrganization(organizationId);
    organizationId = canon(organizationId);
    const document = validateIntentBriefDocument(input.document);
    const orderId = input.orderId == null ? null : canon(input.orderId);

    // With an executor the caller owns the transaction (lock held until its
    // COMMIT). Without one, a short own transaction wraps lock + INSERT so the
    // lock is released right after the version is committed.
    // Briefs without an order have no per-order versions to serialize: one INSERT.
    if (executor || orderId === null) {
      const db: Pick<PoolClient, "query"> = executor ?? this.pool;
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.insertBrief(db, organizationId, orderId, document);
        } catch (error) {
          const retry =
            !executor &&
            error instanceof IntentAcceptanceError &&
            error.code === "CONFLICT" &&
            attempt < MAX_VERSION_ATTEMPTS;
          if (!retry) throw error;
        }
      }
    }
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const record = await this.insertBrief(client, organizationId, orderId, document);
        await client.query("COMMIT");
        return record;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (
          error instanceof IntentAcceptanceError &&
          error.code === "CONFLICT" &&
          attempt < MAX_VERSION_ATTEMPTS
        ) {
          continue;
        }
        throw error;
      } finally {
        client.release();
      }
    }
  }

  private async insertBrief(
    db: Pick<PoolClient, "query">,
    organizationId: string,
    orderId: string | null,
    document: ReturnType<typeof validateIntentBriefDocument>
  ): Promise<IntentBriefRecord> {
    if (orderId !== null) {
      // Serialize with other versions and with reevaluateBlockedTasks.
      if (isUuid(orderId)) await lockOrderIntentVersions(db, orderId);
      // orders carry no organization column: it is that of their project.
      const order = isUuid(orderId)
        ? await db.query(
            `SELECT 1 FROM orders o
               JOIN projects p ON p.id = o.project_id
              WHERE o.id = $1 AND p.organization_id = $2`,
            [orderId, organizationId]
          )
        : { rowCount: 0 };
      if (!order.rowCount) {
        throw new IntentAcceptanceError("ORDER_NOT_FOUND", "order not found");
      }
    }

    try {
      const result = await db.query(
        `INSERT INTO intent_briefs (
           organization_id, order_id, version, document, ambiguity_score,
           change_radius, documentation_depth, clarification_required
         ) VALUES (
           $1, $2,
           COALESCE((SELECT MAX(version) FROM intent_briefs WHERE order_id = $2), 0) + 1,
           $3::jsonb, $4, $5, $6, $7
         ) RETURNING *`,
        [
          organizationId,
          orderId,
          JSON.stringify(document),
          document.ambiguity_score,
          document.change_radius,
          document.documentation_depth,
          document.clarification_required
        ]
      );
      return mapIntent(result.rows[0]);
    } catch (error) {
      if (pgCode(error) === "23505") {
        throw new IntentAcceptanceError("CONFLICT", "concurrent IntentBrief version conflict");
      }
      if (pgCode(error) === "23503") {
        throw new IntentAcceptanceError("INVALID_ORGANIZATION", "organization not found");
      }
      if (pgCode(error) === "23514") throw checkViolation();
      throw error;
    }
  }

  async getIntentBrief(
    organizationId: string,
    intentId: string
  ): Promise<IntentBriefRecord> {
    assertOrganization(organizationId);
    organizationId = canon(organizationId);
    const result = isUuid(intentId)
      ? await this.pool.query(
          "SELECT * FROM intent_briefs WHERE id = $1 AND organization_id = $2",
          [canon(intentId), organizationId]
        )
      : { rows: [] };
    if (!result.rows.length) {
      throw new IntentAcceptanceError("INTENT_NOT_FOUND", "intent not found");
    }
    return mapIntent(result.rows[0]);
  }

  /** Latest version of the IntentBrief of an order, or null when it has none. */
  async getLatestIntentBriefForOrder(
    organizationId: string,
    orderId: string,
    /** Client of an open transaction to read on (e.g. after lockOrderIntentVersions). */
    executor?: Pick<PoolClient, "query">
  ): Promise<IntentBriefRecord | null> {
    assertOrganization(organizationId);
    organizationId = canon(organizationId);
    if (!isUuid(orderId)) return null;
    const result = await (executor ?? this.pool).query(
      `SELECT * FROM intent_briefs
        WHERE order_id = $1 AND organization_id = $2
        ORDER BY version DESC LIMIT 1`,
      [canon(orderId), organizationId]
    );
    return result.rows.length ? mapIntent(result.rows[0]) : null;
  }

  /**
   * The document's intent_id must be the id of a stored IntentBrief of the same
   * organization; the order link is copied from that brief.
   */
  async saveAcceptanceContract(
    organizationId: string,
    input: { document: unknown }
  ): Promise<AcceptanceContractRecord> {
    assertOrganization(organizationId);
    organizationId = canon(organizationId);
    const validated = validateAcceptanceContractDocument(input.document);
    if (!isUuid(validated.intent_id)) {
      throw new IntentAcceptanceError("INTENT_NOT_FOUND", "intent not found");
    }
    // Stored and compared in canonical lowercase, as the database CHECK requires.
    const document = { ...validated, intent_id: canon(validated.intent_id) };

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.pool.query(
          `INSERT INTO acceptance_contracts (
             organization_id, intent_id, order_id, version, document,
             specification_depth
           )
           SELECT i.organization_id, i.id, i.order_id,
                  COALESCE((SELECT MAX(c.version) FROM acceptance_contracts c
                             WHERE c.intent_id = i.id), 0) + 1,
                  $3::jsonb, $4
             FROM intent_briefs i
            WHERE i.id = $1 AND i.organization_id = $2
           RETURNING *`,
          [
            document.intent_id,
            organizationId,
            JSON.stringify(document),
            document.specification_depth
          ]
        );
        if (!result.rows.length) {
          throw new IntentAcceptanceError("INTENT_NOT_FOUND", "intent not found");
        }
        return mapContract(result.rows[0]);
      } catch (error) {
        if (pgCode(error) === "23505" && attempt < MAX_VERSION_ATTEMPTS) continue;
        if (pgCode(error) === "23505") {
          throw new IntentAcceptanceError(
            "CONFLICT",
            "concurrent AcceptanceContract version conflict"
          );
        }
        if (pgCode(error) === "23503") {
          throw new IntentAcceptanceError("INTENT_NOT_FOUND", "intent not found");
        }
        if (pgCode(error) === "23514") throw checkViolation();
        throw error;
      }
    }
  }

  async getAcceptanceContract(
    organizationId: string,
    contractId: string
  ): Promise<AcceptanceContractRecord> {
    assertOrganization(organizationId);
    organizationId = canon(organizationId);
    const result = isUuid(contractId)
      ? await this.pool.query(
          "SELECT * FROM acceptance_contracts WHERE id = $1 AND organization_id = $2",
          [canon(contractId), organizationId]
        )
      : { rows: [] };
    if (!result.rows.length) {
      throw new IntentAcceptanceError("INTENT_NOT_FOUND", "contract not found");
    }
    return mapContract(result.rows[0]);
  }

  /** Latest contract version of an intent, or null when it has none. */
  async getLatestAcceptanceContractForIntent(
    organizationId: string,
    intentId: string
  ): Promise<AcceptanceContractRecord | null> {
    assertOrganization(organizationId);
    organizationId = canon(organizationId);
    if (!isUuid(intentId)) return null;
    const result = await this.pool.query(
      `SELECT * FROM acceptance_contracts
        WHERE intent_id = $1 AND organization_id = $2
        ORDER BY version DESC LIMIT 1`,
      [canon(intentId), organizationId]
    );
    return result.rows.length ? mapContract(result.rows[0]) : null;
  }
}
