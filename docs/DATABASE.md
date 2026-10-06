# PostgreSQL canonical persistence

PLT-003 establishes PostgreSQL as JEV Platform's canonical persistence layer.

## Local database

Start PostgreSQL:

```bash
docker compose up -d postgres
```

Apply versioned migrations:

```bash
npm run db:migrate
```

Run database integration tests:

```bash
npm run test -w @jev/db
```

The default local connection string is shown in `.env.example`.

## Migration rules

- migrations live in `packages/db/migrations`;
- filenames are ordered and immutable after application;
- applied migration checksums are stored in `schema_migrations`;
- a checksum mismatch fails rather than silently rewriting history;
- every migration is executed transactionally;
- CI runs against a real PostgreSQL service.

## Canonical entities introduced by PLT-003

Organization, User, Client, Project, Repository, Environment, Order,
Requirement, Task, TaskRun, Approval, AuditEvent, CostEvent, Notification and
Deployment are represented by relational tables with project/organization
foreign keys where applicable.
