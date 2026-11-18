-- PLT-052 (PR 5/6): read-only prompt-cache metrics views and the prefix
-- fingerprint needed to detect an unstable prefix between calls of one task.
-- Forward-only and additive: two nullable columns and three views. No data is
-- rewritten and no GRANT is issued here (privileges live in
-- packages/db/security/provision-runtime-role.sql, like every other grant).

-- Fingerprint of the call, next to the two prefix hashes of 0029. NULL for calls
-- with a plain-text prompt or from before this migration (never guessed).
ALTER TABLE model_provider_calls
  ADD COLUMN prefix_tools_sha256 TEXT,
  ADD COLUMN prefix_segment_refs JSONB,
  ADD CONSTRAINT model_provider_calls_prefix_tools_sha256_check
    CHECK (prefix_tools_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT model_provider_calls_prefix_segment_refs_check
    CHECK (jsonb_typeof(prefix_segment_refs) = 'array');

-- One row per recorded call (any outcome). Counters of failed or blocked calls
-- are 0 because they carry no usage. Ordinary input = input not read from nor
-- written to the cache. Hit rate = read / (read + write + ordinary input),
-- 0 when the call had no input. Savings may be negative (a cache write costs
-- more than plain input until it is amortised); NULL = not estimable.
CREATE VIEW model_cache_metrics_by_call WITH (security_barrier = true) AS
SELECT
  c.organization_id,
  c.project_id,
  c.order_id,
  c.task_id,
  c.id AS call_id,
  c.request_id,
  c.provider,
  c.model,
  c.outcome,
  c.cache_status,
  c.cache_reason,
  c.created_at,
  m.ordinary_input_tokens,
  c.cache_read_tokens,
  c.cache_write_tokens,
  m.ordinary_input_tokens + c.cache_read_tokens + c.cache_write_tokens AS total_input_tokens,
  m.output_tokens,
  CASE WHEN m.ordinary_input_tokens + c.cache_read_tokens + c.cache_write_tokens = 0 THEN 0::numeric
       ELSE ROUND(c.cache_read_tokens::numeric
         / (m.ordinary_input_tokens + c.cache_read_tokens + c.cache_write_tokens), 6)
  END AS cache_hit_rate,
  c.estimated_cost_chf AS cost_chf,
  c.estimated_cost_without_cache_chf AS cost_without_cache_chf,
  c.estimated_cache_savings_chf AS cache_savings_chf,
  CASE WHEN c.estimated_cost_without_cache_chf > 0
       THEN ROUND(c.estimated_cache_savings_chf / c.estimated_cost_without_cache_chf, 6)
  END AS cache_savings_ratio,
  c.prefix_project_sha256,
  c.prefix_task_sha256,
  c.prefix_tools_sha256,
  c.prefix_segment_refs
FROM model_provider_calls c
CROSS JOIN LATERAL (
  SELECT
    CASE WHEN c.usage->>'inputTokens' ~ '^[0-9]{1,18}$'
         THEN (c.usage->>'inputTokens')::bigint ELSE 0 END AS ordinary_input_tokens,
    CASE WHEN c.usage->>'outputTokens' ~ '^[0-9]{1,18}$'
         THEN (c.usage->>'outputTokens')::bigint ELSE 0 END AS output_tokens
) m;

-- Aggregation of the call view. Sums of cost and savings ignore NULL (calls not
-- estimable); calls_not_estimable counts them so a partial sum is never mistaken
-- for a complete one.
CREATE VIEW model_cache_metrics_by_task WITH (security_barrier = true) AS
SELECT
  organization_id, project_id, order_id, task_id,
  COUNT(*)::bigint AS calls_total,
  COUNT(*) FILTER (WHERE outcome = 'SUCCESS' AND cost_chf IS NULL)::bigint AS calls_not_estimable,
  COALESCE(SUM(ordinary_input_tokens), 0)::bigint AS ordinary_input_tokens,
  COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
  COALESCE(SUM(total_input_tokens), 0)::bigint AS total_input_tokens,
  COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
  CASE WHEN COALESCE(SUM(total_input_tokens), 0) = 0 THEN 0::numeric
       ELSE ROUND(SUM(cache_read_tokens)::numeric / SUM(total_input_tokens), 6)
  END AS cache_hit_rate,
  COALESCE(SUM(cost_chf), 0)::numeric(18,6) AS cost_chf,
  COALESCE(SUM(cost_without_cache_chf), 0)::numeric(18,6) AS cost_without_cache_chf,
  COALESCE(SUM(cache_savings_chf), 0)::numeric(18,6) AS cache_savings_chf,
  COUNT(*) FILTER (WHERE cache_status = 'HIT')::bigint AS calls_hit,
  COUNT(*) FILTER (WHERE cache_status = 'PARTIAL')::bigint AS calls_partial,
  COUNT(*) FILTER (WHERE cache_status = 'MISS')::bigint AS calls_miss,
  COUNT(*) FILTER (WHERE cache_status = 'WRITE')::bigint AS calls_write,
  COUNT(*) FILTER (WHERE cache_status = 'DISABLED')::bigint AS calls_disabled,
  COUNT(*) FILTER (WHERE cache_status = 'BELOW_MINIMUM')::bigint AS calls_below_minimum,
  COUNT(*) FILTER (WHERE cache_status = 'ERROR')::bigint AS calls_error,
  COUNT(*) FILTER (WHERE cache_status = 'UNSUPPORTED')::bigint AS calls_unsupported,
  COUNT(*) FILTER (WHERE cache_status IS NULL)::bigint AS calls_without_status,
  MIN(created_at) AS first_call_at,
  MAX(created_at) AS last_call_at
FROM model_cache_metrics_by_call
GROUP BY organization_id, project_id, order_id, task_id;

CREATE VIEW model_cache_metrics_by_project WITH (security_barrier = true) AS
SELECT
  organization_id, project_id,
  COUNT(*)::bigint AS calls_total,
  COUNT(*) FILTER (WHERE outcome = 'SUCCESS' AND cost_chf IS NULL)::bigint AS calls_not_estimable,
  COALESCE(SUM(ordinary_input_tokens), 0)::bigint AS ordinary_input_tokens,
  COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
  COALESCE(SUM(total_input_tokens), 0)::bigint AS total_input_tokens,
  COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
  CASE WHEN COALESCE(SUM(total_input_tokens), 0) = 0 THEN 0::numeric
       ELSE ROUND(SUM(cache_read_tokens)::numeric / SUM(total_input_tokens), 6)
  END AS cache_hit_rate,
  COALESCE(SUM(cost_chf), 0)::numeric(18,6) AS cost_chf,
  COALESCE(SUM(cost_without_cache_chf), 0)::numeric(18,6) AS cost_without_cache_chf,
  COALESCE(SUM(cache_savings_chf), 0)::numeric(18,6) AS cache_savings_chf,
  COUNT(*) FILTER (WHERE cache_status = 'HIT')::bigint AS calls_hit,
  COUNT(*) FILTER (WHERE cache_status = 'PARTIAL')::bigint AS calls_partial,
  COUNT(*) FILTER (WHERE cache_status = 'MISS')::bigint AS calls_miss,
  COUNT(*) FILTER (WHERE cache_status = 'WRITE')::bigint AS calls_write,
  COUNT(*) FILTER (WHERE cache_status = 'DISABLED')::bigint AS calls_disabled,
  COUNT(*) FILTER (WHERE cache_status = 'BELOW_MINIMUM')::bigint AS calls_below_minimum,
  COUNT(*) FILTER (WHERE cache_status = 'ERROR')::bigint AS calls_error,
  COUNT(*) FILTER (WHERE cache_status = 'UNSUPPORTED')::bigint AS calls_unsupported,
  COUNT(*) FILTER (WHERE cache_status IS NULL)::bigint AS calls_without_status,
  MIN(created_at) AS first_call_at,
  MAX(created_at) AS last_call_at
FROM model_cache_metrics_by_call
GROUP BY organization_id, project_id;
