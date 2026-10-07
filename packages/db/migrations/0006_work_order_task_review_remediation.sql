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

ALTER TABLE tasks
  ADD CONSTRAINT tasks_project_repository_fk
  FOREIGN KEY (project_id, repository_id)
  REFERENCES repositories(project_id, id);

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

CREATE OR REPLACE FUNCTION validate_task_deployment_scope()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.task_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM tasks t
    JOIN environments e ON e.id = NEW.environment_id
    WHERE t.id = NEW.task_id
      AND t.project_id = NEW.project_id
      AND t.repository_id = NEW.repository_id
      AND e.project_id = NEW.project_id
      AND e.repository_id = NEW.repository_id
  ) THEN
    RAISE EXCEPTION
      'deployment project/repository/environment must match the task scope'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_task_deployment_scope
BEFORE INSERT OR UPDATE OF project_id, repository_id, environment_id, task_id
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
    (OLD.status = 'VERIFIED' AND NEW.status IN ('STAGING', 'RUNNING', 'CHANGES_REQUESTED')) OR
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
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT (
      kind = 'staging'
      AND project_id = NEW.project_id
      AND repository_id = NEW.repository_id
    )
    INTO new_is_staging
    FROM environments
    WHERE id = NEW.environment_id;

    IF new_is_staging AND NEW.task_id IS NOT NULL THEN
      UPDATE approvals a
      SET stale = TRUE
      WHERE a.task_id = NEW.task_id
        AND a.stale = FALSE
        AND a.evidence->>'stagingDeploymentId' IS DISTINCT FROM NEW.id::text;
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

  RETURN NEW;
END;
$approval$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invalidate_task_approvals_on_staging_change
AFTER INSERT OR UPDATE OF
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
