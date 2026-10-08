# PLT-008 F-04 — Runtime database privilege boundary

This document specifies the F-04 acceptance gate. Passing CI proves the restricted-role behavior in the test database, **not** that the live deployment has switched credentials.

## Required deployment topology

* **Schema owner / migrator:** a separate credential allowed to run migrations
  and own guarded objects. It is never used by an application server or worker.
* **Runtime:** LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION,
  NOBYPASSRLS. It must not own, inherit ownership of, or hold direct INSERT,
  UPDATE or DELETE privileges on tasks, approvals, deployments or environments.
* **Controlled write entry points:** SECURITY DEFINER functions created by the
  migration owner (ideally with ownership transferred to a dedicated NOLOGIN
  owner role), with a pinned migration-schema search_path, narrow EXECUTE grants
  and input validation. They acquire project-scope locks before child-row locks.
  The runtime role must never own or be a member of the function/table owner.
* **Separate URLs:** migrations use the migrator connection; runtime uses its
  own connection. Never use the migration URL for the API or worker.

## Deployment sequence (must not be reordered)

1. Inventory all direct DML call sites for guarded tables, including workers,
   tests and operational scripts. Replace each production writer with controlled
   functions, including staging Environment creation and Task transitions.
2. Migrate schema using `MIGRATION_DATABASE_URL` (required in production),
   then execute `packages/db/security/provision-runtime-role.sql` as an admin
   against the expected `public` schema. Never grant writes on guarded tables.
   Do not assume the application migrator can CREATE ROLE on managed Postgres.
3. Provision credentials outside the repository and inject them through the
   deployment secret manager. Rotate any shared credentials.
4. Run `packages/db/security/verify-runtime-privileges.sql` as the runtime
   credential; require four rows and every `direct_dml_boundary = 'PASS'`.
5. Verify runtime can execute each allowed operation but cannot directly
   INSERT/UPDATE/DELETE guarded tables, ALTER TABLE, DISABLE TRIGGER, or
   SET ROLE to a privileged account. Repeat on PostgreSQL 16 in CI.
6. Verify rollback and failure handling under two-session concurrency and
   complete independent review before merge.

**Do not apply REVOKE in production before step 1 is complete.**
A green CI using a superuser database does not validate this security boundary.

## Implemented writers and boot enforcement

* `WorkOrderService.createTask` → `jev_create_task` and
  `WorkOrderService.transitionTask` → `jev_transition_task`.
* `ProjectRegistryService.register` → `jev_create_environment` for
  staging/production/development environment insertion.
* `setDeploymentStatuses` → `jev_set_deployment_status` and
  `withDeploymentWriteScopes` → `jev_lock_project_scope`.
* `apps/api/src/server.ts` and `apps/worker/src/server.ts` both invoke
  `checkDatabase(pool)` **before** accepting traffic/starting the queue.
  Production runtime refuses a migration owner, elevated role, missing guarded
  tables or any direct DML permission on the four protected tables.
* API auth, audit, control and worker queues receive explicit DML grants only
  on their **non-guarded** tables. Approval and Deployment INSERT operations
  remain prohibited to the runtime role until an individually reviewed writer
  exists; no blanket grant to bypass this boundary.

## Verifiable evidence and outstanding operational step

The `runtime-role.test.ts` integration test runs against a real PostgreSQL
role: direct guarded-table DML is denied; authorized Task, Environment,
Deployment, project locks, order history, auth sessions, audit events,
control writes and worker DML are exercised. The full CI must pass at the
**final HEAD**, not just on an ancestor commit.

**Actual deployment still needs its own evidence**: distinct runtime and
migrator credentials provisioned via secrets, runtime diagnostic reporting
four PASS rows, successful API/worker startup with the restricted role,
rejection of startup with migration credentials, and operator-approved
rollback procedure. The repository alone cannot attest live database grants.
