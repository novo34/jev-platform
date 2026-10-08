-- PLT-008 review remediation.
-- Never edit 0005 after deployment: evolve the canonical lifecycle here.

ALTER TABLE order_state_history
  ADD COLUMN actor_type TEXT,
  ADD COLUMN actor_id TEXT,
  ADD COLUMN cause TEXT,
  ADD COLUMN evidence JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE task_state_history
  ADD COLUMN actor_type TEXT,
  ADD COLUMN actor_id TEXT,
  ADD COLUMN cause TEXT,
  ADD COLUMN evidence JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE order_state_history
SET actor_type = 'SYSTEM',
    cause = 'legacy_transition'
WHERE actor_type IS NULL;

UPDATE task_state_history
SET actor_type = 'SYSTEM',
    cause = 'legacy_transition'
WHERE actor_type IS NULL;

ALTER TABLE order_state_history
  ALTER COLUMN actor_type SET NOT NULL,
  ALTER COLUMN cause SET NOT NULL;

ALTER TABLE task_state_history
  ALTER COLUMN actor_type SET NOT NULL,
  ALTER COLUMN cause SET NOT NULL;

-- Temporarily remove the legacy PLT-008 guard so existing rows can be
-- canonicalized without being rejected by the old state machine.
DROP TRIGGER trg_validate_task_status_transition ON tasks;
DROP TRIGGER trg_record_task_state_history ON tasks;
ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;

-- Canonicalize legacy PLT-008 task states without manufacturing DONE.
UPDATE tasks
SET status = CASE status
  WHEN 'IN_PROGRESS' THEN 'RUNNING'
  WHEN 'COMPLETED' THEN 'VERIFIED'
  WHEN 'CANCELLED' THEN 'REJECTED'
  ELSE status
END
WHERE status IN ('IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- Backfill legacy repositoryless Tasks only when the project has exactly
-- one registered repository. Ambiguous legacy rows require explicit repair.
UPDATE tasks t
SET repository_id = (
  SELECT r.id
  FROM repositories r
  WHERE r.project_id = t.project_id
  ORDER BY r.id
  LIMIT 1
)
WHERE (
    t.repository_id IS NULL OR
    NOT EXISTS (
      SELECT 1
      FROM repositories existing_repo
      WHERE existing_repo.id = t.repository_id
        AND existing_repo.project_id = t.project_id
    )
  )
  AND (
    SELECT COUNT(*)
    FROM repositories r2
    WHERE r2.project_id = t.project_id
  ) = 1;

DO $jev$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tasks t
    WHERE t.repository_id IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM repositories r
         WHERE r.id = t.repository_id
           AND r.project_id = t.project_id
       )
  ) THEN
    RAISE EXCEPTION
      'legacy tasks require explicit project-scoped repository remediation'
      USING ERRCODE = '23514';
  END IF;
END;
$jev$;

ALTER TABLE tasks
  ALTER COLUMN repository_id SET NOT NULL;

CREATE UNIQUE INDEX idx_repositories_project_id_id
  ON repositories(project_id, id);

CREATE OR REPLACE FUNCTION protect_task_scope()
RETURNS TRIGGER AS $taskscope$
BEGIN
  IF OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.repository_id IS DISTINCT FROM NEW.repository_id THEN
    RAISE EXCEPTION
      'task project/repository scope is immutable; create a new task for a new target'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$taskscope$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_task_scope
BEFORE UPDATE OF project_id, repository_id ON tasks
FOR EACH ROW EXECUTE FUNCTION protect_task_scope();

ALTER TABLE tasks
  ADD CONSTRAINT tasks_project_repository_fk
  FOREIGN KEY (project_id, repository_id)
  REFERENCES repositories(project_id, id);

-- Backfill legacy repositoryless environments only when the project target is unambiguous.
UPDATE environments e
SET repository_id = (
  SELECT r.id
  FROM repositories r
  WHERE r.project_id = e.project_id
  ORDER BY r.id
  LIMIT 1
)
WHERE e.repository_id IS NULL
  AND (
    SELECT COUNT(*)
    FROM repositories r2
    WHERE r2.project_id = e.project_id
  ) = 1;

DO $envcheck$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM environments e
    WHERE e.repository_id IS NULL
       OR NOT EXISTS (
        SELECT 1
        FROM repositories r
        WHERE r.id = e.repository_id
          AND r.project_id = e.project_id
      )
  ) THEN
    RAISE EXCEPTION
      'legacy environments require explicit project-scoped repository remediation'
      USING ERRCODE = '23514';
  END IF;
END;
$envcheck$;

ALTER TABLE environments
  ALTER COLUMN repository_id SET NOT NULL;

ALTER TABLE environments
  ADD CONSTRAINT environments_project_repository_fk
  FOREIGN KEY (project_id, repository_id)
  REFERENCES repositories(project_id, id);

CREATE OR REPLACE FUNCTION protect_referenced_environment_scope()
RETURNS TRIGGER AS $environment$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM deployments d
    WHERE d.environment_id = OLD.id
  ) AND (
    OLD.project_id IS DISTINCT FROM NEW.project_id OR
    OLD.repository_id IS DISTINCT FROM NEW.repository_id OR
    OLD.kind IS DISTINCT FROM NEW.kind
  ) THEN
    RAISE EXCEPTION
      'cannot change project/repository/kind of an environment referenced by deployments'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$environment$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_referenced_environment_scope
BEFORE UPDATE OF project_id, repository_id, kind ON environments
FOR EACH ROW EXECUTE FUNCTION protect_referenced_environment_scope();

CREATE OR REPLACE FUNCTION invalidate_approvals_on_staging_requirement_change()
RETURNS TRIGGER AS $staging_requirement$
BEGIN
  IF NEW.kind = 'staging'
     AND (
       TG_OP = 'INSERT'
       OR OLD.kind IS DISTINCT FROM NEW.kind
       OR OLD.project_id IS DISTINCT FROM NEW.project_id
       OR OLD.repository_id IS DISTINCT FROM NEW.repository_id
     ) THEN
    UPDATE approvals a
    SET stale = TRUE
    FROM tasks t
    WHERE a.task_id = t.id
      AND a.stale = FALSE
      AND t.project_id = NEW.project_id
      AND t.repository_id = NEW.repository_id;
  END IF;

  RETURN NEW;
END;
$staging_requirement$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invalidate_approvals_on_staging_requirement_change
AFTER INSERT OR UPDATE OF project_id, repository_id, kind ON environments
FOR EACH ROW EXECUTE FUNCTION invalidate_approvals_on_staging_requirement_change();

UPDATE task_state_history
SET from_status = CASE from_status
      WHEN 'IN_PROGRESS' THEN 'RUNNING'
      WHEN 'COMPLETED' THEN 'VERIFIED'
      WHEN 'CANCELLED' THEN 'REJECTED'
      ELSE from_status
    END,
    to_status = CASE to_status
      WHEN 'IN_PROGRESS' THEN 'RUNNING'
      WHEN 'COMPLETED' THEN 'VERIFIED'
      WHEN 'CANCELLED' THEN 'REJECTED'
      ELSE to_status
    END;

-- Approvals written before this migration did not pass the new human-review,
-- actor-authorization, deployment-binding and append-only invariants. Treat all
-- legacy decisions as historical evidence only; a fresh post-migration human
-- decision is required before APPROVED can be entered.
UPDATE approvals
SET stale = TRUE
WHERE stale = FALSE;

CREATE OR REPLACE FUNCTION protect_persisted_approval()
RETURNS TRIGGER AS $approval_immutable$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'persisted approvals are append-only and cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.task_id IS DISTINCT FROM NEW.task_id
     OR OLD.actor_user_id IS DISTINCT FROM NEW.actor_user_id
     OR OLD.decision IS DISTINCT FROM NEW.decision
     OR OLD.revision IS DISTINCT FROM NEW.revision
     OR OLD.commit_sha IS DISTINCT FROM NEW.commit_sha
     OR OLD.pull_request_url IS DISTINCT FROM NEW.pull_request_url
     OR OLD.staging_url IS DISTINCT FROM NEW.staging_url
     OR OLD.evidence IS DISTINCT FROM NEW.evidence
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR (OLD.stale = TRUE AND NEW.stale = FALSE) THEN
    RAISE EXCEPTION
      'persisted approvals are append-only; only stale false-to-true invalidation is allowed'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$approval_immutable$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_persisted_approval
BEFORE UPDATE OR DELETE ON approvals
FOR EACH ROW EXECUTE FUNCTION protect_persisted_approval();

CREATE OR REPLACE FUNCTION validate_approval_actor()
RETURNS TRIGGER AS $approval_actor$
DECLARE
  task_project_id UUID;
  task_organization_id UUID;
BEGIN
  SELECT t.project_id, p.organization_id
  INTO task_project_id, task_organization_id
  FROM tasks t
  JOIN projects p ON p.id = t.project_id
  WHERE t.id = NEW.task_id
  FOR UPDATE OF t;

  IF task_project_id IS NULL THEN
    RAISE EXCEPTION 'approval task does not exist'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM tasks t
    WHERE t.id = NEW.task_id
      AND (
        t.status = 'AWAITING_HUMAN'
        OR (
          t.status = 'APPROVED'
          AND NEW.decision = 'CHANGES_REQUESTED'
        )
      )
  ) THEN
    RAISE EXCEPTION
      'approval decision is not valid for the task review state'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM users u
    WHERE u.id = NEW.actor_user_id
      AND u.organization_id = task_organization_id
      AND u.status = 'ACTIVE'
      AND (
        u.role = 'ADMIN'
        OR EXISTS (
          SELECT 1
          FROM project_memberships pm
          WHERE pm.project_id = task_project_id
            AND pm.user_id = u.id
            AND pm.role = 'PROJECT_MANAGER'
        )
      )
  ) THEN
    RAISE EXCEPTION
      'approval actor is not authorized for the task project'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$approval_actor$ LANGUAGE plpgsql;

CREATE TRIGGER trg_00_validate_approval_actor
BEFORE INSERT ON approvals
FOR EACH ROW EXECUTE FUNCTION validate_approval_actor();

CREATE OR REPLACE FUNCTION supersede_previous_task_approvals()
RETURNS TRIGGER AS $decision$
BEGIN
  UPDATE approvals
  SET stale = TRUE
  WHERE task_id = NEW.task_id
    AND stale = FALSE;
  RETURN NEW;
END;
$decision$ LANGUAGE plpgsql;

CREATE TRIGGER trg_supersede_previous_task_approvals
BEFORE INSERT ON approvals
FOR EACH ROW EXECUTE FUNCTION supersede_previous_task_approvals();

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (
    status IN (
      'PLANNED',
      'READY',
      'RUNNING',
      'VERIFYING',
      'VERIFIED',
      'STAGING',
      'AWAITING_HUMAN',
      'APPROVED',
      'DONE',
      'BLOCKED',
      'FAILED',
      'CHANGES_REQUESTED',
      'REJECTED'
    )
  );

-- A Task must always enter the lifecycle at PLANNED. Transition and
-- promotion gates only run after insertion, so accepting a caller-supplied
-- terminal/intermediate initial state would bypass those invariants.
CREATE OR REPLACE FUNCTION validate_initial_task_status()
RETURNS TRIGGER AS $initial_task_status$
BEGIN
  IF NEW.status <> 'PLANNED' THEN
    RAISE EXCEPTION 'new tasks must start in PLANNED, got %', NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$initial_task_status$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_initial_task_status
BEFORE INSERT ON tasks
FOR EACH ROW EXECUTE FUNCTION validate_initial_task_status();

-- Deployments must be scoped to the same project/repository as both their
-- environment and, when present, their task. Validate legacy rows before
-- installing race-safe composite foreign keys.
DO $deployment_scope_check$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM deployments d
    JOIN environments e ON e.id = d.environment_id
    WHERE e.project_id IS DISTINCT FROM d.project_id
       OR e.repository_id IS DISTINCT FROM d.repository_id
  ) THEN
    RAISE EXCEPTION
      'legacy deployments require explicit environment scope remediation'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM deployments d
    JOIN tasks t ON t.id = d.task_id
    WHERE d.task_id IS NOT NULL
      AND (
        t.project_id IS DISTINCT FROM d.project_id
        OR t.repository_id IS DISTINCT FROM d.repository_id
      )
  ) THEN
    RAISE EXCEPTION
      'legacy deployments require explicit task scope remediation'
      USING ERRCODE = '23514';
  END IF;
END;
$deployment_scope_check$;

CREATE UNIQUE INDEX idx_environments_project_repository_id
  ON environments(project_id, repository_id, id);

CREATE UNIQUE INDEX idx_tasks_project_repository_id
  ON tasks(project_id, repository_id, id);

ALTER TABLE deployments
  ADD CONSTRAINT deployments_environment_scope_fk
  FOREIGN KEY (project_id, repository_id, environment_id)
  REFERENCES environments(project_id, repository_id, id);

ALTER TABLE deployments
  ADD CONSTRAINT deployments_task_scope_fk
  FOREIGN KEY (project_id, repository_id, task_id)
  REFERENCES tasks(project_id, repository_id, id);

CREATE OR REPLACE FUNCTION validate_task_deployment_scope()
RETURNS TRIGGER AS $deploy$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION
      'deployment created_at is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM environments e
    WHERE e.id = NEW.environment_id
      AND e.project_id = NEW.project_id
      AND e.repository_id = NEW.repository_id
  ) THEN
    RAISE EXCEPTION
      'deployment environment must match deployment project/repository scope'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.task_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM tasks t
    WHERE t.id = NEW.task_id
      AND t.project_id = NEW.project_id
      AND t.repository_id = NEW.repository_id
  ) THEN
    RAISE EXCEPTION
      'deployment project/repository must match the task scope'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$deploy$ LANGUAGE plpgsql;
CREATE TRIGGER trg_validate_task_deployment_scope
BEFORE INSERT OR UPDATE OF project_id, repository_id, environment_id, task_id, created_at
ON deployments
FOR EACH ROW EXECUTE FUNCTION validate_task_deployment_scope();

CREATE OR REPLACE FUNCTION validate_task_status_transition()
RETURNS TRIGGER AS $$
DECLARE
  transition_evidence JSONB := COALESCE(
    NULLIF(current_setting('jev.transition_evidence', true), '')::jsonb,
    '{}'::jsonb
  );
  staging_required BOOLEAN;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM environments e
    WHERE e.project_id = NEW.project_id
      AND e.repository_id = NEW.repository_id
      AND e.kind = 'staging'
  )
  INTO staging_required;

  IF NEW.status = 'AWAITING_HUMAN' AND staging_required THEN
    IF NOT EXISTS (
      SELECT 1
      FROM deployments d
      JOIN environments e ON e.id = d.environment_id
      WHERE d.task_id = NEW.id
        AND d.project_id = NEW.project_id
        AND d.repository_id = NEW.repository_id
        AND e.project_id = NEW.project_id
        AND e.repository_id = NEW.repository_id
        AND e.kind = 'staging'
        AND d.id = (
          SELECT d2.id
          FROM deployments d2
          JOIN environments e2 ON e2.id = d2.environment_id
          WHERE d2.task_id = NEW.id
            AND d2.project_id = NEW.project_id
            AND d2.repository_id = NEW.repository_id
            AND e2.project_id = NEW.project_id
            AND e2.repository_id = NEW.repository_id
            AND e2.kind = 'staging'
          ORDER BY d2.created_at DESC, d2.id DESC
          LIMIT 1
        )
        AND d.status = 'READY'
        AND d.url IS NOT NULL
        AND d.revision IS NOT NULL
        AND transition_evidence->>'stagingDeploymentId' = d.id::text
        AND transition_evidence->>'revision' = d.revision
        AND transition_evidence->>'url' = d.url
    ) THEN
      RAISE EXCEPTION
        'task requires readiness evidence bound to the current ready staging deployment'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'APPROVED' THEN
    IF staging_required THEN
      IF NOT EXISTS (
        SELECT 1
        FROM approvals a
        JOIN deployments d
          ON d.task_id = a.task_id
         AND d.revision = a.revision
         AND d.url = a.staging_url
         AND a.evidence->>'stagingDeploymentId' = d.id::text
        JOIN environments e ON e.id = d.environment_id
        WHERE a.task_id = NEW.id
          AND a.stale = FALSE
          AND a.decision = 'APPROVED'
          AND a.stale = FALSE
          AND a.revision IS NOT NULL
          AND a.commit_sha IS NOT NULL
          AND a.pull_request_url IS NOT NULL
          AND a.staging_url IS NOT NULL
          AND e.kind = 'staging'
          AND d.project_id = NEW.project_id
          AND d.repository_id = NEW.repository_id
          AND e.project_id = NEW.project_id
          AND e.repository_id = NEW.repository_id
          AND d.status = 'READY'
          AND d.id = (
            SELECT d2.id
            FROM deployments d2
            JOIN environments e2 ON e2.id = d2.environment_id
            WHERE d2.task_id = NEW.id
              AND d2.project_id = NEW.project_id
              AND d2.repository_id = NEW.repository_id
              AND e2.project_id = NEW.project_id
              AND e2.repository_id = NEW.repository_id
              AND e2.kind = 'staging'
            ORDER BY d2.created_at DESC, d2.id DESC
            LIMIT 1
          )
      ) THEN
        RAISE EXCEPTION
          'task requires approval bound to the exact current staging deployment'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1
        FROM approvals a
        WHERE a.task_id = NEW.id
          AND a.stale = FALSE
          AND a.decision = 'APPROVED'
          AND a.stale = FALSE
          AND a.revision IS NOT NULL
          AND a.commit_sha IS NOT NULL
          AND a.pull_request_url IS NOT NULL
          AND a.evidence <> '{}'::jsonb
      ) THEN
        RAISE EXCEPTION
          'task requires a persisted non-stale approval'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF (
       OLD.status = 'AWAITING_HUMAN'
       AND NEW.status IN ('CHANGES_REQUESTED', 'REJECTED')
     )
     OR (
       OLD.status = 'APPROVED'
       AND NEW.status = 'CHANGES_REQUESTED'
     ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM approvals a
      WHERE a.task_id = NEW.id
        AND a.stale = FALSE
        AND a.decision = NEW.status
        AND a.stale = FALSE
    ) THEN
      RAISE EXCEPTION
        'task requires a persisted human decision matching %', NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status IN ('APPROVED', 'AWAITING_HUMAN')
     AND NEW.status = 'CHANGES_REQUESTED' THEN
    UPDATE approvals
    SET stale = TRUE
    WHERE task_id = NEW.id AND stale = FALSE;
  END IF;

  IF NOT (
    (OLD.status = 'PLANNED' AND NEW.status IN ('READY', 'BLOCKED', 'REJECTED')) OR
    (OLD.status = 'READY' AND NEW.status IN ('RUNNING', 'BLOCKED', 'REJECTED')) OR
    (OLD.status = 'RUNNING' AND NEW.status IN ('VERIFYING', 'BLOCKED', 'FAILED')) OR
    (OLD.status = 'VERIFYING' AND NEW.status IN ('VERIFIED', 'RUNNING', 'BLOCKED', 'FAILED')) OR
    (OLD.status = 'VERIFIED' AND NEW.status IN ('STAGING', 'RUNNING')) OR
    (OLD.status = 'STAGING' AND NEW.status IN ('AWAITING_HUMAN', 'BLOCKED', 'FAILED')) OR
    (OLD.status = 'AWAITING_HUMAN' AND NEW.status IN ('APPROVED', 'CHANGES_REQUESTED', 'REJECTED')) OR
    (OLD.status = 'APPROVED' AND NEW.status = 'CHANGES_REQUESTED') OR
    (OLD.status = 'CHANGES_REQUESTED' AND NEW.status IN ('READY', 'RUNNING', 'REJECTED')) OR
    (OLD.status = 'BLOCKED' AND NEW.status IN ('READY', 'RUNNING', 'REJECTED')) OR
    (OLD.status = 'FAILED' AND NEW.status IN ('READY', 'RUNNING', 'REJECTED'))
  ) THEN
    RAISE EXCEPTION 'illegal task status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_task_status_transition
BEFORE UPDATE OF status ON tasks
FOR EACH ROW EXECUTE FUNCTION validate_task_status_transition();

CREATE OR REPLACE FUNCTION invalidate_task_approvals_on_staging_change()
RETURNS TRIGGER AS $approval$
DECLARE
  new_is_staging BOOLEAN := FALSE;
  old_is_staging BOOLEAN := FALSE;
  new_is_current BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.task_id IS NOT NULL THEN
      SELECT (
        kind = 'staging'
        AND project_id = OLD.project_id
        AND repository_id = OLD.repository_id
      )
      INTO old_is_staging
      FROM environments
      WHERE id = OLD.environment_id;

      IF old_is_staging THEN
        UPDATE approvals a
        SET stale = TRUE
        WHERE a.task_id = OLD.task_id
          AND a.stale = FALSE
          AND a.evidence->>'stagingDeploymentId' = OLD.id::text;
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  SELECT (
    kind = 'staging'
    AND project_id = NEW.project_id
    AND repository_id = NEW.repository_id
  )
  INTO new_is_staging
  FROM environments
  WHERE id = NEW.environment_id;

  IF TG_OP = 'INSERT' THEN
    IF new_is_staging AND NEW.task_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM deployments d
        JOIN environments e ON e.id = d.environment_id
        WHERE d.id = NEW.id
          AND d.task_id = NEW.task_id
          AND d.project_id = NEW.project_id
          AND d.repository_id = NEW.repository_id
          AND e.project_id = NEW.project_id
          AND e.repository_id = NEW.repository_id
          AND e.kind = 'staging'
          AND d.id = (
            SELECT d2.id
            FROM deployments d2
            JOIN environments e2 ON e2.id = d2.environment_id
            WHERE d2.task_id = NEW.task_id
              AND d2.project_id = NEW.project_id
              AND d2.repository_id = NEW.repository_id
              AND e2.project_id = NEW.project_id
              AND e2.repository_id = NEW.repository_id
              AND e2.kind = 'staging'
            ORDER BY d2.created_at DESC, d2.id DESC
            LIMIT 1
          )
      )
      INTO new_is_current;

      IF new_is_current THEN
        UPDATE approvals a
        SET stale = TRUE
        WHERE a.task_id = NEW.task_id
          AND a.stale = FALSE
          AND a.evidence->>'stagingDeploymentId' IS DISTINCT FROM NEW.id::text;
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.task_id IS NOT NULL THEN
    SELECT (
      kind = 'staging'
      AND project_id = OLD.project_id
      AND repository_id = OLD.repository_id
    )
    INTO old_is_staging
    FROM environments
    WHERE id = OLD.environment_id;

    IF old_is_staging AND (
      OLD.project_id IS DISTINCT FROM NEW.project_id OR
      OLD.repository_id IS DISTINCT FROM NEW.repository_id OR
      OLD.environment_id IS DISTINCT FROM NEW.environment_id OR
      OLD.task_id IS DISTINCT FROM NEW.task_id OR
      OLD.revision IS DISTINCT FROM NEW.revision OR
      OLD.url IS DISTINCT FROM NEW.url OR
      OLD.status IS DISTINCT FROM NEW.status
    ) THEN
      UPDATE approvals a
      SET stale = TRUE
      WHERE a.task_id = OLD.task_id
        AND a.stale = FALSE
        AND a.evidence->>'stagingDeploymentId' = OLD.id::text;
    END IF;
  END IF;

  IF new_is_staging AND NEW.task_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM deployments d
      JOIN environments e ON e.id = d.environment_id
      WHERE d.id = NEW.id
        AND d.task_id = NEW.task_id
        AND d.project_id = NEW.project_id
        AND d.repository_id = NEW.repository_id
        AND e.project_id = NEW.project_id
        AND e.repository_id = NEW.repository_id
        AND e.kind = 'staging'
        AND d.id = (
          SELECT d2.id
          FROM deployments d2
          JOIN environments e2 ON e2.id = d2.environment_id
          WHERE d2.task_id = NEW.task_id
            AND d2.project_id = NEW.project_id
            AND d2.repository_id = NEW.repository_id
            AND e2.project_id = NEW.project_id
            AND e2.repository_id = NEW.repository_id
            AND e2.kind = 'staging'
          ORDER BY d2.created_at DESC, d2.id DESC
          LIMIT 1
        )
    )
    INTO new_is_current;

    IF new_is_current THEN
      UPDATE approvals a
      SET stale = TRUE
      WHERE a.task_id = NEW.task_id
        AND a.stale = FALSE
        AND a.evidence->>'stagingDeploymentId' IS DISTINCT FROM NEW.id::text;
    END IF;
  END IF;

  RETURN NEW;
END;
$approval$ LANGUAGE plpgsql;

-- Serialize staging evidence mutations with Task status transitions.
-- The transition trigger locks the Task row; taking the same lock before
-- changing deployment evidence prevents snapshot races with approval checks.
CREATE OR REPLACE FUNCTION lock_task_for_staging_evidence_change()
RETURNS TRIGGER AS $lock_staging_task$
DECLARE
  affected_task_id UUID;
BEGIN
  FOR affected_task_id IN
    SELECT DISTINCT task_id
    FROM (
      SELECT CASE WHEN TG_OP <> 'INSERT' THEN OLD.task_id END AS task_id
      UNION ALL
      SELECT CASE WHEN TG_OP <> 'DELETE' THEN NEW.task_id END AS task_id
    ) affected
    WHERE task_id IS NOT NULL
    ORDER BY task_id
  LOOP
    PERFORM 1 FROM tasks WHERE id = affected_task_id FOR UPDATE;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$lock_staging_task$ LANGUAGE plpgsql;

CREATE TRIGGER trg_00_lock_task_for_staging_evidence_change
BEFORE INSERT OR DELETE OR UPDATE OF
  project_id, repository_id, environment_id, task_id, revision, url, status
ON deployments
FOR EACH ROW EXECUTE FUNCTION lock_task_for_staging_evidence_change();

CREATE TRIGGER trg_invalidate_task_approvals_on_staging_change
AFTER INSERT OR DELETE OR UPDATE OF
  project_id, repository_id, environment_id, task_id, revision, url, status
ON deployments
FOR EACH ROW EXECUTE FUNCTION invalidate_task_approvals_on_staging_change();

CREATE OR REPLACE FUNCTION record_order_state_history()
RETURNS TRIGGER AS $$
DECLARE
  transition_actor_type TEXT := COALESCE(
    NULLIF(current_setting('jev.transition_actor_type', true), ''),
    'SYSTEM'
  );
  transition_actor_id TEXT := NULLIF(
    current_setting('jev.transition_actor_id', true),
    ''
  );
  transition_cause TEXT := COALESCE(
    NULLIF(current_setting('jev.transition_cause', true), ''),
    'unspecified'
  );
  transition_evidence JSONB := COALESCE(
    NULLIF(current_setting('jev.transition_evidence', true), '')::jsonb,
    '{}'::jsonb
  );
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO order_state_history (
      order_id, from_status, to_status, actor_type, actor_id, cause, evidence
    ) VALUES (
      NEW.id, NULL, NEW.status, transition_actor_type, transition_actor_id,
      transition_cause, transition_evidence
    );
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO order_state_history (
      order_id, from_status, to_status, actor_type, actor_id, cause, evidence
    ) VALUES (
      NEW.id, OLD.status, NEW.status, transition_actor_type, transition_actor_id,
      transition_cause, transition_evidence
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION record_task_state_history()
RETURNS TRIGGER AS $$
DECLARE
  transition_actor_type TEXT := COALESCE(
    NULLIF(current_setting('jev.transition_actor_type', true), ''),
    'SYSTEM'
  );
  transition_actor_id TEXT := NULLIF(
    current_setting('jev.transition_actor_id', true),
    ''
  );
  transition_cause TEXT := COALESCE(
    NULLIF(current_setting('jev.transition_cause', true), ''),
    'unspecified'
  );
  transition_evidence JSONB := COALESCE(
    NULLIF(current_setting('jev.transition_evidence', true), '')::jsonb,
    '{}'::jsonb
  );
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO task_state_history (
      task_id, from_status, to_status, actor_type, actor_id, cause, evidence
    ) VALUES (
      NEW.id, NULL, NEW.status, transition_actor_type, transition_actor_id,
      transition_cause, transition_evidence
    );
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO task_state_history (
      task_id, from_status, to_status, actor_type, actor_id, cause, evidence
    ) VALUES (
      NEW.id, OLD.status, NEW.status, transition_actor_type, transition_actor_id,
      transition_cause, transition_evidence
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_record_task_state_history
AFTER INSERT OR UPDATE OF status ON tasks
FOR EACH ROW EXECUTE FUNCTION record_task_state_history();

-- Backfill the missing initial-state row for records that predate 0005.
-- If transitions already occurred after 0005, use the earliest transition's
-- from_status; otherwise use the entity's current status.
INSERT INTO order_state_history (
  order_id, from_status, to_status, actor_type, cause, evidence, created_at
)
SELECT
  o.id,
  NULL,
  COALESCE(
    (
      SELECT h.from_status
      FROM order_state_history h
      WHERE h.order_id = o.id AND h.from_status IS NOT NULL
      ORDER BY h.created_at, h.id
      LIMIT 1
    ),
    o.status
  ),
  'SYSTEM',
  'migration_backfill',
  jsonb_build_object('migration', '0006_work_order_task_review_remediation.sql'),
  o.created_at
FROM orders o
WHERE NOT EXISTS (
  SELECT 1
  FROM order_state_history h
  WHERE h.order_id = o.id AND h.from_status IS NULL
);

INSERT INTO task_state_history (
  task_id, from_status, to_status, actor_type, cause, evidence, created_at
)
SELECT
  t.id,
  NULL,
  COALESCE(
    (
      SELECT h.from_status
      FROM task_state_history h
      WHERE h.task_id = t.id AND h.from_status IS NOT NULL
      ORDER BY h.created_at, h.id
      LIMIT 1
    ),
    t.status
  ),
  'SYSTEM',
  'migration_backfill',
  jsonb_build_object('migration', '0006_work_order_task_review_remediation.sql'),
  t.created_at
FROM tasks t
WHERE NOT EXISTS (
  SELECT 1
  FROM task_state_history h
  WHERE h.task_id = t.id AND h.from_status IS NULL
);
