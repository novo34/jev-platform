-- Forward-only (PLT-012): the ledger trigger also admits GITHUB_INTEGRATE_STAGING.
-- Only the action allowlist changes; no table, column, role or GRANT is introduced.
CREATE OR REPLACE FUNCTION jev_guard_github_operation()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $jev$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.result IS NOT NULL OR NEW.action NOT IN
      ('GITHUB_CREATE_BRANCH','GITHUB_WRITE_FILE','GITHUB_CREATE_PR','GITHUB_MERGE_PR','GITHUB_INTEGRATE_STAGING') THEN
      RAISE EXCEPTION 'operation must begin as pending' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.tasks t JOIN public.projects p ON p.id=t.project_id
      JOIN public.repositories r ON r.id=t.repository_id
      JOIN public.users u ON u.id=NEW.actor_id AND u.organization_id=p.organization_id
      WHERE t.id=NEW.task_id AND t.project_id=NEW.project_id AND t.repository_id=NEW.repository_id
        AND r.project_id=p.id AND p.organization_id=NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'operation outside canonical scope' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-'status'-'result') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'result') THEN
      RAISE EXCEPTION 'operation scope is immutable' USING ERRCODE='23514';
    END IF;
    IF NOT ((OLD.status='PENDING' AND NEW.status IN ('SUCCESS','FAILED','UNKNOWN'))
      OR (OLD.status='FAILED' AND NEW.status='PENDING')) THEN
      RAISE EXCEPTION 'invalid ledger transition or terminal result mutation' USING ERRCODE='23514';
    END IF;
  END IF;
  IF (NEW.status='SUCCESS' AND (NEW.result IS NULL OR jsonb_typeof(NEW.result)<>'object'))
    OR (NEW.status<>'SUCCESS' AND NEW.result IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid ledger result' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$jev$;
