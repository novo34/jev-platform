# Project Registry and multi-repository model

PLT-007 makes PostgreSQL the canonical Project Registry for project, repository and environment configuration.

## Project model

A project has one or more repositories and exactly one primary repository. Repository roles are:

- `frontend`
- `backend`
- `infra`
- `other`

Every repository stores its own production branch, staging branch, production/staging URLs, deployment provider, staging-database capability and metadata.

## Multi-repository targeting

When a project contains more than one repository, work must resolve an explicit repository ID. JEV does not guess which repository should be modified.

Single-repository projects may resolve their sole repository implicitly.

## Environments

Environment records belong to both a project and a repository. This allows frontend, backend and infrastructure repositories to use different staging URLs, providers and metadata.

An environment cannot point to a repository outside its project.

## Active project invariant

A project may be registered in `SETUP` while infrastructure is incomplete.

Before a project is registered as `ACTIVE`, its primary repository must have:

- a staging URL;
- staging database capability enabled;
- a staging branch different from production.

Permanent staging deployment itself is implemented in a later Platform task; PLT-007 stores the configuration required by that runtime.
