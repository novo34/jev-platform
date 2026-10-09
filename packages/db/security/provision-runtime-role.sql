-- PLT-008 F-04: one-time role provisioning template.
-- Execute as a database administrator, NOT as the application.
-- This script is intentionally NOT a numbered schema migration because
-- managed PostgreSQL migrators often cannot CREATE ROLE.
-- Requires the application write endpoints to be converted to controlled
-- SECURITY DEFINER functions BEFORE enabling this role for live traffic.
DO $jev_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jev_runtime') THEN
    CREATE ROLE jev_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$jev_role$;

-- Fail closed for pre-existing dangerous role attributes or membership.
-- NOINHERIT does not prevent SET ROLE in PostgreSQL 16.
ALTER ROLE jev_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
DO $jev_memberships$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.member
    WHERE r.rolname = 'jev_runtime'
  ) THEN
    RAISE EXCEPTION
      'jev_runtime must have no role memberships; revoke them before provisioning'
      USING ERRCODE = '42501';
  END IF;
END;
$jev_memberships$;

-- Never embed a password here. Provision credentials using a secret manager.
-- Do not grant jev_runtime membership in the schema-owner or migrator role.
-- In PostgreSQL 16, NOINHERIT alone does not prevent SET ROLE: membership
-- grants must also exclude SET privileges.

REVOKE ALL ON TABLE tasks, approvals, deployments, environments FROM jev_runtime;
-- Table REVOKE does NOT revoke historical column-level INSERT/UPDATE grants.
DO $jev_revoke_cols$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT t.relname AS table_name, a.attname AS column_name
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid
    WHERE n.nspname = 'public' AND t.relkind IN ('r','p')
      AND t.relname IN ('tasks','approvals','deployments','environments')
      AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    EXECUTE format(
      'REVOKE INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.%I FROM jev_runtime',
      c.column_name, c.column_name, c.column_name, c.table_name
    );
  END LOOP;
END;
$jev_revoke_cols$;
GRANT USAGE ON SCHEMA public TO jev_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO jev_runtime;

-- Only this controlled operation is granted at this stage.
GRANT EXECUTE ON FUNCTION jev_set_deployment_status(uuid, uuid[], text)
  TO jev_runtime;
GRANT EXECUTE ON FUNCTION jev_transition_task(uuid, text, text, text, text, jsonb)
  TO jev_runtime;
-- Only non-guarded service tables receive DML permissions.
GRANT INSERT ON TABLE projects, repositories, orders, requirements, task_requirements,
  order_state_history TO jev_runtime;
GRANT UPDATE (status) ON TABLE orders TO jev_runtime;
-- API authentication and audit paths; no guarded-table privileges.
GRANT INSERT ON TABLE auth_sessions, audit_events TO jev_runtime;
GRANT UPDATE (last_seen_at) ON TABLE auth_sessions TO jev_runtime;
GRANT DELETE ON TABLE auth_sessions TO jev_runtime;
-- Control API changes only project operational state.
GRANT UPDATE (status, updated_at) ON TABLE projects TO jev_runtime;
-- Queue workers need to claim jobs and record worker heartbeats.
GRANT INSERT, UPDATE ON TABLE jobs, worker_instances TO jev_runtime;
GRANT EXECUTE ON FUNCTION jev_create_task(uuid, uuid, uuid, text, text, jsonb) TO jev_runtime;
GRANT EXECUTE ON FUNCTION jev_create_environment(uuid, uuid, text, text, text, jsonb) TO jev_runtime;
GRANT EXECUTE ON FUNCTION jev_lock_project_scope(uuid) TO jev_runtime;
-- Approval and Deployment creation are not yet exposed through authorized
-- writers; direct INSERT on approvals/deployments remains prohibited.
-- Additional controlled write functions require individual review.
-- Do not use GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public.
-- Do not enable this credential for live traffic until those functions exist
-- and the runtime privilege verifier returns PASS for all guarded tables.
