-- Technical reports use existing canonical Task evidence; no parallel engine.
-- Historic rows remain readable. New merges require a valid signed report.
CREATE FUNCTION jev_immutable_task_history()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $jev$
BEGIN
  RAISE EXCEPTION 'task transition history is append-only' USING ERRCODE='23514';
END;
$jev$;
CREATE TRIGGER trg_immutable_task_history
BEFORE UPDATE OR DELETE ON task_state_history
FOR EACH ROW EXECUTE FUNCTION jev_immutable_task_history();
