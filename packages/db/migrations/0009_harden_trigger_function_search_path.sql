-- PLT-008 F-05: pin trigger-function name resolution to the schema that
-- owns the function. pg_temp must be last to prevent temp-object shadowing.
-- This migration is intentionally schema-relative for isolated test schemas.
DO $jev_harden$
DECLARE
  function_name text;
  owner_schema text := current_schema();
BEGIN
  IF owner_schema IS NULL THEN
    RAISE EXCEPTION 'No current schema for PLT-008 function hardening';
  END IF;
  FOREACH function_name IN ARRAY ARRAY[
    'protect_task_scope',
    'protect_referenced_environment_scope',
    'invalidate_approvals_on_staging_requirement_change',
    'protect_persisted_approval',
    'validate_approval_actor',
    'supersede_previous_task_approvals',
    'validate_initial_task_status',
    'validate_task_deployment_scope',
    'validate_task_status_transition',
    'invalidate_task_approvals_on_staging_change',
    'lock_task_for_staging_evidence_change',
    'record_order_state_history',
    'record_task_state_history',
    'reject_staging_requirement_for_approved_tasks'
  ] LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I() SET search_path = pg_catalog, %I, pg_temp',
      owner_schema, function_name, owner_schema
    );
  END LOOP;
END;
$jev_harden$;
