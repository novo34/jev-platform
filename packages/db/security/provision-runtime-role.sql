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

-- Never embed a password here. Provision credentials using a secret manager.
-- Do not grant jev_runtime membership in the schema-owner or migrator role.
-- In PostgreSQL 16, NOINHERIT alone does not prevent SET ROLE: membership
-- grants must also exclude SET privileges.

REVOKE ALL ON TABLE tasks, approvals, deployments, environments FROM jev_runtime;
GRANT USAGE ON SCHEMA public TO jev_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO jev_runtime;

-- Only this controlled operation is granted at this stage.
GRANT EXECUTE ON FUNCTION jev_set_deployment_status(uuid, uuid[], text)
  TO jev_runtime;
-- Additional controlled write functions require individual review.
-- Do not use GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public.
-- Do not enable this credential for live traffic until those functions exist
-- and the runtime privilege verifier returns PASS for all guarded tables.
