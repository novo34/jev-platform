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
  on their **non-guarded** tables. Controlled creation of staging Deployments
  and human Approvals is now provided by `jev_create_deployment` and
  `jev_create_approval` (`0015`), with project-before-Task locking,
  scope/reviewer validation and narrow EXECUTE rights. The TypeScript
  `createDeployment` and `createApproval` functions expose these writers.
  Upstream authorization must bind the approval actor to the authenticated
  principal; arbitrary client-supplied actor IDs are forbidden.
* Direct single-row and bulk INSERT/UPDATE/DELETE on guarded tables remains
  disallowed to the runtime role. A privileged DBA session can still bypass
  the runtime protocol and must never serve application traffic.

## Verifiable evidence and outstanding operational step

The `runtime-role.test.ts` integration test runs against a real PostgreSQL
role: direct guarded-table DML is denied; authorized Task, Environment,
Deployment, project locks, order history, auth sessions, audit events,
control writes and worker DML are exercised. Tests additionally cover
staging Deployment creation, human Approval insertion and the
`AWAITING_HUMAN -> APPROVED` transition, plus detection of column-grant and
SET ROLE privilege escalation. The full CI must pass at the
**final HEAD**, not just on an ancestor commit.

**Actual deployment still needs its own evidence**: distinct runtime and
migrator credentials provisioned via secrets, runtime diagnostic reporting
four PASS rows, successful API/worker startup with the restricted role,
rejection of startup with migration credentials, and operator-approved
rollback procedure. The repository alone cannot attest live database grants.

## Privilege escalation protections (2026-10-09)

* The runtime startup guard resolves **all four protected tables by explicit
  application-schema name** (currently `public`, the same schema targeted
  by provision-runtime-role.sql); it refuses connections with an active
  schema different from that configured target. The production SQL diagnostic
  is hard-pinned to `public` and fails on shadow `search_path` entries.
  A PostgreSQL integration test constructs read-only decoy tables alongside
  genuine guarded tables with column-level UPDATE privileges and verifies
  startup rejection. The isolated test uses an explicit schema parameter;
  production startup always defaults to `public`.


* `REVOKE ALL ON TABLE` does not clear historical column-level INSERT/UPDATE
  grants. The provisioning script explicitly revokes them; the runtime
  startup guard and verifier inspect each guarded column.
* A `PUBLIC` grant of `TRUNCATE` or `TRIGGER` on a guarded table can
  bypass lifecycle immutability or enable unsafe DDL despite role-specific
  REVOKE. Provisioning removes both PUBLIC grants; startup and diagnostic
  reject either one. A rollback-only PostgreSQL test reproduces the bypass.
* The `REPLICATION` role attribute can expose WAL/base-backup data even
  without ordinary DML privileges when replication connections are allowed.
  Provisioning enforces `NOREPLICATION`, and both startup and SQL diagnostics
  explicitly reject `rolreplication`.
* PostgreSQL 16 `NOINHERIT` does not preclude `SET ROLE` privilege
  escalation. Provisioning refuses pre-existing role memberships, and
  startup refuses **any** role membership, including INHERIT-only and
  SET FALSE memberships (stricter fail-closed policy).
* DB ownership inherently permits bypass of app-level ACLs; use migration
  credentials only in controlled administrative operations. The runtime is
  required to use the controlled database functions for all guarded writes.
