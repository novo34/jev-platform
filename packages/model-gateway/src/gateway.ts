import type { Pool } from "pg";
import { ProviderCredentialStore } from "./credentials.js";
import { PricingCatalog } from "./pricing.js";
import { ProviderRegistry } from "./adapters.js";
import {
  ModelGatewayError,
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
  private readonly circuits = new Map<ModelProvider, CircuitState>();

  constructor(
    private readonly pool: Pool,
    private readonly credentials: ProviderCredentialStore,
    private readonly providers: ProviderRegistry,
    private readonly pricing: PricingCatalog,
    private readonly circuitFailureThreshold = 3,
    private readonly circuitCooldownMs = 30_000
  ) {}

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

  private assertCircuit(provider: ModelProvider): void {
    const state = this.circuits.get(provider);
    if (!state?.openedAt) return;
    if (Date.now() - state.openedAt >= this.circuitCooldownMs) {
      this.circuits.delete(provider);
      return;
    }
    throw new ModelGatewayError(
      "PROVIDER_CIRCUIT_OPEN",
      `circuit open for ${provider}`
    );
  }

  private success(provider: ModelProvider): void {
    this.circuits.delete(provider);
  }

  private failure(provider: ModelProvider): void {
    const state = this.circuits.get(provider) ?? { failures: 0 };
    state.failures += 1;
    if (state.failures >= this.circuitFailureThreshold) {
      state.openedAt = Date.now();
    }
    this.circuits.set(provider, state);
  }

  async execute(request: ModelGatewayRequest): Promise<ModelGatewayResult> {
    this.assertRequest(request);
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
        this.assertCircuit(target.provider);
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

      const adapter = this.providers.get(target.provider);
      const started = Date.now();
      let attempts = 0;

      while (attempts <= maxRetries) {
        attempts += 1;
        try {
          const response = await adapter.execute(apiKey, {
            model: target.model,
            prompt: request.prompt,
            maxOutputTokens: request.maxOutputTokens,
            timeoutMs
          });
          const latencyMs = Date.now() - started;
          const estimatedCostChf = this.pricing.estimateChf(
            target.provider,
            target.model,
            response.usage
          );

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
          this.success(target.provider);

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
          this.failure(target.provider);
          break;
        }
      }

      previousProvider = target.provider;
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
