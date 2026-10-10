-- PLT-008 F-02: serialize staging requirement introduction with Task status
-- changes. Keep 0007 immutable for checksum-based migration upgrades.
-- Scope locking is per project/repository, never global.
CREATE OR REPLACE FUNCTION reject_staging_requirement_for_approved_tasks()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $jev_env_approved$
DECLARE
  affected_task UUID;
BEGIN
  IF NEW.kind = 'staging' AND (
    TG_OP = 'INSERT'
    OR OLD.kind IS DISTINCT FROM NEW.kind
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.repository_id IS DISTINCT FROM NEW.repository_id
  ) THEN
    -- Lock Task rows before reading their status, in a deterministic order.
    -- Under READ COMMITTED, each subsequent status check sees the committed
    -- state of a Task whose concurrent transition just released its lock.
    FOR affected_task IN
      SELECT id FROM tasks
      WHERE project_id = NEW.project_id
        AND repository_id = NEW.repository_id
      ORDER BY id
    LOOP
      PERFORM 1 FROM tasks WHERE id = affected_task FOR UPDATE;
      IF EXISTS (
        SELECT 1 FROM tasks
        WHERE id = affected_task AND status = 'APPROVED'
      ) THEN
        RAISE EXCEPTION
          'cannot introduce staging requirement for an approved task scope'
          USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$jev_env_approved$;
