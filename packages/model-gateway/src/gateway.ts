import type { Pool } from "pg";
import { ProviderCredentialStore } from "./credentials.js";
import { PricingCatalog } from "./pricing.js";
import { ProviderRegistry } from "./adapters.js";
import { observedCacheStatus } from "./usage.js";
import {
  buildPrompt, deriveTenantNamespace, detectPrefixInstability,
  type BuiltPrompt, type PrefixFingerprint
} from "./prompt-builder.js";
import { CachePolicy, disabledReason, isCacheAttributableError } from "./cache-policy.js";
import {
  ModelGatewayError,
  type AdapterResult,
  type CacheTtl,
  type CacheStatus,
  type ModelGatewayRequest,
  type ModelGatewayResult,
  type ModelProvider,
  type NormalizedUsage,
  type ProviderAdapter
} from "./types.js";
import type { CostEstimate } from "./pricing.js";

export interface GatewayAlert {
  code: "COST_NOT_ESTIMABLE" | "PROMPT_UNSTABLE_CONTENT";
  requestId: string;
  organizationId: string;
  provider: ModelProvider;
  model: string;
  reason: string;
}

// Conservative upper bound of prompt tokens for the pre-call pricing-tier
// check: at least 2 UTF-8 bytes per token (real text is nearer 3.5-4). It only
// ever decides tier rejection; it is never used to price a call.
function estimatePromptTokens(prompt: string): number {
  return Math.ceil(Buffer.byteLength(prompt, "utf8") / 2);
}

// Cache state decided by the gateway itself (switch off, or cache failover),
// as opposed to the state observed from the response.
interface CacheOverride {
  status: CacheStatus;
  reason: string;
}

interface PrefixHashes {
  project: string;
  task: string;
  toolsSha256: string;
  segmentRefs: string[];
}

interface CircuitState {
  failures: number;
  openedAt?: number;
}

export class ModelGateway {
  private readonly circuits = new Map<string, CircuitState>();

  constructor(
    private readonly pool: Pool,
    private readonly credentials: ProviderCredentialStore,
    private readonly providers: ProviderRegistry,
    private readonly pricing: PricingCatalog,
    private readonly circuitFailureThreshold = 3,
    private readonly circuitCooldownMs = 30_000,
    private readonly onAlert: (alert: GatewayAlert) => void = (alert) =>
      console.error(JSON.stringify({ level: "alert", ...alert })),
    // Injected, never read from the environment here. Default: cache marks off.
    private readonly cachePolicy: CachePolicy = CachePolicy.disabled(),
    // Secret of the tenant_namespace HMAC (JEV_TENANT_NAMESPACE_SECRET, read by
    // the caller, never here). Required only for segmented requests.
    private readonly tenantNamespaceSecret?: string
  ) {}

  // Segmented request -> canonical prompt (tenant_namespace per organization and
  // project). Plain `prompt` requests return undefined.
  private buildSegmented(request: ModelGatewayRequest): BuiltPrompt | undefined {
    if (request.segments === undefined) return undefined;
    if (!this.tenantNamespaceSecret) {
      throw new ModelGatewayError(
        "INVALID_REQUEST", "a tenant namespace secret is required for segmented prompts"
      );
    }
    return buildPrompt(
      request.segments,
      request.tools,
      deriveTenantNamespace(this.tenantNamespaceSecret, request.organizationId, request.projectId)
    );
  }

  // Fingerprint of the previous successful segmented call of the SAME task in
  // the SAME organization, read from the call view (never the table). Any
  // failure here is swallowed: measuring never blocks a call (design point 7).
  private async previousFingerprint(
    request: ModelGatewayRequest
  ): Promise<PrefixFingerprint | undefined> {
    try {
      const result = await this.pool.query(
        `SELECT prefix_project_sha256, prefix_task_sha256, prefix_tools_sha256,
                prefix_segment_refs
           FROM model_cache_metrics_by_call
          WHERE organization_id = $1 AND task_id = $2
            AND outcome = 'SUCCESS'
            AND prefix_task_sha256 IS NOT NULL AND prefix_tools_sha256 IS NOT NULL
            AND prefix_segment_refs IS NOT NULL
          ORDER BY created_at DESC, call_id DESC
          LIMIT 1`,
        [request.organizationId, request.taskId]
      );
      const row = result.rows[0] as {
        prefix_project_sha256: string; prefix_task_sha256: string;
        prefix_tools_sha256: string; prefix_segment_refs: unknown;
      } | undefined;
      if (!row || !Array.isArray(row.prefix_segment_refs) ||
          !row.prefix_segment_refs.every(ref => typeof ref === "string")) return undefined;
      return {
        prefix_project_sha256: row.prefix_project_sha256,
        prefix_task_sha256: row.prefix_task_sha256,
        toolsSha256: row.prefix_tools_sha256,
        segmentRefs: row.prefix_segment_refs as string[]
      };
    } catch {
      return undefined;
    }
  }

  private async prefixInstabilityWarnings(
    request: ModelGatewayRequest, built: BuiltPrompt
  ): Promise<ReturnType<typeof detectPrefixInstability>> {
    const previous = await this.previousFingerprint(request);
    return detectPrefixInstability(previous, built);
  }

  private async assertOwnership(request: ModelGatewayRequest): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1
         FROM projects p
         JOIN tasks t ON t.project_id = p.id
         LEFT JOIN orders o ON o.id = t.order_id
        WHERE p.id = $1
          AND p.organization_id = $2
          AND t.id = $3
          AND t.order_id IS NOT DISTINCT FROM $4::uuid
          AND ($4::uuid IS NULL OR o.project_id = p.id)
        LIMIT 1`,
      [
        request.projectId,
        request.organizationId,
        request.taskId,
        request.orderId ?? null
      ]
    );

    if (result.rowCount !== 1) {
      throw new ModelGatewayError(
        "INVALID_REQUEST",
        "organization/project/order/task ownership mismatch"
      );
    }
  }

  private assertRequest(request: ModelGatewayRequest): void {
    if (
      !request.requestId.trim() ||
      !request.organizationId ||
      !request.projectId ||
      !request.taskId ||
      !Array.isArray(request.targets) ||
      request.targets.length === 0 ||
      request.targets.length > 4
    ) {
      throw new ModelGatewayError("INVALID_REQUEST");
    }
    // Exactly one of prompt / segments; tools only with segments.
    if ((request.prompt === undefined) === (request.segments === undefined) ||
        (request.prompt !== undefined && (typeof request.prompt !== "string" || !request.prompt.trim())) ||
        (request.tools !== undefined && request.segments === undefined)) {
      throw new ModelGatewayError(
        "INVALID_REQUEST", "provide exactly one of prompt or segments (tools only with segments)"
      );
    }
    // Bound the fallback graph before credentials or paid execution.
    if (request.targets.some((target) =>
      !target || typeof target.provider !== "string" ||
      typeof target.model !== "string" ||
      !target.provider.trim() || !target.model.trim() ||
      target.model.length > 128
    )) {
      throw new ModelGatewayError("INVALID_REQUEST", "invalid provider target");
    }
    const distinctTargets = new Set(
      request.targets.map((target) => JSON.stringify([target.provider, target.model]))
    );
    if (distinctTargets.size !== request.targets.length) {
      throw new ModelGatewayError("INVALID_REQUEST", "duplicate provider target");
    }
    if (request.maxOutputTokens !== undefined &&
        (!Number.isSafeInteger(request.maxOutputTokens) ||
          request.maxOutputTokens < 1 || request.maxOutputTokens > 32_768)) {
      throw new ModelGatewayError(
        "INVALID_REQUEST", "maxOutputTokens must be an integer between 1 and 32768"
      );
    }
    const timeoutMs = request.timeoutMs ?? 120_000;
    const maxRetries = request.maxRetries ?? 1;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      throw new ModelGatewayError(
        "INVALID_REQUEST",
        "timeoutMs must be a finite integer between 1 and 300000"
      );
    }
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
      throw new ModelGatewayError(
        "INVALID_REQUEST",
        "maxRetries must be a finite integer between 0 and 5"
      );
    }
  }

  private circuitKey(
    organizationId: string,
    provider: ModelProvider,
    model: string
  ): string {
    return `${organizationId}:${provider}:${model}`;
  }

  private assertCircuit(
    organizationId: string,
    provider: ModelProvider,
    model: string
  ): void {
    const key = this.circuitKey(organizationId, provider, model);
    const state = this.circuits.get(key);
    if (!state?.openedAt) return;
    if (Date.now() - state.openedAt >= this.circuitCooldownMs) {
      this.circuits.delete(key);
      return;
    }
    throw new ModelGatewayError(
      "PROVIDER_CIRCUIT_OPEN",
      `circuit open for ${provider}/${model}`
    );
  }

  private success(
    organizationId: string,
    provider: ModelProvider,
    model: string
  ): void {
    this.circuits.delete(this.circuitKey(organizationId, provider, model));
  }

  private failure(
    organizationId: string,
    provider: ModelProvider,
    model: string
  ): void {
    const key = this.circuitKey(organizationId, provider, model);
    const state = this.circuits.get(key) ?? { failures: 0 };
    state.failures += 1;
    if (state.failures >= this.circuitFailureThreshold) {
      state.openedAt = Date.now();
    }
    this.circuits.set(key, state);
  }

  async execute(request: ModelGatewayRequest): Promise<ModelGatewayResult> {
    this.assertRequest(request);
    await this.assertOwnership(request);
    const built = this.buildSegmented(request);
    const promptText = built ? built.text : request.prompt!;
    if (built && !promptText.trim()) throw new ModelGatewayError("INVALID_REQUEST");
    const instability = built ? await this.prefixInstabilityWarnings(request, built) : [];
    for (const warning of [...(built?.warnings ?? []), ...instability]) {
      try {
        this.onAlert({
          code: "PROMPT_UNSTABLE_CONTENT", requestId: request.requestId,
          organizationId: request.organizationId, provider: request.targets[0]!.provider,
          model: request.targets[0]!.model, reason: warning.message
        });
      } catch {
        // Never block on a warning sink (design point 7).
      }
    }
    const hashes: PrefixHashes | undefined = built
      ? {
        project: built.prefix_project_sha256, task: built.prefix_task_sha256,
        toolsSha256: built.toolsSha256, segmentRefs: built.segmentRefs
      }
      : undefined;
    const timeoutMs = request.timeoutMs ?? 120_000;
    const maxRetries = request.maxRetries ?? 1;
    // A per-provider retry limit alone does not cap fallback spending.
    let remainingProviderAttempts = 8;
    let previousProvider: ModelProvider | undefined;
    let lastError: unknown;

    for (const target of request.targets) {
      if (remainingProviderAttempts === 0) break;
      // Every applicable rate (input, output, and cache read for providers that
      // cache automatically) must exist BEFORE any call; never defaulted.
      const cacheDecision = this.cachePolicy.decide(target.provider);
      const registered = this.providers.has(target.provider)
        ? this.providers.get(target.provider) : undefined;
      // JEV only marks the cache for adapters with explicit marks. Rates for the
      // cache of that mode are required before the call, even if the cache
      // later fails over to a call without it (which needs a subset).
      const explicitCache = cacheDecision.enabled && registered?.cacheSupport?.mode === "explicit";
      const cacheOptions = {
        enabled: true, projectTtl: this.cachePolicy.projectTtl, taskTtl: this.cachePolicy.taskTtl
      };
      // Write rate of every TTL the adapter will actually mark (Anthropic: 1h
      // project, 5m task/history), required before the call. A plain-text prompt
      // has no marks, hence no write TTL.
      // Planning can throw (a request this adapter cannot send): that is a
      // blocked target, recorded without a call, and the next target is tried.
      let cacheWriteTtls: CacheTtl[] = [];
      try {
        cacheWriteTtls = explicitCache && registered?.plannedCacheTtls
          ? registered.plannedCacheTtls(built, cacheOptions) : [];
      } catch (error) {
        await this.recordFailure(
          request, target.provider, target.model, "BLOCKED", 0, 0, previousProvider,
          error instanceof ModelGatewayError ? error.code : "INVALID_REQUEST"
        );
        lastError = error;
        previousProvider = target.provider;
        continue;
      }
      if (this.pricing.missingRates(
        target.provider, target.model, { cacheEnabled: explicitCache, cacheWriteTtls }
      ).length > 0) {
        await this.recordFailure(
          request,
          target.provider,
          target.model,
          "BLOCKED",
          0,
          0,
          previousProvider,
          "PRICING_REQUIRED"
        );
        lastError = new ModelGatewayError(
          "PRICING_REQUIRED",
          `pricing is required for ${target.provider}/${target.model}`
        );
        previousProvider = target.provider;
        continue;
      }

      if (this.pricing.exceedsTier(
        target.provider, target.model, estimatePromptTokens(promptText)
      )) {
        await this.recordFailure(
          request,
          target.provider,
          target.model,
          "BLOCKED",
          0,
          0,
          previousProvider,
          "PROMPT_TOO_LARGE_FOR_TIER"
        );
        lastError = new ModelGatewayError(
          "PROMPT_TOO_LARGE_FOR_TIER",
          `prompt is too large for the configured pricing tier of ${target.provider}/${target.model}`
        );
        previousProvider = target.provider;
        continue;
      }

      try {
        this.assertCircuit(
          request.organizationId,
          target.provider,
          target.model
        );
      } catch (error) {
        await this.recordFailure(
          request,
          target.provider,
          target.model,
          "BLOCKED",
          0,
          0,
          previousProvider,
          "PROVIDER_CIRCUIT_OPEN"
        );
        lastError = error;
        previousProvider = target.provider;
        continue;
      }

      let apiKey: string;
      try {
        apiKey = await this.credentials.getSecret(
          request.organizationId,
          target.provider
        );
      } catch (error) {
        await this.recordFailure(
          request,
          target.provider,
          target.model,
          "BLOCKED",
          0,
          0,
          previousProvider,
          error instanceof ModelGatewayError
            ? error.code
            : "PROVIDER_CREDENTIAL_MISSING"
        );
        lastError = error;
        previousProvider = target.provider;
        continue;
      }

      let adapter;
      try {
        adapter = this.providers.get(target.provider);
      } catch (error) {
        const typed =
          error instanceof ModelGatewayError
            ? error
            : new ModelGatewayError("PROVIDER_NOT_REGISTERED");
        await this.recordFailure(
          request,
          target.provider,
          target.model,
          "BLOCKED",
          0,
          0,
          previousProvider,
          typed.code
        );
        lastError = typed;
        previousProvider = target.provider;
        continue;
      }

      const started = Date.now();
      let attempts = 0;
      let response: AdapterResult | undefined;
      // Safe failure (design point 7): ONE retry without cache, only for a
      // cache-attributable rejection. It does not consume the caller's
      // maxRetries, but it does consume the shared 8-attempt budget. Once it
      // has been used, the call without cache is the LAST attempt on this target:
      // a further failure propagates (no more retries, whatever maxRetries says).
      // The circuit breaker is evaluated before the first attempt of the target
      // and records one failure per target when the target finally fails.
      const disabledOverride: CacheOverride | undefined = !cacheDecision.enabled
        ? {
            status: "DISABLED",
            reason: disabledReason(cacheDecision, registered?.cacheSupport?.mode === "automatic")
          }
        : undefined;
      // Switch on but the adapter cannot carry cache marks at all (mode none or
      // undeclared): UNSUPPORTED, the call is made without cache.
      const unsupportedOverride: CacheOverride | undefined =
        cacheDecision.enabled && (registered?.cacheSupport?.mode ?? "none") === "none"
          ? { status: "UNSUPPORTED", reason: `provider ${target.provider} adapter does not support prompt cache marks` }
          : undefined;
      let cacheActive = explicitCache;
      let cacheFallbackUsed = false;
      let cacheErrorReason: string | undefined;
      let allowedRetries = maxRetries;

      while (attempts <= allowedRetries && remainingProviderAttempts > 0) {
        attempts += 1;
        remainingProviderAttempts -= 1;
        try {
          response = await adapter.execute(apiKey, {
            model: target.model,
            prompt: promptText,
            ...(built ? { built } : {}),
            maxOutputTokens: request.maxOutputTokens,
            timeoutMs,
            ...(explicitCache ? { cache: { ...cacheOptions, enabled: cacheActive } } : {})
          });
          break;
        } catch (error) {
          const typed =
            error instanceof ModelGatewayError
              ? error
              : new ModelGatewayError(
                  "PROVIDER_HTTP_ERROR",
                  error instanceof Error ? error.message : "provider failed",
                  true
                );
          lastError = typed;

          if (cacheActive && !cacheFallbackUsed && remainingProviderAttempts > 0 &&
              isCacheAttributableError(typed)) {
            cacheFallbackUsed = true;
            cacheActive = false;
            allowedRetries += 1;
            cacheErrorReason =
              `provider rejected the cache marks (HTTP ${typed.status}); retried once without cache: ${typed.message}`.slice(0, 500);
            // Conservative accounting: the rejected attempt is recorded as its
            // own FAILED row with no cost (a rejected request is not billed).
            await this.recordFailure(
              request, target.provider, target.model, "FAILED", attempts,
              Date.now() - started, previousProvider, typed.code,
              { status: "ERROR", reason: cacheErrorReason }
            );
            continue;
          }

          if (typed.retryable && !cacheFallbackUsed && attempts <= allowedRetries && remainingProviderAttempts > 0) {
            const retryAfterMs = (typed as ModelGatewayError & {
              retryAfterMs?: number;
            }).retryAfterMs;
            const delayMs = Math.max(
              250 * 2 ** (attempts - 1),
              retryAfterMs ?? 0
            );
            // Never retry before the server's delay; prefer fallback if it
            // exceeds our bounded per-retry budget.
            if (delayMs <= 5_000) {
              await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
              continue;
            }
          }

          const latencyMs = Date.now() - started;
          await this.recordFailure(
            request,
            target.provider,
            target.model,
            typed.code === "PROVIDER_TIMEOUT" ? "TIMEOUT" : "FAILED",
            attempts,
            latencyMs,
            previousProvider,
            typed.code,
            cacheErrorReason
              ? { status: "ERROR", reason: cacheErrorReason }
              : disabledOverride ?? unsupportedOverride
          );
          this.failure(
            request.organizationId,
            target.provider,
            target.model
          );
          break;
        }
      }

      if (!response) {
        previousProvider = target.provider;
        continue;
      }

      const latencyMs = Date.now() - started;
      // NOT_ESTIMABLE only exists after a response: the paid call already
      // happened, so it is recorded with a reason and an alert, never priced
      // with a substitute rate. Any other estimate failure still throws.
      let estimate: CostEstimate | undefined;
      let notEstimableReason: string | undefined;
      try {
        estimate = this.pricing.estimate(target.provider, target.model, response.usage);
      } catch (error) {
        if (!(error instanceof ModelGatewayError) || error.code !== "NOT_ESTIMABLE") throw error;
        notEstimableReason = error.message;
        try {
          this.onAlert({
            code: "COST_NOT_ESTIMABLE",
            requestId: request.requestId,
            organizationId: request.organizationId,
            provider: target.provider,
            model: target.model,
            reason: error.message
          });
        } catch {
          // An alert sink failure must not lose the record of a paid call.
        }
      }
      const estimatedCostChf = estimate?.estimatedCostChf ?? null;
      const observedOverride: CacheOverride | undefined = cacheErrorReason
        ? { status: "ERROR", reason: cacheErrorReason }
        : disabledOverride ??
          // Observed cache tokens always win over UNSUPPORTED.
          (observedCacheStatus(response.usage) === undefined ? unsupportedOverride : undefined) ??
          this.explicitMarkOverride(registered, target.model, cacheActive, response);

      // Persistence is intentionally outside the provider retry block.
      // A database failure must never cause a second paid provider call.
      await this.recordSuccess(
        request,
        target.provider,
        target.model,
        attempts,
        latencyMs,
        previousProvider,
        response.usage,
        estimate,
        notEstimableReason,
        observedOverride,
        hashes
      );
      this.success(
        request.organizationId,
        target.provider,
        target.model
      );

      return {
        ...response,
        requestId: request.requestId,
        provider: target.provider,
        model: target.model,
        attempts,
        latencyMs,
        fallbackFrom: previousProvider,
        estimatedCostChf,
        ...(notEstimableReason ? { costNotEstimableReason: notEstimableReason } : {})
      };
    }

    throw new ModelGatewayError(
      "ALL_PROVIDERS_FAILED",
      lastError instanceof Error ? lastError.message : "all providers failed"
    );
  }

  // Explicit-mark adapters (Anthropic): after the response, marks were sent but
  // neither counter moved. Below the model minimum the API silently caches
  // nothing (BELOW_MINIMUM); otherwise it is a plain MISS. No marks at all
  // (plain-text prompt) is UNSUPPORTED. Never an error, never blocks.
  private explicitMarkOverride(
    adapter: ProviderAdapter | undefined,
    model: string,
    cacheActive: boolean,
    response: AdapterResult
  ): CacheOverride | undefined {
    if (!cacheActive || adapter?.cacheSupport?.mode !== "explicit" || response.cacheMarks === undefined) {
      return undefined;
    }
    if (response.cacheMarks === 0) {
      if (observedCacheStatus(response.usage) !== undefined) return undefined;
      return { status: "UNSUPPORTED", reason: "plain-text prompt has no segments to mark; sent without cache" };
    }
    if (observedCacheStatus(response.usage) !== undefined) return undefined;
    const minimum = adapter.cacheSupport.minPrefixTokens(model);
    if (minimum !== undefined && response.usage.totalInputTokens < minimum) {
      return {
        status: "BELOW_MINIMUM",
        reason: `prompt of ${response.usage.totalInputTokens} tokens is below the ${minimum}-token cache minimum of ${model}; nothing was cached`
      };
    }
    return {
      status: "MISS",
      reason: minimum === undefined
        ? `no cache read or write reported and the minimum for ${model} is unknown`
        : "marks sent and the prompt reaches the minimum, but no cache read or write was reported"
    };
  }

  private async recordSuccess(
    request: ModelGatewayRequest,
    provider: ModelProvider,
    model: string,
    attempts: number,
    latencyMs: number,
    fallbackFrom: ModelProvider | undefined,
    usage: NormalizedUsage,
    estimate: CostEstimate | undefined,
    notEstimableReason: string | undefined,
    cacheOverride?: CacheOverride,
    hashes?: PrefixHashes
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO model_provider_calls (
           request_id, organization_id, project_id, order_id, task_id,
           provider, model, outcome, attempt_count, latency_ms, fallback_from,
           usage, estimated_cost_chf, error_code,
           cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
           cache_status, cache_reason,
           estimated_cost_without_cache_chf, estimated_cache_savings_chf,
           prefix_project_sha256, prefix_task_sha256,
           prefix_tools_sha256, prefix_segment_refs
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'SUCCESS', $8, $9, $10, $11::jsonb, $12, $13,
                   $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb)`,
        [
          request.requestId,
          request.organizationId,
          request.projectId,
          request.orderId ?? null,
          request.taskId,
          provider,
          model,
          attempts,
          latencyMs,
          fallbackFrom ?? null,
          JSON.stringify(usage),
          estimate?.estimatedCostChf ?? null,
          notEstimableReason ? "NOT_ESTIMABLE" : null,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          usage.cacheWrite5mTokens,
          usage.cacheWrite1hTokens,
          cacheOverride?.status ?? observedCacheStatus(usage) ?? null,
          // NOT_ESTIMABLE keeps its reason; the cache reason is appended.
          [notEstimableReason, cacheOverride?.reason].filter(Boolean).join(" | ") || null,
          estimate?.estimatedCostWithoutCacheChf ?? null,
          estimate?.estimatedCacheSavingsChf ?? null,
          hashes?.project ?? null,
          hashes?.task ?? null,
          hashes?.toolsSha256 ?? null,
          hashes ? JSON.stringify(hashes.segmentRefs) : null
        ]
      );
      // A not-estimable call has no trustworthy amount: it gets no cost event
      // (recording 0 would understate spend); the call row carries the reason.
      if (estimate) await client.query(
        `INSERT INTO cost_events (
           organization_id, project_id, order_id, task_id,
           provider, model, currency, amount, usage
         ) VALUES ($1, $2, $3, $4, $5, $6, 'CHF', $7, $8::jsonb)`,
        [
          request.organizationId,
          request.projectId,
          request.orderId ?? null,
          request.taskId,
          provider,
          model,
          estimate.estimatedCostChf,
          JSON.stringify({
            requestId: request.requestId,
            ...usage,
            attempts,
            fallbackFrom: fallbackFrom ?? null
          })
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

  private async recordFailure(
    request: ModelGatewayRequest,
    provider: ModelProvider,
    model: string,
    outcome: "FAILED" | "TIMEOUT" | "BLOCKED",
    attempts: number,
    latencyMs: number,
    fallbackFrom: ModelProvider | undefined,
    errorCode: string,
    cacheOverride?: CacheOverride
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO model_provider_calls (
         request_id, organization_id, project_id, order_id, task_id,
         provider, model, outcome, attempt_count, latency_ms, fallback_from,
         error_code, cache_status, cache_reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        request.requestId,
        request.organizationId,
        request.projectId,
        request.orderId ?? null,
        request.taskId,
        provider,
        model,
        outcome,
        attempts,
        latencyMs,
        fallbackFrom ?? null,
        errorCode,
        cacheOverride?.status ?? null,
        cacheOverride?.reason ?? null
      ]
    );
  }
}
