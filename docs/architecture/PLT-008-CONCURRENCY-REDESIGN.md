# PLT-008 — Concurrency redesign decision record (draft, not accepted)

Status: **BLOCKED — implementation and two-session tests required**. Applies to PR #10 only; `main` and migration `0005` are immutable in this work.

## Confirmed defect

The current migration `0006` installs a global transaction advisory lock in a deployment BEFORE STATEMENT trigger, followed by Task row locks in deployment BEFORE ROW triggers. Other entry points acquire Task locks first (Task UPDATE and Approval INSERT), then can write deployments. This yields a cyclic wait graph: T1 holds Task(A), requests advisory; T2 holds advisory, requests Task(A). Existing green CI does not test this cycle.

## Non-negotiable invariants

1. A Task must not be APPROVED without a current non-stale authorized decision and the required staging evidence.
2. A staging deployment mutation (INSERT, UPDATE, DELETE, including bulk statements) must atomically invalidate impacted approvals or be rejected if it would invalidate an already APPROVED Task.
3. Direct SQL callers and service callers must satisfy the same database rules.
4. Operations spanning multiple Tasks must not rely on row execution order for lock ordering.
5. No trigger may acquire a global lock *after* a Task row lock can already have been acquired in the same transaction.
6. Failed concurrent operations must roll back atomically; no partial approval/evidence history.

## Redesign boundaries

Do **not** replace the global advisory lock with another uncoordinated lock. First choose and prove a single acquisition protocol for Task/Approval/Deployment writes, including existing transactions that already hold Task locks. Consider a narrowly scoped DB write API with revoked direct table-write privileges for runtime roles, explicit preflight locking in a deterministic order, and database triggers as defensive invariants. Bulk statements and legacy/direct SQL access require explicit handling. A statement-level transition-table approach alone does not guarantee locks are acquired before row modifications; verify trigger timing and visibility before selecting it.

The design must explicitly address concurrent Task→Deployment and Deployment→Task operations, multiple Tasks in opposite order, approval insertion vs staging replacement, deployment deletion, staging requirement changes, and transaction isolation semantics. If the chosen design uses locks on a separate per-Task guard relation, verify its interactions with existing Task row locks and foreign keys.

## Acceptance tests (real PostgreSQL, two or more connections)

- Reproduce the Task-row-then-deployment versus deployment-then-Task inversion, with bounded `lock_timeout`/`deadlock_timeout`; after redesign both transactions must terminate without SQLSTATE 40P01 and invariants must hold.
- Concurrent opposite-order multi-row deployment updates for Tasks A and B: no deadlock, no stale evidence retained as approved.
- Approval insertion racing with replacement/deletion/status downgrade of its staging deployment: either serializable success with valid evidence or explicit rejection.
- Concurrent Task promotion to APPROVED versus staging evidence mutation: cannot commit an APPROVED Task with stale/missing evidence.
- Verify transaction rollback and retries; tests must assert final persisted rows, not only absence of errors.

## Delivery gates

Document the selected lock graph, implement with an additive forward-only migration or replace the unmerged `0006` design after verifying migration rollout policy, add the tests above, pass CI, obtain zero-finding Codex review and independent review, then update Foundation. Do not advance PLT-009.
