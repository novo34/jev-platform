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

CREATE OR REPLACE FUNCTION validate_task_status_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'PLANNED' AND NEW.status IN ('READY', 'BLOCKED', 'REJECTED')) OR
    (OLD.status = 'READY' AND NEW.status IN ('RUNNING', 'BLOCKED', 'REJECTED')) OR
    (OLD.status = 'RUNNING' AND NEW.status IN ('VERIFYING', 'BLOCKED', 'FAILED')) OR
    (OLD.status = 'VERIFYING' AND NEW.status IN ('VERIFIED', 'RUNNING', 'BLOCKED', 'FAILED')) OR
    (OLD.status = 'VERIFIED' AND NEW.status IN ('STAGING', 'RUNNING', 'CHANGES_REQUESTED')) OR
    (OLD.status = 'STAGING' AND NEW.status IN ('AWAITING_HUMAN', 'BLOCKED', 'FAILED')) OR
    (OLD.status = 'AWAITING_HUMAN' AND NEW.status IN ('APPROVED', 'CHANGES_REQUESTED', 'REJECTED')) OR
    -- DONE remains a canonical state but cannot be entered until the Promotion
    -- engine can prove PROMOTED_TO_MAIN for this exact Task (REQ-TSK-009).
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
