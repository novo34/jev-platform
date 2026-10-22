ALTER TABLE github_installation_requests ADD COLUMN purpose TEXT NOT NULL DEFAULT 'INSTALLATION'
  CHECK (purpose IN ('INSTALLATION','IDENTITY'));
CREATE TABLE github_user_identities (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL REFERENCES users(id),
  github_user_id BIGINT NOT NULL CHECK (github_user_id>0),
  github_login TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id,user_id),
  UNIQUE(organization_id,github_user_id)
);
