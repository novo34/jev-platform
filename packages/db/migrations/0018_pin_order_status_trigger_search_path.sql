-- PLT-008: forward-only hardening of the one order trigger function
-- omitted from migration 0009. Its binding is now attested against the
-- canonical search_path, protecting unqualified table lookups from pg_temp.
DO $jev_pin_order_trigger$
DECLARE
  owner_schema text := current_schema();
BEGIN
  IF owner_schema IS NULL THEN
    RAISE EXCEPTION 'No current schema for order trigger hardening';
  END IF;
  EXECUTE format(
    'ALTER FUNCTION %I.validate_order_status_transition() SET search_path = pg_catalog, %I, pg_temp',
    owner_schema, owner_schema
  );
END;
$jev_pin_order_trigger$;
