-- PLT-008: defensive Environment guard (partial F-02 remediation).
-- This guard is deliberately conservative: adding a staging requirement to
-- an already approved scope must fail, rather than stale its approval.
-- A complete cross-transaction lock protocol remains a separate gate.
CREATE OR REPLACE FUNCTION reject_staging_requirement_for_approved_tasks()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $jev_env_approved$
BEGIN
  IF NEW.kind = 'staging' AND (
    TG_OP = 'INSERT'
    OR OLD.kind IS DISTINCT FROM NEW.kind
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.repository_id IS DISTINCT FROM NEW.repository_id
  ) THEN
    IF EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.project_id = NEW.project_id
        AND t.repository_id = NEW.repository_id
        AND t.status = 'APPROVED'
    ) THEN
      RAISE EXCEPTION
        'cannot introduce staging requirement for an approved task scope'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$jev_env_approved$;

CREATE TRIGGER trg_00_reject_staging_requirement_for_approved_tasks
BEFORE INSERT OR UPDATE OF project_id, repository_id, kind
ON environments
FOR EACH ROW
EXECUTE FUNCTION reject_staging_requirement_for_approved_tasks();
