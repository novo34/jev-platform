# PLT-008 — Concurrency redesign decision record (draft, not accepted)

Status: **REVIEW HOLD — CI remediation applied, independent and operational gates remain**.
The application-role protocol is implemented on PR #10 in migrations 0006–0015.
Do not merge or resume PLT-009 without accepting all R3 gates.

## Implementation checkpoint — 2026-10-09

The original global advisory lock was removed after a confirmed
Task-to-advisory/advisory-to-Task deadlock. The current protocol is:

1. Runtime transactions acquire a **project row** lock first, using
   `jev_lock_project_scope` or the dedicated SECURITY DEFINER writer.
2. Task/Approval/Deployment/Environment writes follow that lock; where multiple
   Tasks are affected, they are acquired deterministically.
3. The runtime has **no direct DML grants** on Tasks, Approvals, Deployments
   or Environments. The startup guard rejects table and column grants,
   role ownership/elevation and any SET ROLE-capable membership.
4. Authorized writers: `jev_create_task`, `jev_transition_task`,
   `jev_create_environment`, `jev_create_deployment`,
   `jev_create_approval`, `jev_set_deployment_status`.
   Existing triggers retain final review/scope/evidence enforcement.
5. API and Worker enforce role safety before startup; production migrations
   require separate credentials. Real PostgreSQL 16 integration tests exercise
   controlled creation, staging readiness, human review, approval, project
   lock contention, column-grant and SET ROLE rejection.

Original findings F-01/F-02/F-04/F-05 have code-level mitigations and
integration coverage; an independent review must still verify completeness.
F-03 has a safe controlled **runtime bulk status update** path, and
direct bulk INSERT/UPDATE/DELETE are rejected for the runtime role.

**Known boundary:** the preexisting privileged-owner diagnostic still
reproduces SQLSTATE `40P01` when arbitrary raw bulk deployment DML
is deliberately issued outside the approved writer APIs. This is not
safe for application traffic; the privileged credential must be restricted
to controlled migrations. Whether remaining privileged SQL exposure is
acceptable is an explicit F-03 review decision — it is not hidden by
green CI. Production role/secret/rollback evidence is a separate R3
release gate and has not been demonstrated by repository tests alone.

## F-02 concurrency reproduction specification (must fail before fix)

Set up one project/repository with a Task in AWAITING_HUMAN, a valid
non-stale APPROVED decision, and **no** staging Environment. Use three
independent PostgreSQL sessions: two writers and one observer.

1. T1 begins, promotes the Task to APPROVED and retains its transaction.
2. T2 begins while T1 remains open, inserts a staging Environment for the
   same project/repository and attempts to commit.
3. Observe the blocked or completed writer from a third session; do not
   assume that an approval UPDATE is equivalent to locking the Task.
4. Commit T1, then finish T2. Assert the persisted Task status, decision
   staleness, Environment and staging Deployment after both commits.
5. Repeat with T2 acquiring its lock first, and with UPDATE of an existing
   non-staging Environment to staging. Use bounded statement/lock timeouts,
   finally/ROLLBACK cleanup and independent connections.
6. A valid fix must reject one conflicting operation or produce a final
   state satisfying the approved-evidence invariant. In particular, it
   must never commit APPROVED with a stale approval or missing required
   staging evidence.

**Design gate:** Before implementing an Environment locking trigger, map
implicit row locks acquired by INSERT/UPDATE and FK checks. A project-level
lock taken after a Task row lock must not be paired with an Environment
writer that takes that same project lock and subsequently waits on the
Task; this would recreate a cycle. Validate the complete transaction
protocol, including bulk writes and owner/runtime privilege boundaries.

## F-03 bulk deployment deadlock gate

The current `trg_00_lock_task_for_staging_evidence_change` is a
`BEFORE ROW` trigger. Its per-row `ORDER BY task_id` cannot impose a
statement-wide lock order: two bulk statements visiting Task A then B
and Task B then A may each hold one Task lock while waiting for the other.
A successful single-row concurrency test is **not** evidence of bulk safety.

Required RED regression: create two Tasks and two mutable deployments,
open two PostgreSQL sessions, and issue opposite-order bulk updates with
a synchronization barrier after the first Task lock. Assert SQLSTATE
`40P01` (or an equivalent bounded failure) before redesign. Record
the resulting transaction state, roll back both sessions, and rerun the
same schedule against the fix. The GREEN acceptance condition is no
deadlock, atomic results, and preserved approval invariants.

Do not add a global advisory lock. A future bulk-write API must lock all
affected Tasks in sorted order **before** acquiring deployment row locks,
and runtime privileges must prevent bypass through direct table DML.
Account for PostgreSQL FK locks, UPDATE/DELETE row locks and trigger
execution order before accepting that protocol.

## Non-negotiable invariants

1. A Task must not be APPROVED without a current non-stale authorized decision and the required staging evidence.
2. A staging deployment mutation (INSERT, UPDATE, DELETE, including bulk statements) must atomically invalidate impacted approvals or be rejected if it would invalidate an already APPROVED Task.
3. Environment INSERT/UPDATE/DELETE (especially staging kind, project, repository and scope changes) must serialize with Task promotion and approval invalidation; APPROVED must never survive with stale approval or missing required staging evidence.
4. Direct SQL callers and service callers must satisfy the same database rules.
5. Operations spanning multiple Tasks must not rely on row execution order for lock ordering.
6. No trigger may acquire a global lock *after* a Task row lock can already have been acquired in the same transaction.
7. Failed concurrent operations must roll back atomically; no partial approval/evidence history.

## Redesign boundaries

Do **not** replace the global advisory lock with another uncoordinated lock. First choose and prove a single acquisition protocol for Task/Approval/Deployment/Environment writes, including existing transactions that already hold Task locks. Consider a narrowly scoped DB write API with revoked direct table-write privileges for runtime roles, explicit preflight locking in a deterministic order, and database triggers as defensive invariants. Bulk statements and legacy/direct SQL access require explicit handling. A statement-level transition-table approach alone does not guarantee locks are acquired before row modifications; verify trigger timing and visibility before selecting it.

The design must explicitly address concurrent Task→Environment, Environment→Task, Task→Deployment and Deployment→Task operations, multiple Tasks in opposite order, approval insertion vs staging replacement, deployment deletion, staging requirement changes, and transaction isolation semantics. If the chosen design uses locks on a separate per-Task guard relation, verify its interactions with existing Task row locks and foreign keys.

## Acceptance tests (real PostgreSQL, two or more connections)

- Reproduce the Task-row-then-deployment versus deployment-then-Task inversion, with bounded `lock_timeout`/`deadlock_timeout`; after redesign both transactions must terminate without SQLSTATE 40P01 and invariants must hold.
- Concurrent opposite-order multi-row deployment INSERT, UPDATE and DELETE for Tasks A and B: no deadlock, no stale evidence retained as approved. Include bulk reassignment where both OLD and NEW task IDs must be locked in deterministic order.
- Approval insertion racing with replacement/deletion/status downgrade of its staging deployment: either serializable success with valid evidence or explicit rejection.
- Concurrent Task promotion to APPROVED versus staging evidence mutation: cannot commit an APPROVED Task with stale/missing evidence.
- Concurrent AWAITING_HUMAN → APPROVED versus Environment INSERT or UPDATE of kind/project/repository/scope, including a transition from non-staging to staging: the committed Task must never be APPROVED with a stale approval or newly required but absent staging evidence. Include Environment DELETE if supported by foreign keys.\n- Privilege matrix: enumerate the actual runtime role(s), schema ownership, inherited grants, direct INSERT/UPDATE/DELETE permissions on tasks, approvals, deployments and environments, and EXECUTE rights for every approved write API. In integration tests, SET ROLE to each runtime role and prove direct single-row and bulk DML are rejected while each approved API succeeds; owner-only tests are insufficient.
- Verify transaction rollback and retries; tests must assert final persisted rows, not only absence of errors.

## Delivery gates

Document the selected lock graph and role privilege matrix, implement with an additive forward-only migration or replace the unmerged `0006` design after verifying migration rollout policy, add the tests above, pass CI, obtain zero-finding Codex review and independent review, then update Foundation. Do not advance PLT-009.
