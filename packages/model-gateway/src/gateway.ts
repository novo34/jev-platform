import type { Pool } from "pg";
import { ProviderCredentialStore } from "./credentials.js";
import { PricingCatalog } from "./pricing.js";
import { ProviderRegistry } from "./adapters.js";
import {
  ModelGatewayError,
  type AdapterResult,
  type ModelGatewayRequest,
  type ModelGatewayResult,
  type ModelProvider,
  type NormalizedUsage
} from "./types.js";

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
    private readonly circuitCooldownMs = 30_000
  ) {}

  private async assertOwnership(request: ModelGatewayRequest): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1
         FROM projects p
         JOIN tasks t ON t.project_id = p.id
         LEFT JOIN orders o ON o.id = t.order_id
        WHERE p.id = $1
          AND p.organization_id = $2
          AND t.id = $3
          AND ($4::uuid IS NULL OR (o.id = $4 AND o.project_id = p.id))
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
      !request.prompt.trim() ||
      request.targets.length === 0
    ) {
      throw new ModelGatewayError("INVALID_REQUEST");
    }
    if ((request.timeoutMs ?? 120_000) < 1) {
      throw new ModelGatewayError("INVALID_REQUEST", "timeoutMs must be positive");
    }
    if ((request.maxRetries ?? 1) < 0) {
      throw new ModelGatewayError("INVALID_REQUEST", "maxRetries cannot be negative");
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
    const timeoutMs = request.timeoutMs ?? 120_000;
    const maxRetries = request.maxRetries ?? 1;
    let previousProvider: ModelProvider | undefined;
    let lastError: unknown;

    for (const target of request.targets) {
      if (!this.pricing.has(target.provider, target.model)) {
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

      while (attempts <= maxRetries) {
        attempts += 1;
        try {
          response = await adapter.execute(apiKey, {
            model: target.model,
            prompt: request.prompt,
            maxOutputTokens: request.maxOutputTokens,
            timeoutMs
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

          if (typed.retryable && attempts <= maxRetries) {
            continue;
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
            typed.code
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
      const estimatedCostChf = this.pricing.estimateChf(
        target.provider,
        target.model,
        response.usage
      );

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
        estimatedCostChf
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
        estimatedCostChf
      };
    }

    throw new ModelGatewayError(
      "ALL_PROVIDERS_FAILED",
      lastError instanceof Error ? lastError.message : "all providers failed"
    );
  }

  private async recordSuccess(
    request: ModelGatewayRequest,
    provider: ModelProvider,
    model: string,
    attempts: number,
    latencyMs: number,
    fallbackFrom: ModelProvider | undefined,
    usage: NormalizedUsage,
    estimatedCostChf: number
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO model_provider_calls (
           request_id, organization_id, project_id, order_id, task_id,
           provider, model, outcome, attempt_count, latency_ms, fallback_from,
           usage, estimated_cost_chf
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'SUCCESS', $8, $9, $10, $11::jsonb, $12)`,
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
          estimatedCostChf
        ]
      );
      await client.query(
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
          estimatedCostChf,
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
    errorCode: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO model_provider_calls (
         request_id, organization_id, project_id, order_id, task_id,
         provider, model, outcome, attempt_count, latency_ms, fallback_from,
         error_code
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
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
        errorCode
      ]
    );
  }
}
