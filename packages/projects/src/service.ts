import type { Pool, PoolClient } from "pg";
import {
  ProjectRegistryError,
  type RegisterProjectInput,
  type RegisteredEnvironment,
  type RegisteredProject,
  type RegisteredRepository,
  type RepositoryRole
} from "./types.js";

function assertOwnerName(fullName: string): void {
  if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) {
    throw new ProjectRegistryError(
      "INVALID_PROJECT",
      "repository must use owner/name format"
    );
  }
}

function validateProject(input: RegisterProjectInput): void {
  if (!input.name.trim()) {
    throw new ProjectRegistryError("INVALID_PROJECT", "project name is required");
  }

  if (input.repositories.length === 0) {
    throw new ProjectRegistryError(
      "INVALID_PROJECT",
      "at least one repository is required"
    );
  }

  const names = new Set<string>();
  const primary = input.repositories.filter((repo) => repo.primary === true);

  if (primary.length !== 1) {
    throw new ProjectRegistryError(
      "INVALID_PROJECT",
      "exactly one primary repository is required"
    );
  }

  for (const repo of input.repositories) {
    assertOwnerName(repo.fullName);

    if (names.has(repo.fullName)) {
      throw new ProjectRegistryError(
        "INVALID_PROJECT",
        "duplicate repository"
      );
    }
    names.add(repo.fullName);

    const productionBranch = repo.productionBranch ?? "main";
    const stagingBranch = repo.stagingBranch ?? "staging";

    if (productionBranch === stagingBranch) {
      throw new ProjectRegistryError(
        "INVALID_PROJECT",
        "staging branch must differ from production"
      );
    }
  }

  for (const environment of input.environments ?? []) {
    if (!names.has(environment.repositoryFullName)) {
      throw new ProjectRegistryError(
        "INVALID_PROJECT",
        "environment repository is not part of project"
      );
    }
  }

  if ((input.status ?? "SETUP") === "ACTIVE") {
    const primaryRepo = primary[0];
    if (
      !primaryRepo.stagingUrl ||
      primaryRepo.stagingDatabaseEnabled !== true
    ) {
      throw new ProjectRegistryError(
        "INVALID_PROJECT",
        "active project requires primary staging URL and staging database"
      );
    }
  }
}

function toRepository(row: any): RegisteredRepository {
  return {
    id: row.id,
    fullName: row.full_name,
    role: row.role as RepositoryRole,
    primary: row.primary_repository,
    productionBranch: row.default_branch,
    stagingBranch: row.staging_branch,
    productionUrl: row.production_url,
    stagingUrl: row.staging_url,
    deploymentProvider: row.deployment_provider,
    stagingDatabaseEnabled: row.staging_database_enabled,
    metadata: row.metadata ?? {}
  };
}

function toEnvironment(row: any): RegisteredEnvironment {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    repositoryFullName: row.repository_full_name,
    kind: row.kind,
    name: row.name,
    url: row.url,
    metadata: row.metadata ?? {}
  };
}

export class ProjectRegistryService {
  constructor(private readonly pool: Pool) {}

  async register(input: RegisterProjectInput): Promise<RegisteredProject> {
    validateProject(input);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const projectResult = await client.query(
        `INSERT INTO projects (
           organization_id, client_id, name, status, priority, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id`,
        [
          input.organizationId,
          input.clientId ?? null,
          input.name.trim(),
          input.status ?? "SETUP",
          input.priority ?? "NORMAL",
          JSON.stringify(input.metadata ?? {})
        ]
      );

      const projectId = projectResult.rows[0].id as string;
      const repoIds = new Map<string, string>();

      for (const repo of input.repositories) {
        const repoResult = await client.query(
          `INSERT INTO repositories (
             project_id,
             full_name,
             role,
             primary_repository,
             default_branch,
             staging_branch,
             production_url,
             staging_url,
             deployment_provider,
             staging_database_enabled,
             metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
           RETURNING id`,
          [
            projectId,
            repo.fullName,
            repo.role,
            repo.primary === true,
            repo.productionBranch ?? "main",
            repo.stagingBranch ?? "staging",
            repo.productionUrl ?? null,
            repo.stagingUrl ?? null,
            repo.deploymentProvider ?? null,
            repo.stagingDatabaseEnabled ?? false,
            JSON.stringify(repo.metadata ?? {})
          ]
        );
        repoIds.set(repo.fullName, repoResult.rows[0].id as string);
      }

      for (const environment of input.environments ?? []) {
        const repositoryId = repoIds.get(environment.repositoryFullName);
        if (!repositoryId) {
          throw new ProjectRegistryError(
            "REPOSITORY_NOT_FOUND",
            "environment repository not found"
          );
        }

        await client.query(
          `INSERT INTO environments (
             project_id, repository_id, kind, name, url, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            projectId,
            repositoryId,
            environment.kind,
            environment.name,
            environment.url ?? null,
            JSON.stringify(environment.metadata ?? {})
          ]
        );
      }

      await client.query("COMMIT");
      return await this.get(projectId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async get(projectId: string): Promise<RegisteredProject> {
    const projectResult = await this.pool.query(
      `SELECT id, organization_id, client_id, name, status, priority, metadata
         FROM projects
        WHERE id = $1
        LIMIT 1`,
      [projectId]
    );

    const project = projectResult.rows[0];

    if (!project) {
      throw new ProjectRegistryError("PROJECT_NOT_FOUND");
    }

    const repositoriesResult = await this.pool.query(
      `SELECT *
         FROM repositories
        WHERE project_id = $1
        ORDER BY primary_repository DESC, full_name ASC`,
      [projectId]
    );

    const environmentsResult = await this.pool.query(
      `SELECT e.*, r.full_name AS repository_full_name
         FROM environments e
         JOIN repositories r ON r.id = e.repository_id
        WHERE e.project_id = $1
        ORDER BY r.full_name, e.kind, e.name`,
      [projectId]
    );

    return {
      id: project.id,
      organizationId: project.organization_id,
      clientId: project.client_id,
      name: project.name,
      status: project.status,
      priority: project.priority,
      metadata: project.metadata ?? {},
      repositories: repositoriesResult.rows.map(toRepository),
      environments: environmentsResult.rows.map(toEnvironment)
    };
  }

  async list(organizationId: string): Promise<RegisteredProject[]> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM projects WHERE organization_id = $1 ORDER BY name",
      [organizationId]
    );

    return Promise.all(result.rows.map((row) => this.get(row.id)));
  }

  async resolveRepository(
    projectId: string,
    repositoryId?: string
  ): Promise<RegisteredRepository> {
    const project = await this.get(projectId);

    if (repositoryId) {
      const repository = project.repositories.find(
        (repo) => repo.id === repositoryId
      );
      if (!repository) {
        throw new ProjectRegistryError("REPOSITORY_NOT_FOUND");
      }
      return repository;
    }

    if (project.repositories.length > 1) {
      throw new ProjectRegistryError(
        "AMBIGUOUS_REPOSITORY_TARGET",
        "multi-repository project requires explicit repository target"
      );
    }

    return project.repositories[0];
  }
}
