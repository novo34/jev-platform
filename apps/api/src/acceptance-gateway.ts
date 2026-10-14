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
  ];
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
    const evidence = await pool.query(
      `SELECT c.provider, c.model, c.outcome,
              c.usage, c.estimated_cost_chf,
              (SELECT COUNT(*)::int FROM cost_events e
                WHERE e.organization_id = c.organization_id
                  AND e.task_id = c.task_id
                  AND e.provider = c.provider
                  AND e.model = c.model
                  AND e.currency = 'CHF'
                  AND e.amount = c.estimated_cost_chf
                  AND e.usage->>'requestId' = c.request_id
                  AND e.usage->>'inputTokens' = c.usage->>'inputTokens'
                  AND e.usage->>'outputTokens' = c.usage->>'outputTokens'
                  AND e.usage->>'totalTokens' = c.usage->>'totalTokens') AS cost_event_count
         FROM model_provider_calls c
        WHERE c.request_id = $1 AND c.organization_id = $2
        LIMIT 1`,
      [requestId, ids[0]]
    );
    const persisted = evidence.rows[0];
    if (
      result.provider !== provider ||
      result.model !== model ||
      result.attempts !== 1 ||
      evidence.rowCount !== 1 ||
      persisted?.provider !== result.provider ||
      persisted?.model !== result.model ||
      persisted?.outcome !== "SUCCESS" ||
      persisted?.cost_event_count !== 1 ||
      Number(persisted?.estimated_cost_chf) !== result.estimatedCostChf ||
      persisted?.usage?.inputTokens !== result.usage.inputTokens ||
      persisted?.usage?.outputTokens !== result.usage.outputTokens ||
      persisted?.usage?.totalTokens !== result.usage.totalTokens
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
