CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, email)
);

CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  client_id UUID REFERENCES clients(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  provider TEXT NOT NULL DEFAULT 'github',
  external_repository_id TEXT,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('frontend', 'backend', 'infra', 'other')),
  default_branch TEXT NOT NULL DEFAULT 'main',
  staging_branch TEXT,
  production_url TEXT,
  staging_url TEXT,
  deployment_provider TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, full_name)
);

CREATE TABLE environments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  repository_id UUID REFERENCES repositories(id),
  kind TEXT NOT NULL CHECK (kind IN ('development', 'staging', 'production')),
  name TEXT NOT NULL,
  url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, repository_id, kind, name)
);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  author_user_id UUID REFERENCES users(id),
  objective TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  status TEXT NOT NULL DEFAULT 'PLANNED',
  work_type TEXT NOT NULL DEFAULT 'GENERAL',
  constraints JSONB NOT NULL DEFAULT '[]'::jsonb,
  acceptance_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  order_id UUID REFERENCES orders(id),
  requirement_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, requirement_key)
);

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  order_id UUID REFERENCES orders(id),
  repository_id UUID REFERENCES repositories(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PLANNED',
  risk TEXT NOT NULL DEFAULT 'R0' CHECK (risk IN ('R0', 'R1', 'R2', 'R3', 'R4')),
  branch_name TEXT,
  max_actions INTEGER,
  max_retries INTEGER,
  max_cost NUMERIC(14,4),
  acceptance_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE task_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  status TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (
    decision IN ('APPROVED', 'CHANGES_REQUESTED', 'REJECTED')
  ),
  revision TEXT,
  commit_sha TEXT,
  pull_request_url TEXT,
  staging_url TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  stale BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  project_id UUID REFERENCES projects(id),
  task_id UUID REFERENCES tasks(id),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  result TEXT NOT NULL,
  risk TEXT,
  provider TEXT,
  model TEXT,
  cost NUMERIC(14,4),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE cost_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  project_id UUID REFERENCES projects(id),
  order_id UUID REFERENCES orders(id),
  task_id UUID REFERENCES tasks(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  amount NUMERIC(14,6) NOT NULL CHECK (amount >= 0),
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  project_id UUID REFERENCES projects(id),
  task_id UUID REFERENCES tasks(id),
  user_id UUID REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNREAD',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE TABLE deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  repository_id UUID NOT NULL REFERENCES repositories(id),
  environment_id UUID NOT NULL REFERENCES environments(id),
  task_id UUID REFERENCES tasks(id),
  provider TEXT,
  external_deployment_id TEXT,
  revision TEXT NOT NULL,
  status TEXT NOT NULL,
  url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_users_organization ON users(organization_id);
CREATE INDEX idx_clients_organization ON clients(organization_id);
CREATE INDEX idx_projects_organization ON projects(organization_id);
CREATE INDEX idx_repositories_project ON repositories(project_id);
CREATE INDEX idx_environments_project ON environments(project_id);
CREATE INDEX idx_orders_project ON orders(project_id);
CREATE INDEX idx_requirements_project ON requirements(project_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_task_runs_task ON task_runs(task_id);
CREATE INDEX idx_approvals_task ON approvals(task_id);
CREATE INDEX idx_audit_events_project ON audit_events(project_id);
CREATE INDEX idx_audit_events_task ON audit_events(task_id);
CREATE INDEX idx_cost_events_project ON cost_events(project_id);
CREATE INDEX idx_cost_events_task ON cost_events(task_id);
CREATE INDEX idx_notifications_project ON notifications(project_id);
CREATE INDEX idx_deployments_project ON deployments(project_id);
