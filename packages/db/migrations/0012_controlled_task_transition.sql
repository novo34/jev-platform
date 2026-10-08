-- PLT-008 F-04: task transitions are performed by a constrained owner function.
-- The runtime role must receive EXECUTE, never UPDATE on tasks.
CREATE FUNCTION jev_transition_task(
  p_task_id uuid,
  p_status text,
  p_actor_type text,
  p_actor_id text,
  p_cause text,
  p_evidence jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $jev$
DECLARE
  v_project uuid;
  v_updated uuid;
BEGIN
  IF p_status IS NULL OR p_status NOT IN (
    'PLANNED','READY','IN_PROGRESS','VERIFYING',
    'BLOCKED','FAILED','COMPLETED','CANCELLED'
  ) THEN
    RAISE EXCEPTION 'invalid task status' USING ERRCODE = '22023';
  END IF;
  IF p_actor_type NOT IN ('SYSTEM','USER','AGENT')
     OR NULLIF(btrim(p_cause),'') IS NULL
     OR (p_actor_type <> 'SYSTEM' AND NULLIF(btrim(p_actor_id),'') IS NULL) THEN
    RAISE EXCEPTION 'invalid transition context' USING ERRCODE = '22023';
  END IF;
  SELECT p.id INTO v_project
    FROM projects p JOIN tasks t ON t.project_id = p.id
   WHERE t.id = p_task_id FOR NO KEY UPDATE OF p;
  IF v_project IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('jev.transition_actor_type',p_actor_type,true);
  PERFORM set_config('jev.transition_actor_id',coalesce(p_actor_id,''),true);
  PERFORM set_config('jev.transition_cause',btrim(p_cause),true);
  PERFORM set_config('jev.transition_evidence',coalesce(p_evidence,'{}'::jsonb)::text,true);
  UPDATE tasks SET status = p_status WHERE id = p_task_id RETURNING id INTO v_updated;
  RETURN v_updated;
END;
$jev$;

DO $jev_acl$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.jev_transition_task(uuid,text,text,text,text,jsonb) SET search_path = pg_catalog, %I, pg_temp', current_schema(), current_schema());
END;
$jev_acl$;
REVOKE ALL ON FUNCTION jev_transition_task(uuid,text,text,text,text,jsonb) FROM PUBLIC;
