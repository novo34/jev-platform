-- PLT-008 F-04: privilege verification, read-only diagnostic.
-- Run with the SAME credentials used by the production application.
-- A row marked FAIL means the runtime role can bypass or modify a guarded
-- table directly. The migration/owner credential must NOT be used for this check.
WITH guarded_tables AS (
  SELECT c.oid, n.nspname AS schema_name, c.relname AS table_name,
         c.relowner, c.relrowsecurity
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname IN ('tasks', 'approvals', 'deployments', 'environments')
    AND c.relkind IN ('r', 'p')
),
checks AS (
  SELECT table_name,
         current_user AS runtime_role,
         pg_catalog.pg_get_userbyid(relowner) AS owner_role,
         pg_catalog.pg_has_role(current_user, relowner, 'MEMBER') AS inherits_owner_membership,
         pg_catalog.has_table_privilege(oid, 'INSERT') AS can_insert,
         pg_catalog.has_table_privilege(oid, 'UPDATE') AS can_update,
         pg_catalog.has_table_privilege(oid, 'DELETE') AS can_delete,
         (SELECT r.rolsuper OR r.rolbypassrls OR r.rolcreaterole
            FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) AS elevated_role
  FROM guarded_tables
)
SELECT *,
       CASE WHEN runtime_role = owner_role
                 OR inherits_owner_membership
                 OR elevated_role
                 OR can_insert OR can_update OR can_delete
            THEN 'FAIL'
            ELSE 'PASS'
       END AS direct_dml_boundary
FROM checks
ORDER BY table_name;

-- This diagnostic intentionally enforces the target architecture:
-- direct writes to guarded tables must be routed through approved functions.
-- Until those functions and service call sites exist, deploying a restricted
-- runtime role is NOT safe. A PASS alone does not prove full F-04 completion.
