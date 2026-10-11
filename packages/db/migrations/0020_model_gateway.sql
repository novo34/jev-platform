CREATE TABLE provider_credentials (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'deepseek', 'qwen', 'glm')),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  last_four TEXT NOT NULL,
  configured_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, provider)
);

CREATE TABLE model_provider_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id TEXT NOT NULL,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  order_id UUID REFERENCES orders(id),
  task_id UUID NOT NULL REFERENCES tasks(id),
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'deepseek', 'qwen', 'glm')),
  model TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILED', 'TIMEOUT', 'BLOCKED')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  latency_ms INTEGER,
  fallback_from TEXT,
  error_code TEXT,
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  estimated_cost_chf NUMERIC(14,6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_model_provider_calls_request ON model_provider_calls(request_id, created_at);
CREATE INDEX idx_model_provider_calls_project ON model_provider_calls(project_id, created_at);
CREATE INDEX idx_model_provider_calls_task ON model_provider_calls(task_id, created_at);
