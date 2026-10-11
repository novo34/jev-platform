-- F-04: controlled writers for task creation and environment registration.
-- Forward-only replacement of 0012, which used the pre-0006 task status list.
-- All functions run with the migration owner's privileges and a pinned schema.
CREATE OR REPLACE FUNCTION jev_transition_task(
  p_task_id uuid, p_status text, p_actor_type text, p_actor_id text,
  p_cause text, p_evidence jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $jev$
DECLARE
  v_project uuid;
  v_updated uuid;
BEGIN
  IF p_status IS NULL OR p_status NOT IN (
    'PLANNED','READY','RUNNING','VERIFYING','VERIFIED','STAGING',
    'AWAITING_HUMAN','APPROVED','DONE','BLOCKED','FAILED',
    'CHANGES_REQUESTED','REJECTED'
  ) THEN
    RAISE EXCEPTION 'invalid task status' USING ERRCODE = '22023';
  END IF;
  IF p_actor_type IS NULL OR p_actor_type NOT IN ('SYSTEM','USER','AGENT')
     OR NULLIF(btrim(coalesce(p_cause,'')),'') IS NULL
     OR (p_actor_type <> 'SYSTEM' AND NULLIF(btrim(coalesce(p_actor_id,'')),'') IS NULL)
     OR p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' THEN
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
  PERFORM set_config('jev.transition_evidence',p_evidence::text,true);
  UPDATE tasks SET status = p_status WHERE id = p_task_id RETURNING id INTO v_updated;
  RETURN v_updated;
END;
$jev$;

CREATE FUNCTION jev_create_task(
  p_project_id uuid, p_order_id uuid, p_repository_id uuid,
  p_title text, p_risk text, p_acceptance_criteria jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $jev$
DECLARE
  v_id uuid;
BEGIN
  IF p_project_id IS NULL OR p_order_id IS NULL OR p_repository_id IS NULL
     OR NULLIF(btrim(coalesce(p_title,'')),'') IS NULL
     OR p_risk IS NULL OR p_risk NOT IN ('R0','R1','R2','R3','R4')
     OR p_acceptance_criteria IS NULL OR jsonb_typeof(p_acceptance_criteria) <> 'array' THEN
    RAISE EXCEPTION 'invalid task creation arguments' USING ERRCODE = '22023';
  END IF;
  -- Project-first serialization with Environment inserts and Task transitions.
  PERFORM 1 FROM projects WHERE id = p_project_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project not found' USING ERRCODE = '23503';
  END IF;
  PERFORM 1 FROM orders WHERE id = p_order_id AND project_id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order outside task project' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM repositories WHERE id = p_repository_id AND project_id = p_project_id
  ) THEN
    RAISE EXCEPTION 'repository outside task project' USING ERRCODE = '23514';
  END IF;
  INSERT INTO tasks (
    project_id, order_id, repository_id, title, status, risk, acceptance_criteria
  ) VALUES (
    p_project_id, p_order_id, p_repository_id, btrim(p_title),
    'PLANNED', p_risk, p_acceptance_criteria
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$jev$;

CREATE FUNCTION jev_create_environment(
  p_project_id uuid, p_repository_id uuid, p_kind text,
  p_name text, p_url text, p_metadata jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $jev$
DECLARE
  v_id uuid;
BEGIN
  IF p_project_id IS NULL OR p_repository_id IS NULL
     OR p_kind IS NULL OR p_kind NOT IN ('development','staging','production')
     OR NULLIF(btrim(coalesce(p_name,'')),'') IS NULL
     OR p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object' THEN
    RAISE EXCEPTION 'invalid environment creation arguments' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM projects WHERE id = p_project_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project not found' USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM repositories WHERE id = p_repository_id AND project_id = p_project_id
  ) THEN
    RAISE EXCEPTION 'repository outside environment project' USING ERRCODE = '23514';
  END IF;
  -- Existing staging triggers enforce approved-task gates and stale approvals.
  INSERT INTO environments(project_id,repository_id,kind,name,url,metadata)
  VALUES(p_project_id,p_repository_id,p_kind,btrim(p_name),p_url,p_metadata)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$jev$;

DO $jev_acl$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.jev_transition_task(uuid,text,text,text,text,jsonb) SET search_path = pg_catalog, %I, pg_temp', s,s
  );
  EXECUTE format(
    'ALTER FUNCTION %I.jev_create_task(uuid,uuid,uuid,text,text,jsonb) SET search_path = pg_catalog, %I, pg_temp', s,s
  );
  EXECUTE format(
    'ALTER FUNCTION %I.jev_create_environment(uuid,uuid,text,text,text,jsonb) SET search_path = pg_catalog, %I, pg_temp', s,s
  );
END;
$jev_acl$;
REVOKE ALL ON FUNCTION jev_transition_task(uuid,text,text,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION jev_create_task(uuid,uuid,uuid,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION jev_create_environment(uuid,uuid,text,text,text,jsonb) FROM PUBLIC;
