CREATE TABLE github_installation_requests (
  state_hash TEXT PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  repository_id UUID NOT NULL REFERENCES repositories(id),
  user_id UUID NOT NULL REFERENCES users(id),
  session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  installation_id BIGINT CHECK (installation_id > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id)
);
CREATE INDEX idx_github_installation_requests_expiry ON github_installation_requests(expires_at);

CREATE TABLE github_installations (
  installation_id BIGINT PRIMARY KEY CHECK (installation_id > 0),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  account_id BIGINT NOT NULL CHECK (account_id > 0),
  verified_by UUID NOT NULL REFERENCES users(id),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE github_repository_installations (
  repository_id UUID PRIMARY KEY REFERENCES repositories(id),
  installation_id BIGINT NOT NULL REFERENCES github_installations(installation_id)
);
