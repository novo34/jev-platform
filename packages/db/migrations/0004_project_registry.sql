ALTER TABLE repositories
  ADD COLUMN primary_repository BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN staging_database_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX idx_repositories_one_primary_per_project
  ON repositories(project_id)
  WHERE primary_repository = TRUE;

ALTER TABLE projects
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX idx_environments_repository ON environments(repository_id);
