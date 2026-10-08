-- PLT-008 F-04/F-03: restricted, atomic deployment status writer.
-- No PUBLIC EXECUTE: privileges are granted to the runtime role only during
-- controlled provisioning. Function owner must be a non-login DB owner.
CREATE FUNCTION jev_set_deployment_status(
  p_project_id uuid, p_deployment_ids uuid[], p_status text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $jev_write$
DECLARE
  expected_count integer;
  updated_count integer;
BEGIN
  IF p_project_id IS NULL OR p_deployment_ids IS NULL
     OR cardinality(p_deployment_ids) = 0
     OR array_position(p_deployment_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'project and nonempty deployment IDs are required'
      USING ERRCODE = '22023';
  END IF;

  -- Explicit allowlist; table CHECK constraints still apply.
  IF p_status IS NULL OR p_status NOT IN
    ('READY', 'RUNNING', 'VERIFYING', 'VERIFIED', 'BLOCKED', 'FAILED', 'REJECTED') THEN
    RAISE EXCEPTION 'unsupported deployment status' USING ERRCODE = '22023';
  END IF;

  -- Shared project-first protocol. NO KEY UPDATE is compatible with FK checks.
  PERFORM 1 FROM public.projects WHERE id = p_project_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project does not exist' USING ERRCODE = '23503';
  END IF;

  SELECT count(*) INTO expected_count
    FROM (SELECT DISTINCT unnest(p_deployment_ids) AS id) ids;

  -- Lock each deployment in a stable order before performing a set-based write.
  PERFORM d.id
    FROM public.deployments d
    WHERE d.id = ANY(p_deployment_ids) AND d.project_id = p_project_id
    ORDER BY d.id
    FOR UPDATE;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> expected_count THEN
    RAISE EXCEPTION 'deployment IDs are missing or outside project scope'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.deployments
     SET status = p_status
   WHERE id = ANY(p_deployment_ids) AND project_id = p_project_id;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$jev_write$;

REVOKE ALL ON FUNCTION jev_set_deployment_status(uuid, uuid[], text) FROM PUBLIC;
