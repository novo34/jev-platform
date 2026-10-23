-- Narrow row-lock helper: runtime can hold human authority stable without
-- UPDATE grants on users or memberships. No authentication data is modified.
-- Callers lock the project first, then invoke this helper, then revalidate.
CREATE FUNCTION jev_lock_actor_authorization(p_user_id uuid, p_project_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $github_authority$
DECLARE v_id uuid;
BEGIN
  SELECT u.id INTO v_id FROM users u JOIN projects p ON p.organization_id=u.organization_id
    WHERE u.id=p_user_id AND p.id=p_project_id FOR SHARE OF u;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'actor scope not found' USING ERRCODE='23503';
  END IF;
  PERFORM 1 FROM project_memberships WHERE user_id=p_user_id AND project_id=p_project_id FOR SHARE;
  RETURN v_id;
END;
$github_authority$;
DO $github_authority_path$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.jev_lock_actor_authorization(uuid,uuid) SET search_path = pg_catalog, %I, pg_temp', current_schema(), current_schema());
END;
$github_authority_path$;
REVOKE ALL ON FUNCTION jev_lock_actor_authorization(uuid,uuid) FROM PUBLIC;
