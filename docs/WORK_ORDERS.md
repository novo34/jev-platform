# Work Orders and Tasks

PLT-008 establishes the canonical persisted lifecycle for work orders and tasks.

## Persistence

The existing `orders`, `requirements`, `tasks` and `task_runs` tables remain canonical. Migration `0005_work_order_task_lifecycle.sql` adds:

- database-enforced allowed order/task states;
- database-enforced legal status transitions;
- append-only order and task state-history tables;
- normalized `task_requirements` links so a task stores exact Requirement IDs.

Initial creation and every status change are recorded automatically by PostgreSQL triggers. This also covers orders created through the existing Control Plane.

## Domain service

`@jev/work-orders` provides:

- work-order creation with acceptance criteria and requirements;
- task creation with acceptance criteria and exact requirement IDs;
- order/task retrieval including persisted history;
- typed transition operations;
- typed errors for missing entities, invalid inputs and illegal transitions.

A task may only link requirements belonging to its own project and work order.

## Lifecycle

Order states:

`PLANNED → READY → IN_PROGRESS → COMPLETED`, with controlled BLOCKED/CANCELLED paths. A cancelled order may be reopened to PLANNED.

Task states:

`PLANNED → READY → IN_PROGRESS → VERIFYING → COMPLETED`, with controlled BLOCKED/FAILED/CANCELLED paths.

PostgreSQL is the final enforcement boundary; direct SQL cannot bypass an illegal transition.
