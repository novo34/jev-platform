-- PLT-008 F-04: complete the canonical human-review/staging write path.
-- The runtime has no direct DML on approvals or deployments.
-- Both definer functions acquire the project row before any Task row lock,
-- matching Task transitions and Environment writes (no Task -> project inversion).

CREATE FUNCTION jev_create_deployment(
  p_project_id uuid, p_repository_id uuid, p_environment_id uuid,
  p_task_id uuid, p_revision text, p_status text, p_url text,
  p_provider text, p_metadata jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $jev$
DECLARE
  v_id uuid;
BEGIN
  IF p_project_id IS NULL OR p_repository_id IS NULL OR p_environment_id IS NULL
     OR NULLIF(btrim(coalesce(p_revision, '')), '') IS NULL
     OR p_status IS NULL
     OR p_status NOT IN ('READY','RUNNING','VERIFYING','VERIFIED','BLOCKED','FAILED','REJECTED')
     OR p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object' THEN
    RAISE EXCEPTION 'invalid deployment creation arguments' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM projects WHERE id = p_project_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deployment project does not exist' USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM repositories
     WHERE id = p_repository_id AND project_id = p_project_id
  ) OR NOT EXISTS (
    SELECT 1 FROM environments
     WHERE id = p_environment_id
       AND project_id = p_project_id AND repository_id = p_repository_id
  ) THEN
    RAISE EXCEPTION 'deployment environment/repository outside project scope'
      USING ERRCODE = '23514';
  END IF;

  IF p_task_id IS NOT NULL THEN
    -- BEFORE-row Deployment triggers may lock this Task again (reentrant).
    PERFORM 1 FROM tasks
     WHERE id = p_task_id
       AND project_id = p_project_id AND repository_id = p_repository_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'deployment task outside project scope'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO deployments(
    project_id,repository_id,environment_id,task_id,
    revision,status,url,provider,metadata
  ) VALUES(
    p_project_id,p_repository_id,p_environment_id,p_task_id,
    btrim(p_revision),p_status,p_url,p_provider,p_metadata
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$jev$;

CREATE FUNCTION jev_create_approval(
  p_project_id uuid, p_task_id uuid, p_actor_user_id uuid,
  p_decision text, p_revision text, p_commit_sha text,
  p_pull_request_url text, p_staging_url text, p_evidence jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $jev$
DECLARE
  v_id uuid;
BEGIN
  IF p_project_id IS NULL OR p_task_id IS NULL OR p_actor_user_id IS NULL
     OR p_decision IS NULL
     OR p_decision NOT IN ('APPROVED','CHANGES_REQUESTED','REJECTED')
     OR p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION 'invalid human-review decision arguments'
      USING ERRCODE = '22023';
  END IF;

  -- Lock-order invariant: project precedes Task and Approval rows.
  PERFORM 1 FROM projects WHERE id = p_project_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval project does not exist' USING ERRCODE = '23503';
  END IF;
  PERFORM 1 FROM tasks WHERE id = p_task_id AND project_id = p_project_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval task outside project scope'
      USING ERRCODE = '23514';
  END IF;

  -- validate_approval_actor(), supersede_previous_task_approvals() and
  -- protect_persisted_approval() remain authoritative DB invariants.
  INSERT INTO approvals(
    task_id,actor_user_id,decision,revision,commit_sha,
    pull_request_url,staging_url,evidence
  ) VALUES(
    p_task_id,p_actor_user_id,p_decision,p_revision,p_commit_sha,
    p_pull_request_url,p_staging_url,p_evidence
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$jev$;

DO $jev_acl$
DECLARE s text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.jev_create_deployment(uuid,uuid,uuid,uuid,text,text,text,text,jsonb) SET search_path = pg_catalog, %I, pg_temp',
    s,s
  );
  EXECUTE format(
    'ALTER FUNCTION %I.jev_create_approval(uuid,uuid,uuid,text,text,text,text,text,jsonb) SET search_path = pg_catalog, %I, pg_temp',
    s,s
  );
END;
$jev_acl$;

REVOKE ALL ON FUNCTION jev_create_deployment(uuid,uuid,uuid,uuid,text,text,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION jev_create_approval(uuid,uuid,uuid,text,text,text,text,text,jsonb) FROM PUBLIC;
