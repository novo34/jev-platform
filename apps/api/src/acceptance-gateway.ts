import { randomUUID } from "node:crypto";
import { createDatabasePool } from "@jev/db";
import {
  ModelGateway,
  PricingCatalog,
  ProviderCredentialStore,
  createDefaultProviderRegistry
} from "@jev/model-gateway";

// Explicit, single-call operator acceptance; NOT a production agent execution API.
// Never accept arbitrary prompts or fallbacks in this harness.
async function main(): Promise<void> {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.JEV_LIVE_PROVIDER_ACCEPTANCE !== "I_AUTHORIZE_ONE_PAID_CALL"
  ) {
    throw new Error("Explicit development-only paid-call consent is required");
  }

  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required");
  const parsed = new URL(rawUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      parsed.search || parsed.hash) {
    throw new Error("Only an isolated local PostgreSQL database is allowed");
  }

  const provider = process.env.JEV_ACCEPT_PROVIDER;
  if (provider !== "openai" && provider !== "deepseek") {
    throw new Error("JEV_ACCEPT_PROVIDER must be openai or deepseek");
  }
  const model = process.env.JEV_ACCEPT_MODEL;
  if (!model || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)) {
    throw new Error("A valid explicit JEV_ACCEPT_MODEL is required");
  }
  const ids = [
    process.env.JEV_ACCEPT_ORGANIZATION_ID,
    process.env.JEV_ACCEPT_PROJECT_ID,
    process.env.JEV_ACCEPT_TASK_ID
  ].map(value => value?.toLowerCase());
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (ids.some(id => !id || !uuid.test(id))) {
    throw new Error("Existing organization, project and task UUIDs are required");
  }

  const pricing = PricingCatalog.fromJson(process.env.JEV_MODEL_PRICING_JSON);
  if (!pricing.has(provider, model)) {
    throw new Error("Verified CHF pricing is required before paid acceptance");
  }
  if (!process.env.JEV_SECRET_ENCRYPTION_KEY) {
    throw new Error("JEV_SECRET_ENCRYPTION_KEY is required");
  }

  const pool = createDatabasePool();
  try {
    // No seed, migration or credential edits. Existing scoped records only.
    const gateway = new ModelGateway(
      pool,
      new ProviderCredentialStore(pool, process.env.JEV_SECRET_ENCRYPTION_KEY),
      createDefaultProviderRegistry(),
      pricing
    );
    const requestId = randomUUID();
    const result = await gateway.execute({
      requestId,
      organizationId: ids[0]!,
      projectId: ids[1]!,
      taskId: ids[2]!,
      agentRole: "operator-acceptance",
      prompt: "Reply with OK.",
      targets: [{ provider, model }],
      maxOutputTokens: 16,
      timeoutMs: 15_000,
      maxRetries: 0
    });
    // Query all request-linked rows; filtering invalid evidence before counting hides duplicates.
    const [calls, costs, rounded] = await Promise.all([
      pool.query(
        `SELECT provider, model, outcome, attempt_count, usage, estimated_cost_chf, task_id, project_id
           FROM model_provider_calls
          WHERE request_id = $1 AND organization_id = $2`,
        [requestId, ids[0]]
      ),
      pool.query(
        `SELECT provider, model, currency, amount, usage, task_id, project_id
           FROM cost_events
          WHERE organization_id = $1 AND usage->>'requestId' = $2`,
        [ids[0], requestId]
      ),
      pool.query("SELECT ROUND($1::numeric, 6)::text AS chf", [result.estimatedCostChf])
    ]);
    const persisted = calls.rows[0];
    const cost = costs.rows[0];
    // PostgreSQL NUMERIC rounding is decimal and rounds positive half-micro CHF away from zero.
    const expectedChf = rounded.rows[0]?.chf;
    const validUsage = (usage: unknown): usage is {
      inputTokens: number; outputTokens: number; totalTokens: number;
    } => {
      if (typeof usage !== "object" || usage === null) return false;
      const u = usage as Record<string, unknown>;
      return ["inputTokens", "outputTokens", "totalTokens"].every(
        key => typeof u[key] === "number" && Number.isSafeInteger(u[key]) && (u[key] as number) >= 0
      );
    };
    if (
      result.provider !== provider ||
      result.model !== model ||
      result.attempts !== 1 ||
      calls.rowCount !== 1 ||
      costs.rowCount !== 1 ||
      persisted?.task_id !== ids[2] ||
      persisted?.project_id !== ids[1] ||
      persisted?.provider !== result.provider ||
      persisted?.model !== result.model ||
      persisted?.outcome !== "SUCCESS" ||
      persisted?.attempt_count !== result.attempts ||
      !validUsage(persisted?.usage) ||
      !validUsage(result.usage) ||
      !Number.isFinite(Number(persisted?.estimated_cost_chf)) ||
      Number(persisted?.estimated_cost_chf) !== Number(expectedChf) ||
      cost?.task_id !== ids[2] ||
      cost?.project_id !== ids[1] ||
      cost?.provider !== result.provider ||
      cost?.model !== result.model ||
      cost?.currency !== "CHF" ||
      !Number.isFinite(Number(cost?.amount)) ||
      Number(cost?.amount) !== Number(expectedChf) ||
      !validUsage(cost?.usage) ||
      cost?.usage?.requestId !== requestId ||
      ["inputTokens", "outputTokens", "totalTokens"].some(
        key => persisted?.usage?.[key] !== result.usage[key as keyof typeof result.usage] ||
          cost?.usage?.[key] !== result.usage[key as keyof typeof result.usage]
      )
    ) {
      throw new Error("Paid-call persistence acceptance failed");
    }
    console.log(JSON.stringify({
      ok: true,
      requestId,
      provider: result.provider,
      model: result.model,
      attempts: result.attempts,
      usage: result.usage,
      estimatedCostChf: result.estimatedCostChf,
      persistedCall: true,
      persistedCostEvent: true
    }));
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  // Never print provider response bodies, prompts, keys or DB URLs.
  console.error("PLT-009 acceptance failed:", error instanceof Error ? error.name : "UNKNOWN");
  process.exitCode = 1;
});
