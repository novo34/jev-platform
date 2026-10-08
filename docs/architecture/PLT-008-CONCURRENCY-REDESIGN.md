# PLT-008 — Concurrency redesign decision record (draft, not accepted)

Status: **BLOCKED — critical concurrency and enforcement work remains**. Applies to PR #10 only; `main` and migration `0005` are immutable in this work.

## Confirmed defect and current remediation state

The original deployment statement-wide advisory lock caused a confirmed
Task-to-advisory/advisory-to-Task deadlock (SQLSTATE 40P01). Commit `9a6df8e`
removed that lock; commit `4af11dc` updated the two-session regression
test to observe PostgreSQL blocking rather than the removed lock. CI passed
on `4af11dc`, but this proves only that particular cycle is gone.

The independent audit identified additional acceptance blockers:
- F-01 (P1): approved Tasks can retain stale approvals after staging evidence
  changes. Commit `413ebcb` adds a conservative rejection for deployment
  writes targeting APPROVED Tasks; dedicated tests and behavior refinement
  remain required.
- F-02 (P1): Environment staging requirement changes can race with Task
  promotion. No transactional serialization protocol has been implemented.
- F-03 (P2): bulk deployment operations can acquire Task locks in inconsistent
  row visitation order. No deterministic bulk preflight is implemented.
- F-04/F-05 (P2): runtime DB permissions and trusted function search paths
  are not yet enforced.

Do not merge until the transaction protocol, runtime privileges, concurrent
tests and independent review satisfy the acceptance gates below.

## Non-negotiable invariants

1. A Task must not be APPROVED without a current non-stale authorized decision and the required staging evidence.
2. A staging deployment mutation (INSERT, UPDATE, DELETE, including bulk statements) must atomically invalidate impacted approvals or be rejected if it would invalidate an already APPROVED Task.
3. Environment INSERT/UPDATE/DELETE (especially staging kind, project, repository and scope changes) must serialize with Task promotion and approval invalidation; APPROVED must never survive with stale approval or missing required staging evidence.\n4. Direct SQL callers and service callers must satisfy the same database rules.
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
- Concurrent Task promotion to APPROVED versus staging evidence mutation: cannot commit an APPROVED Task with stale/missing evidence.\n- Concurrent AWAITING_HUMAN → APPROVED versus Environment INSERT or UPDATE of kind/project/repository/scope, including a transition from non-staging to staging: the committed Task must never be APPROVED with a stale approval or newly required but absent staging evidence. Include Environment DELETE if supported by foreign keys.\n- Privilege matrix: enumerate the actual runtime role(s), schema ownership, inherited grants, direct INSERT/UPDATE/DELETE permissions on tasks, approvals, deployments and environments, and EXECUTE rights for every approved write API. In integration tests, SET ROLE to each runtime role and prove direct single-row and bulk DML are rejected while each approved API succeeds; owner-only tests are insufficient.
- Verify transaction rollback and retries; tests must assert final persisted rows, not only absence of errors.

## Delivery gates

Document the selected lock graph and role privilege matrix, implement with an additive forward-only migration or replace the unmerged `0006` design after verifying migration rollout policy, add the tests above, pass CI, obtain zero-finding Codex review and independent review, then update Foundation. Do not advance PLT-009.
