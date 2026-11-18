import { createDatabasePool } from "@jev/db";
import {
  AnthropicAdapter,
  CachePolicy,
  DeepSeekAdapter,
  ModelGateway,
  OpenAIAdapter,
  PricingCatalog,
  ProviderCredentialStore,
  ProviderRegistry
} from "@jev/model-gateway";
import {
  CacheAcceptanceError,
  CallObserver,
  assertLiveReady,
  buildCacheAcceptancePlan,
  createGuardedFetch,
  formatPlanText,
  formatReportText,
  runCacheAcceptance
} from "./cache-acceptance.js";

// PLT-052 PR 6/6 operator harness. Default: DRY RUN (no network, no database).
// A paid run needs JEV_LIVE_CACHE_ACCEPTANCE=I_AUTHORIZE_CACHE_PAID_CALLS and the
// rest of docs/PLT-052-CACHE-ACCEPTANCE.md. NOT a production agent execution API.
async function main(): Promise<void> {
  const plan = buildCacheAcceptancePlan(process.env);
  if (plan.mode === "dry-run") {
    console.log(formatPlanText(plan));
    return;
  }
  // Every guard runs before the pool, the credentials or the first request.
  assertLiveReady(plan);
  const live = plan.live!;
  const pricing = PricingCatalog.fromJson(process.env.JEV_MODEL_PRICING_JSON);
  const observer = new CallObserver();
  // At most one network request per logical call; nothing outside a call.
  const guardedFetch = createGuardedFetch(fetch, observer);
  const registry = new ProviderRegistry()
    .register(new OpenAIAdapter(guardedFetch))
    .register(new DeepSeekAdapter(guardedFetch))
    .register(new AnthropicAdapter(guardedFetch));
  // The harness forces the cache on (1h project, 5m task) and ignores JEV_PROMPT_CACHE.
  const policy = new CachePolicy(true, ["anthropic", "openai", "deepseek"], "1h", "5m");
  const pool = createDatabasePool();
  try {
    const store = new ProviderCredentialStore(pool, process.env.JEV_SECRET_ENCRYPTION_KEY!);
    const gateway = new ModelGateway(
      pool, store, registry, pricing, 3, 30_000,
      // Alerts carry no prompt or key, but only the code is printed here.
      alert => console.error(`alert: ${alert.code} (${alert.provider})`),
      policy, live.tenantSecret
    );
    const report = await runCacheAcceptance(plan, {
      execute: request => gateway.execute(request),
      listCredentialProviders: async organizationId =>
        (await store.list(organizationId)).map(item => item.provider),
      lookupCacheStatus: async (organizationId, requestId) => {
        const result = await pool.query(
          `SELECT cache_status FROM model_provider_calls
            WHERE organization_id = $1 AND request_id = $2 AND outcome = 'SUCCESS'
            ORDER BY created_at DESC LIMIT 1`,
          [organizationId, requestId]
        );
        return (result.rows[0]?.cache_status as string | null | undefined) ?? null;
      },
      observer,
      pricing,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
    });
    console.log(formatReportText(report));
    console.log(JSON.stringify(report));
    if (report.overall === "FAIL") process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  // Never print provider response bodies, prompts, keys or DB URLs.
  console.error(
    "PLT-052 cache acceptance failed:",
    error instanceof CacheAcceptanceError ? `${error.code}: ${error.message}` : error instanceof Error ? error.name : "UNKNOWN"
  );
  process.exitCode = 1;
});
