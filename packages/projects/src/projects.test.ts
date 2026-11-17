import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, migrate } from "@jev/db";
import {
  ProjectRegistryError,
  ProjectRegistryService
} from "./index.js";

const pool = createDatabasePool();
const registry = new ProjectRegistryService(pool);
const organizationId = randomUUID();

beforeAll(async () => {
  await migrate(pool);
  await pool.query(
    "INSERT INTO organizations (id, name) VALUES ($1, 'Registry Org')",
    [organizationId]
  );
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE organization_id = $1)",
    [organizationId]
  );
  await pool.query(
    "DELETE FROM repositories WHERE project_id IN (SELECT id FROM projects WHERE organization_id = $1)",
    [organizationId]
  );
  await pool.query(
    "DELETE FROM projects WHERE organization_id = $1",
    [organizationId]
  );
  await pool.query(
    "DELETE FROM organizations WHERE id = $1",
    [organizationId]
  );
  await pool.end();
});

describe("ProjectRegistryService", () => {
  it("persists a project with multiple repository roles and per-repository environments", async () => {
    const project = await registry.register({
      organizationId,
      name: "Multi Repo Project",
      status: "SETUP",
      repositories: [
        {
          fullName: "novo34/frontend-app",
          role: "frontend",
          primary: true,
          productionBranch: "main",
          stagingBranch: "staging",
          productionUrl: "https://app.example.test",
          stagingUrl: "https://staging-app.example.test",
          stagingDatabaseEnabled: true,
          metadata: { framework: "react" }
        },
        {
          fullName: "novo34/backend-api",
          role: "backend",
          productionBranch: "main",
          stagingBranch: "staging-api",
          stagingUrl: "https://staging-api.example.test",
          stagingDatabaseEnabled: true,
          metadata: { framework: "fastify" }
        },
        {
          fullName: "novo34/infra",
          role: "infra",
          productionBranch: "main",
          stagingBranch: "staging-infra"
        }
      ],
      environments: [
        {
          repositoryFullName: "novo34/frontend-app",
          kind: "staging",
          name: "frontend-staging",
          url: "https://staging-app.example.test",
          metadata: { region: "eu-central" }
        },
        {
          repositoryFullName: "novo34/backend-api",
          kind: "staging",
          name: "backend-staging",
          url: "https://staging-api.example.test",
          metadata: { database: "jev_staging" }
        }
      ]
    });

    expect(project.repositories).toHaveLength(3);
    expect(project.repositories.map((repo) => repo.role)).toEqual([
      "frontend",
      "backend",
      "infra"
    ]);
    expect(project.repositories.filter((repo) => repo.primary)).toHaveLength(1);
    expect(project.environments).toHaveLength(2);

    const backend = project.repositories.find(
      (repo) => repo.fullName === "novo34/backend-api"
    );
    const backendEnv = project.environments.find(
      (env) => env.repositoryFullName === "novo34/backend-api"
    );

    expect(backend?.stagingBranch).toBe("staging-api");
    expect(backendEnv?.metadata).toEqual({ database: "jev_staging" });
  });

  it("requires explicit repository targeting for a multi-repository project", async () => {
    const project = await registry.register({
      organizationId,
      name: `Explicit Target ${randomUUID()}`,
      repositories: [
        {
          fullName: `novo34/frontend-${randomUUID()}`,
          role: "frontend",
          primary: true
        },
        {
          fullName: `novo34/backend-${randomUUID()}`,
          role: "backend"
        }
      ]
    });

    await expect(
      registry.resolveRepository(project.id)
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_REPOSITORY_TARGET"
    });

    const backend = project.repositories.find((repo) => repo.role === "backend")!;
    await expect(
      registry.resolveRepository(project.id, backend.id)
    ).resolves.toMatchObject({
      id: backend.id,
      role: "backend"
    });
  });

  it("allows implicit resolution only when the project has exactly one repository", async () => {
    const fullName = `novo34/single-${randomUUID()}`;
    const project = await registry.register({
      organizationId,
      name: `Single Repo ${randomUUID()}`,
      repositories: [
        {
          fullName,
          role: "other",
          primary: true
        }
      ]
    });

    await expect(registry.resolveRepository(project.id)).resolves.toMatchObject({
      fullName
    });
  });

  it("requires exactly one primary repository", async () => {
    await expect(
      registry.register({
        organizationId,
        name: "No Primary",
        repositories: [
          {
            fullName: `novo34/one-${randomUUID()}`,
            role: "frontend"
          },
          {
            fullName: `novo34/two-${randomUUID()}`,
            role: "backend"
          }
        ]
      })
    ).rejects.toMatchObject({
      code: "INVALID_PROJECT"
    });
  });

  it("requires active projects to have permanent primary staging and staging database capability", async () => {
    await expect(
      registry.register({
        organizationId,
        name: "Invalid Active Project",
        status: "ACTIVE",
        repositories: [
          {
            fullName: `novo34/active-${randomUUID()}`,
            role: "backend",
            primary: true,
            stagingUrl: "https://staging.example.test",
            stagingDatabaseEnabled: false
          }
        ]
      })
    ).rejects.toBeInstanceOf(ProjectRegistryError);
  });

  it("rejects environments that point to repositories outside the project", async () => {
    await expect(
      registry.register({
        organizationId,
        name: "Invalid Environment Mapping",
        repositories: [
          {
            fullName: `novo34/valid-${randomUUID()}`,
            role: "other",
            primary: true
          }
        ],
        environments: [
          {
            repositoryFullName: "novo34/not-in-project",
            kind: "staging",
            name: "invalid"
          }
        ]
      })
    ).rejects.toMatchObject({
      code: "INVALID_PROJECT"
    });
  });

  it("rejects a staging host already used by another repository or project, in any case or form", async () => {
    const host = `shared-${randomUUID().slice(0, 8)}.staging.example.test`;
    const project = (url: string, name = "Shared Staging") => registry.register({
      organizationId, name, repositories: [{ fullName: `novo34/shared-${randomUUID()}`, role: "other", primary: true, stagingUrl: url }]
    });
    await project(`https://${host}`);
    for (const url of [`https://${host}`, `https://${host.toUpperCase()}/`, `https://${host}:8443/x`]) {
      await expect(project(url)).rejects.toMatchObject({ code: "STAGING_URL_IN_USE" });
    }
    await expect(registry.register({
      organizationId, name: "Twice in one project", repositories: [
        { fullName: `novo34/a-${randomUUID()}`, role: "frontend", primary: true, stagingUrl: `https://dup-${host}` },
        { fullName: `novo34/b-${randomUUID()}`, role: "backend", stagingUrl: `https://DUP-${host}` }
      ]
    })).rejects.toMatchObject({ code: "STAGING_URL_IN_USE" });
    const count = await pool.query("SELECT count(*)::int AS n FROM projects WHERE organization_id=$1 AND name IN ('Shared Staging','Twice in one project')", [organizationId]);
    expect(count.rows[0].n).toBe(1);
    await expect(project(`https://other-${host}`)).resolves.toBeDefined();
  });

  it("serializes concurrent registrations of the same staging host", async () => {
    const host = `race-${randomUUID().slice(0, 8)}.staging.example.test`;
    const attempt = () => registry.register({
      organizationId, name: "Race Staging", repositories: [{ fullName: `novo34/race-${randomUUID()}`, role: "other", primary: true, stagingUrl: `https://${host}` }]
    });
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "STAGING_URL_IN_USE" });
  });
});
