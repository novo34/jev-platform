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
6. Verify two-session concurrency regressions and finish independent review
   before merging development code; validate real backup/rollback at deployment.

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

**At deployment, external evidence is required**: distinct runtime and
migrator credentials provisioned via secrets, runtime diagnostic reporting
four PASS rows, successful API/worker startup with the restricted role,
rejection of startup with migration credentials, and operator-approved
rollback procedure. The repository alone cannot attest live database grants.

## Privilege escalation protections (2026-10-09)

* All catalog relations (`pg_class`, `pg_namespace`, `pg_attribute`,
  `pg_roles`) and privilege functions are explicitly qualified under
  `pg_catalog` so application objects cannot impersonate system catalogs.
  The role cannot CREATE objects in the canonical application schema:
  provisioning revokes `CREATE ON SCHEMA public` from both `PUBLIC` and
  `jev_runtime`; startup and SQL diagnostic reject effective schema-CREATE.
  PostgreSQL regression exercises catalog-object shadowing under
  `search_path = <app-schema>, pg_catalog`.
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
* PostgreSQL `REFERENCES` on a protected table or column must also be
  denied to the runtime, including grants inherited from `PUBLIC`. An
  attacker able to create foreign keys elsewhere can abuse certain
  privileged constraint paths. Provisioning revokes PUBLIC/table/column
  REFERENCES grants, and startup plus SQL diagnostics reject any effective
  REFERENCES right. Dedicated PostgreSQL tests exercise both scopes.
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


## Code acceptance versus production deployment (operator decision 2026-10-10)

**Development acceptance:** PLT-008 can merge after full CI and independent
zero-actionable-findings review of the final HEAD. The operator already has a
server but has explicitly scheduled its actual PostgreSQL/hosting deployment
for a later milestone. The live DB connection is therefore **not** required
to begin PLT-009.

**Deployment acceptance:** production traffic must not begin until the
real server passes the entire mandatory
[deployment checklist #11](https://github.com/novo34/jev-platform/issues/11).
The checklist stays OPEN until verified and is not considered complete by a
successful isolated CI run. Preserve separate operator sign-off, exact audited
commit/CI, database privilege verification and restoration evidence.

### Automated checks available now

* `platform-ci` runs `npm run smoke:restricted-runtime` against disposable
  PostgreSQL 16, installing the latest 17 checksum-protected migrations and
  launching the **built API and Worker** with `NODE_ENV=production` under
  the restricted role. It rejects API startup as privileged migrator and
  verifies four protected tables with PASS diagnostics.
* The smoke tests deliberately alter writer SECURITY DEFINER, owner and
  pinned search_path and try a migrator that can CREATE a schema but cannot
  ALTER managed objects; the verifier must fail each case.
* Authenticated identity is checked in addition to effective `current_user`:
  production API/Worker and the live database verifier require
  `session_user = current_user = jev_runtime`. Connection-string query
  parameters which could change the active role (such as `options=-c role=...`)
  are rejected; regression coverage tries to impersonate the runtime role
  from a privileged PostgreSQL session. The shared `createDatabasePool`
  constructor also rejects role-altering URL parameters and `PGOPTIONS`
  before API or Worker connection, preventing malicious
  `session_authorization` startup options. The real-process CI smoke
  confirms that both services fail to start under a forged URL.
* `scripts/verify-db-topology.mjs` is **read-only**. It requires distinct
  database runtime/migration identities, four protected-table PASS results,
  all seven controlled writers with trusted ownership, SECURITY DEFINER and
  pinned search_path, migration ownership/capability and exactly matching
  source-controlled migration checksums.
* `scripts/package-lock.json` pins the standalone production verifier's
  PostgreSQL client and all transitive package integrity hashes. The
  production workflow runs **`npm ci --ignore-scripts --prefix scripts`**
  rather than installing mutable dependencies. Checkout/setup-node actions
  are pinned to immutable reviewed SHA commits. The verifier no longer
  imports the application build, so no root workspace installation/build
  takes place on a runner that will receive production secrets.
* `jev_runtime` is not permitted to be a **member of** any other role
  and no other role may be a **member of `jev_runtime`**. The deployment
  verifier rejects both directions (including PostgreSQL 16 SET/INHERIT
  memberships), and provisioning refuses pre-existing memberships.
* Controlled SECURITY DEFINER function EXECUTE granted to `jev_runtime`
  may never have `WITH GRANT OPTION`, which would allow delegation to
  arbitrary callers. Provisioning strips historical runtime grant options;
  CI regression grants the option, proves the verifier fails, and confirms
  provisioning removes it.
* The read-only live database gate rejects URL `host`, `port`, `dbname`,
  `user`, `password` and other endpoint query overrides; it compares the
  established runtime/migrator PostgreSQL server address, port and
  postmaster start time in addition to database identity. This prevents
  attesting separate instances as one deployment.
* PostgreSQL drift checks reject function EXECUTE granted to `PUBLIC` or
  non-approved roles as well as a missing SECURITY DEFINER flag, owner,
  pinned search_path or runtime EXECUTE grant. Negative CI tests grant
  PUBLIC/foreign-role EXECUTE and confirm the gate fails.
* **No unreviewed privileged routine surface:** the live verifier enumerates
  every non-extension, non-trigger SECURITY DEFINER routine (functions **and**
  SQL procedures callable with `CALL`) in the canonical `public` schema. Any function outside the seven individually audited
  writer signatures fails the deployment gate, even when EXECUTE is currently
  revoked. A PostgreSQL CI negative test creates an unreviewed definer,
  observes rejection, and confirms removal restores the PASS condition.
  A second regression creates a `SECURITY DEFINER` procedure with PUBLIC
  EXECUTE, calls it as the runtime role and proves the verifier rejects it.
* **Migrator schema cannot drift:** the live verifier requires the actual
  migrator session's `current_schema()` to be `public`. This matters because
  the migration runner uses unqualified statements; a role-specific
  `search_path` selecting a shadow schema would otherwise silently apply
  migrations there. CI creates such a schema and role configuration and proves
  the verifier rejects it. Production setup must keep migrator search_path
  pinned to `public`, rather than merely granting CREATE on `public`.
* Migrator ownership checks exclude PostgreSQL **extension-owned**
  objects (such as functions installed by pgcrypto), while requiring
  effective owner privileges on JEV tables, sequences, functions and
  custom enum/domain types.
* The protected `.github/workflows/verify-production-db.yml` verifies
  the real server at deployment using a production GitHub Environment.
  Production URLs are injected **only into the final verifier step**,
  never into checkout, install or build actions. A skipped/missing-secret
  job never counts as production acceptance.

### Required when deploying on the available server

1. Configure actual PostgreSQL, API/Worker hosting, DNS/network security and
   reliable backups. Inject `DATABASE_URL` and `MIGRATION_DATABASE_URL`
   from a secure secret store; never write them in chat, source or CI logs.
2. Test backup restoration and rollback **before** running migrations.
3. Run `npm run db:migrate` with migrator credentials, then run the
   admin-only `packages/db/security/provision-runtime-role.sql` template.
4. Execute `node scripts/verify-db-topology.mjs` from an audited build with
   the **actual** server credentials. Record its sanitized PASS summary.
5. Run the protected main-branch verification workflow. Save its successful
   run ID and check the deployed API and Worker with restricted credentials;
   verify the privileged migration identity is rejected.
6. Record the operator's rollout sign-off in issue #11. If any check fails,
   stop production rollout; fix it before opening live traffic.

Do not merge implementation code into production as proof that the live
role has been provisioned: code/test completion and production deployment
are separate, explicitly audited acceptance events.
