-- PLT-008 R3: stable deployment insertion sequence / strict approval references.
-- NOW() records the transaction start, not insertion order; UUID sorting is random.
-- Runtime writer holds project scope BEFORE insertion/sequence assignment.
-- Existing rows preserve the prior created_at/id observable ordering.
CREATE SEQUENCE jev_deployment_insertion_seq AS bigint;
ALTER TABLE deployments ADD COLUMN insertion_seq bigint;
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS seq
  FROM deployments
)
UPDATE deployments d SET insertion_seq = ordered.seq
FROM ordered WHERE d.id = ordered.id;
SELECT pg_catalog.setval(
  'jev_deployment_insertion_seq'::regclass,
  GREATEST(COALESCE((SELECT MAX(insertion_seq) FROM deployments),0),1),
  EXISTS(SELECT 1 FROM deployments)
);
ALTER TABLE deployments ALTER COLUMN insertion_seq
  SET DEFAULT pg_catalog.nextval('jev_deployment_insertion_seq'::regclass);
ALTER TABLE deployments ALTER COLUMN insertion_seq SET NOT NULL;
ALTER SEQUENCE jev_deployment_insertion_seq OWNED BY deployments.insertion_seq;
CREATE UNIQUE INDEX idx_deployments_insertion_seq
  ON deployments(insertion_seq);
CREATE INDEX idx_deployments_task_insertion
  ON deployments(task_id, insertion_seq DESC) WHERE task_id IS NOT NULL;

-- Fail closed on a previously accepted blank approval for an APPROVED Task:
-- preserve historical records, never silently stale the only active decision.
DO $jev_bad_approvals$
BEGIN
  IF EXISTS (
    SELECT 1 FROM approvals a JOIN tasks t ON t.id=a.task_id
    WHERE a.decision='APPROVED' AND a.stale=FALSE
      AND t.status='APPROVED'
      AND (btrim(coalesce(a.revision,''))=''
        OR btrim(coalesce(a.commit_sha,''))=''
        OR btrim(coalesce(a.pull_request_url,''))='')
  ) THEN
    RAISE EXCEPTION
      'approved tasks with blank approval refs require human remediation before migration'
      USING ERRCODE='23514';
  END IF;
END;
$jev_bad_approvals$;
UPDATE approvals SET stale=TRUE
WHERE stale=FALSE AND decision='APPROVED'
  AND (btrim(coalesce(revision,''))=''
    OR btrim(coalesce(commit_sha,''))=''
    OR btrim(coalesce(pull_request_url,''))='');

ALTER TABLE approvals ADD CONSTRAINT approvals_approved_refs_nonblank CHECK (
  decision <> 'APPROVED' OR stale=TRUE OR (
    btrim(coalesce(revision,'')) <> ''
    AND btrim(coalesce(commit_sha,'')) <> ''
    AND btrim(coalesce(pull_request_url,'')) <> ''
  )
);

-- Recreate trigger functions forward-only; existing trigger names/bindings
-- are preserved. Always pick the greatest stable insertion sequence.
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
          ORDER BY d2.insertion_seq DESC
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
            ORDER BY d2.insertion_seq DESC
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
            ORDER BY d2.insertion_seq DESC
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
          ORDER BY d2.insertion_seq DESC
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

DO $jev_pin$
DECLARE s text:=current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.validate_task_status_transition() SET search_path = pg_catalog, %I, pg_temp',
    s,s
  );
  EXECUTE format(
    'ALTER FUNCTION %I.invalidate_task_approvals_on_staging_change() SET search_path = pg_catalog, %I, pg_temp',
    s,s
  );
END;
$jev_pin$;
