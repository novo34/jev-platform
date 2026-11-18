-- PLT-052 (PR 2/6): additive migration for prompt-cache accounting.
-- Forward-only, no data rewrite. Deployed BEFORE any code can use `anthropic`.
-- No GRANT changes: jev_runtime already holds table-level INSERT on
-- model_provider_calls, which covers the new columns, and no SELECT/UPDATE is
-- added (views and reads belong to a later PR).

ALTER TABLE provider_credentials DROP CONSTRAINT IF EXISTS provider_credentials_provider_check;
ALTER TABLE provider_credentials ADD CONSTRAINT provider_credentials_provider_check
  CHECK (provider IN ('openai', 'deepseek', 'qwen', 'glm', 'anthropic'));

ALTER TABLE model_provider_calls DROP CONSTRAINT IF EXISTS model_provider_calls_provider_check;
ALTER TABLE model_provider_calls ADD CONSTRAINT model_provider_calls_provider_check
  CHECK (provider IN ('openai', 'deepseek', 'qwen', 'glm', 'anthropic'));

-- BIGINT so a large paid response can never fail its own accounting insert.
ALTER TABLE model_provider_calls
  ADD COLUMN cache_read_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  ADD COLUMN cache_write_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  ADD COLUMN cache_write_5m_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_write_5m_tokens >= 0),
  ADD COLUMN cache_write_1h_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_write_1h_tokens >= 0),
  -- NULL = no cache state observed (or not measured); never a guessed value.
  ADD COLUMN cache_status TEXT CHECK (cache_status IN (
    'HIT', 'PARTIAL', 'MISS', 'WRITE', 'DISABLED', 'BELOW_MINIMUM', 'ERROR', 'UNSUPPORTED'
  )),
  ADD COLUMN cache_reason TEXT,
  -- One hash per breakpoint level; NULL is allowed: a measurement failure never blocks a call.
  ADD COLUMN prefix_project_sha256 TEXT CHECK (prefix_project_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN prefix_task_sha256 TEXT CHECK (prefix_task_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN estimated_cost_without_cache_chf NUMERIC(14,6) CHECK (estimated_cost_without_cache_chf >= 0),
  -- May be negative: a cache write costs more than plain input until amortized.
  ADD COLUMN estimated_cache_savings_chf NUMERIC(14,6),
  ADD CONSTRAINT model_provider_calls_cache_write_ttl_check
    CHECK (cache_write_5m_tokens + cache_write_1h_tokens <= cache_write_tokens);
