-- PLT-008 R3: human rework of an already APPROVED Task is atomic.
-- The old approval is staled by the insertion trigger; the subsequent
-- Task transition is performed inside the SAME SECURITY DEFINER statement.
-- Any transition failure rolls back both the decision and invalidation.
CREATE OR REPLACE FUNCTION jev_create_approval(
  p_project_id uuid, p_task_id uuid, p_actor_user_id uuid,
  p_decision text, p_revision text, p_commit_sha text,
  p_pull_request_url text, p_staging_url text, p_evidence jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $jev$
DECLARE
  v_id uuid;
  v_task_status text;
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
  SELECT status INTO v_task_status FROM tasks
  WHERE id = p_task_id AND project_id = p_project_id
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

  -- A rework decision must atomically revoke APPROVED status. Otherwise
  -- the supersession trigger would stale the previous APPROVED decision
  -- while a separate Task transition might never happen.
  IF v_task_status = 'APPROVED' AND p_decision = 'CHANGES_REQUESTED' THEN
    PERFORM jev_transition_task(
      p_task_id, 'CHANGES_REQUESTED', 'USER', p_actor_user_id::text,
      'human_review_rework', p_evidence
    );
  END IF;
  RETURN v_id;
END;
$jev$;

DO $jev_acl$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.jev_create_approval(uuid,uuid,uuid,text,text,text,text,text,jsonb) SET search_path = pg_catalog, %I, pg_temp',
    current_schema(),current_schema()
  );
END;
$jev_acl$;
REVOKE ALL ON FUNCTION jev_create_approval(uuid,uuid,uuid,text,text,text,text,text,jsonb) FROM PUBLIC;
