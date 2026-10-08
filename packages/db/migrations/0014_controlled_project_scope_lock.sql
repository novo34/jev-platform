-- F-04: project row locking for restricted runtime transactions.
-- SELECT FOR NO KEY UPDATE requires UPDATE privileges when issued directly;
-- this narrow definer function takes the lock without exposing project DML.
CREATE FUNCTION jev_lock_project_scope(p_project_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $jev$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id
  FROM projects
  WHERE id = p_project_id
  FOR NO KEY UPDATE;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'project scope not found' USING ERRCODE = '23503';
  END IF;
  RETURN v_id;
END;
$jev$;
DO $jev_acl$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.jev_lock_project_scope(uuid) SET search_path = pg_catalog, %I, pg_temp',
    current_schema(), current_schema()
  );
END;
$jev_acl$;
REVOKE ALL ON FUNCTION jev_lock_project_scope(uuid) FROM PUBLIC;
