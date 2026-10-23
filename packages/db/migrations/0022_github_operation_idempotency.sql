CREATE TABLE github_operations (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  repository_id UUID NOT NULL REFERENCES repositories(id),
  task_id UUID NOT NULL REFERENCES tasks(id),
  actor_id UUID NOT NULL REFERENCES users(id),
  command_id TEXT NOT NULL,
  action TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('PENDING','SUCCESS','FAILED','UNKNOWN')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(organization_id,command_id)
);
