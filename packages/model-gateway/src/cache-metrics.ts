import type { Pool } from "pg";
import { ModelGatewayError } from "./types.js";

// Read-only access to the prompt-cache metrics views of migration 0030. Every
// query filters by organization_id (there is no RLS in this schema): the caller
// passes the organization of the authorised actor and it is a required argument.
// NUMERIC and BIGINT columns come back as strings from pg and are returned
// unchanged, so no precision is lost on money or token counts.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CACHE_METRICS_MAX_LIMIT = 500;
export const CACHE_METRICS_DEFAULT_LIMIT = 100;

export interface CacheMetricsFilter {
  projectId?: string;
  taskId?: string;
  limit?: number;
}

interface CacheStatusCounts {
  callsHit: string;
  callsPartial: string;
  callsMiss: string;
  callsWrite: string;
  callsDisabled: string;
  callsBelowMinimum: string;
  callsError: string;
  callsUnsupported: string;
  callsWithoutStatus: string;
}

interface CacheTotals extends CacheStatusCounts {
  organizationId: string;
  projectId: string;
  callsTotal: string;
  callsNotEstimable: string;
  ordinaryInputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  totalInputTokens: string;
  outputTokens: string;
  /** read / (read + write + ordinary input); "0" with no input. */
  cacheHitRate: string;
  costChf: string;
  costWithoutCacheChf: string;
  /** Estimated; negative when cache writes are not yet amortised. */
  cacheSavingsChf: string;
  firstCallAt: Date;
  lastCallAt: Date;
}

export interface ProjectCacheMetrics extends CacheTotals {}

export interface TaskCacheMetrics extends CacheTotals {
  orderId: string | null;
  taskId: string;
}

export interface CallCacheMetrics {
  organizationId: string;
  projectId: string;
  orderId: string | null;
  taskId: string;
  callId: string;
  requestId: string;
  provider: string;
  model: string;
  outcome: string;
  cacheStatus: string | null;
  cacheReason: string | null;
  createdAt: Date;
  ordinaryInputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  totalInputTokens: string;
  outputTokens: string;
  cacheHitRate: string;
  costChf: string | null;
  costWithoutCacheChf: string | null;
  cacheSavingsChf: string | null;
  cacheSavingsRatio: string | null;
}

type Row = Record<string, unknown>;

function requireUuid(value: string | undefined, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ModelGatewayError("INVALID_REQUEST", `${name} must be a UUID`);
  }
  return value;
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return CACHE_METRICS_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > CACHE_METRICS_MAX_LIMIT) {
    throw new ModelGatewayError(
      "INVALID_REQUEST", `limit must be an integer between 1 and ${CACHE_METRICS_MAX_LIMIT}`
    );
  }
  return limit;
}

function totals(row: Row): CacheTotals {
  return {
    organizationId: row.organization_id as string,
    projectId: row.project_id as string,
    callsTotal: row.calls_total as string,
    callsNotEstimable: row.calls_not_estimable as string,
    ordinaryInputTokens: row.ordinary_input_tokens as string,
    cacheReadTokens: row.cache_read_tokens as string,
    cacheWriteTokens: row.cache_write_tokens as string,
    totalInputTokens: row.total_input_tokens as string,
    outputTokens: row.output_tokens as string,
    cacheHitRate: row.cache_hit_rate as string,
    costChf: row.cost_chf as string,
    costWithoutCacheChf: row.cost_without_cache_chf as string,
    cacheSavingsChf: row.cache_savings_chf as string,
    callsHit: row.calls_hit as string,
    callsPartial: row.calls_partial as string,
    callsMiss: row.calls_miss as string,
    callsWrite: row.calls_write as string,
    callsDisabled: row.calls_disabled as string,
    callsBelowMinimum: row.calls_below_minimum as string,
    callsError: row.calls_error as string,
    callsUnsupported: row.calls_unsupported as string,
    callsWithoutStatus: row.calls_without_status as string,
    firstCallAt: row.first_call_at as Date,
    lastCallAt: row.last_call_at as Date
  };
}

export class CacheMetricsReader {
  constructor(private readonly pool: Pool) {}

  async byProject(
    organizationId: string, filter: CacheMetricsFilter = {}
  ): Promise<ProjectCacheMetrics[]> {
    const org = requireUuid(organizationId, "organizationId");
    const project = filter.projectId === undefined ? null : requireUuid(filter.projectId, "projectId");
    const result = await this.pool.query(
      `SELECT * FROM model_cache_metrics_by_project
        WHERE organization_id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)
        ORDER BY last_call_at DESC, project_id
        LIMIT $3`,
      [org, project, boundedLimit(filter.limit)]
    );
    return result.rows.map(totals);
  }

  async byTask(
    organizationId: string, filter: CacheMetricsFilter = {}
  ): Promise<TaskCacheMetrics[]> {
    const org = requireUuid(organizationId, "organizationId");
    const project = filter.projectId === undefined ? null : requireUuid(filter.projectId, "projectId");
    const task = filter.taskId === undefined ? null : requireUuid(filter.taskId, "taskId");
    const result = await this.pool.query(
      `SELECT * FROM model_cache_metrics_by_task
        WHERE organization_id = $1
          AND ($2::uuid IS NULL OR project_id = $2::uuid)
          AND ($3::uuid IS NULL OR task_id = $3::uuid)
        ORDER BY last_call_at DESC, task_id
        LIMIT $4`,
      [org, project, task, boundedLimit(filter.limit)]
    );
    return result.rows.map(row => ({
      ...totals(row), orderId: (row.order_id as string | null) ?? null, taskId: row.task_id as string
    }));
  }

  async byCall(
    organizationId: string, filter: CacheMetricsFilter = {}
  ): Promise<CallCacheMetrics[]> {
    const org = requireUuid(organizationId, "organizationId");
    const project = filter.projectId === undefined ? null : requireUuid(filter.projectId, "projectId");
    const task = filter.taskId === undefined ? null : requireUuid(filter.taskId, "taskId");
    // Fingerprint columns (prefix hashes, segment refs) are internal and never returned.
    const result = await this.pool.query(
      `SELECT organization_id, project_id, order_id, task_id, call_id, request_id, provider,
              model, outcome, cache_status, cache_reason, created_at, ordinary_input_tokens,
              cache_read_tokens, cache_write_tokens, total_input_tokens, output_tokens,
              cache_hit_rate, cost_chf, cost_without_cache_chf, cache_savings_chf,
              cache_savings_ratio
         FROM model_cache_metrics_by_call
        WHERE organization_id = $1
          AND ($2::uuid IS NULL OR project_id = $2::uuid)
          AND ($3::uuid IS NULL OR task_id = $3::uuid)
        ORDER BY created_at DESC, call_id DESC
        LIMIT $4`,
      [org, project, task, boundedLimit(filter.limit)]
    );
    return result.rows.map((row: Row) => ({
      organizationId: row.organization_id as string,
      projectId: row.project_id as string,
      orderId: (row.order_id as string | null) ?? null,
      taskId: row.task_id as string,
      callId: row.call_id as string,
      requestId: row.request_id as string,
      provider: row.provider as string,
      model: row.model as string,
      outcome: row.outcome as string,
      cacheStatus: (row.cache_status as string | null) ?? null,
      cacheReason: (row.cache_reason as string | null) ?? null,
      createdAt: row.created_at as Date,
      ordinaryInputTokens: row.ordinary_input_tokens as string,
      cacheReadTokens: row.cache_read_tokens as string,
      cacheWriteTokens: row.cache_write_tokens as string,
      totalInputTokens: row.total_input_tokens as string,
      outputTokens: row.output_tokens as string,
      cacheHitRate: row.cache_hit_rate as string,
      costChf: (row.cost_chf as string | null) ?? null,
      costWithoutCacheChf: (row.cost_without_cache_chf as string | null) ?? null,
      cacheSavingsChf: (row.cache_savings_chf as string | null) ?? null,
      cacheSavingsRatio: (row.cache_savings_ratio as string | null) ?? null
    }));
  }
}
