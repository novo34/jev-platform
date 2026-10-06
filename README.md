# JEV Platform

JEV is a development operations platform for managing software projects, AI agents, GitHub workflows, verification, approvals, costs and reporting.

## Repository role

This repository contains the JEV product itself.

The reusable governance and skills library remains separate in:

- `novo34/base-skills_klever`

JEV consumes those skills but does not own them.

## PLT-002 application skeleton

The Platform starts as a TypeScript workspace with explicit service boundaries:

- `apps/web` — React/Vite web application
- `apps/api` — Fastify HTTP API
- `apps/worker` — background-worker process with a health endpoint
- `packages/shared` — shared typed contracts/utilities
- `packages/db` — PostgreSQL pool, versioned migrations and persistence verification
- `packages/auth` — human authentication, sessions and project-scoped RBAC

Local development and validation instructions live in `docs/DEVELOPMENT.md`.
PostgreSQL setup and migration rules live in `docs/DATABASE.md`.
Authentication and RBAC rules live in `docs/AUTH_RBAC.md`.

The next backlog task must not be implemented until PLT-002 is verified and closed by the Development Control Gate.
