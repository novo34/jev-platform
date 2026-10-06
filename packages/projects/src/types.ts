export type RepositoryRole = "frontend" | "backend" | "infra" | "other";
export type ProjectStatus = "SETUP" | "ACTIVE" | "PAUSED" | "ARCHIVED";
export type EnvironmentKind = "development" | "staging" | "production";

export interface ProjectRepositoryInput {
  fullName: string;
  role: RepositoryRole;
  primary?: boolean;
  productionBranch?: string;
  stagingBranch?: string;
  productionUrl?: string;
  stagingUrl?: string;
  deploymentProvider?: string;
  stagingDatabaseEnabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ProjectEnvironmentInput {
  repositoryFullName: string;
  kind: EnvironmentKind;
  name: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface RegisterProjectInput {
  organizationId: string;
  clientId?: string;
  name: string;
  status?: ProjectStatus;
  priority?: string;
  repositories: ProjectRepositoryInput[];
  environments?: ProjectEnvironmentInput[];
  metadata?: Record<string, unknown>;
}

export interface RegisteredRepository {
  id: string;
  fullName: string;
  role: RepositoryRole;
  primary: boolean;
  productionBranch: string;
  stagingBranch: string;
  productionUrl: string | null;
  stagingUrl: string | null;
  deploymentProvider: string | null;
  stagingDatabaseEnabled: boolean;
  metadata: Record<string, unknown>;
}

export interface RegisteredEnvironment {
  id: string;
  repositoryId: string;
  repositoryFullName: string;
  kind: EnvironmentKind;
  name: string;
  url: string | null;
  metadata: Record<string, unknown>;
}

export interface RegisteredProject {
  id: string;
  organizationId: string;
  clientId: string | null;
  name: string;
  status: ProjectStatus;
  priority: string;
  metadata: Record<string, unknown>;
  repositories: RegisteredRepository[];
  environments: RegisteredEnvironment[];
}

export class ProjectRegistryError extends Error {
  constructor(
    public readonly code:
      | "INVALID_PROJECT"
      | "PROJECT_NOT_FOUND"
      | "REPOSITORY_NOT_FOUND"
      | "AMBIGUOUS_REPOSITORY_TARGET",
    message: string = code
  ) {
    super(message);
    this.name = "ProjectRegistryError";
  }
}
