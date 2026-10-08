# PLT-008 F-04 — Runtime database privilege boundary

This document is an **implementation gate**, not evidence that F-04 is closed.

## Required deployment topology

* **Schema owner / migrator:** a separate credential allowed to run migrations
  and own guarded objects. It is never used by an application server or worker.
* **Runtime:** LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION,
  NOBYPASSRLS. It must not own, inherit ownership of, or hold direct INSERT,
  UPDATE or DELETE privileges on tasks, approvals, deployments or environments.
* **Controlled write entry points:** SECURITY DEFINER functions owned by a
  tightly scoped non-login role, with explicit schema-qualified relations,
  fixed trusted search_path, narrow EXECUTE grants and input validation.
  These functions must acquire project-scope locks before child-row locks.
* **Separate URLs:** migrations use the migrator connection; runtime uses its
  own connection. Never use the migration URL for the API or worker.

## Deployment sequence (must not be reordered)

1. Inventory all direct DML call sites for guarded tables, including workers,
   tests and operational scripts. Replace each production writer with controlled
   functions, including staging Environment creation and Task transitions.
2. Add explicit role/grant migrations in a controlled provisioning environment.
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
