-- PLT-008 R3: strengthen approval references and staging deployment URL checks.
-- Forward-only migration; 0016 remains immutable for already-migrated servers.
-- POSIX whitespace includes tabs/newlines, unlike the default one-arg btrim.

DO $jev_ref_integrity$
BEGIN
  IF EXISTS (
    SELECT 1 FROM approvals a
    JOIN tasks t ON t.id = a.task_id
    WHERE a.decision = 'APPROVED' AND a.stale = FALSE
      AND t.status = 'APPROVED'
      AND (
        NOT (coalesce(a.revision, '') ~ '[^[:space:]]')
        OR NOT (coalesce(a.commit_sha, '') ~ '[^[:space:]]')
        OR NOT (coalesce(a.pull_request_url, '') ~ '[^[:space:]]')
      )
  ) THEN
    RAISE EXCEPTION
      'approved task has whitespace-only approval references; human remediation is required'
      USING ERRCODE = '23514';
  END IF;
END;
$jev_ref_integrity$;

UPDATE approvals SET stale = TRUE
WHERE stale = FALSE AND decision = 'APPROVED'
  AND (
    NOT (coalesce(revision, '') ~ '[^[:space:]]')
    OR NOT (coalesce(commit_sha, '') ~ '[^[:space:]]')
    OR NOT (coalesce(pull_request_url, '') ~ '[^[:space:]]')
  );

ALTER TABLE approvals DROP CONSTRAINT approvals_approved_refs_nonblank;
ALTER TABLE approvals ADD CONSTRAINT approvals_approved_refs_nonblank CHECK (
  decision <> 'APPROVED' OR stale = TRUE OR (
    coalesce(revision, '') ~ '[^[:space:]]'
    AND coalesce(commit_sha, '') ~ '[^[:space:]]'
    AND coalesce(pull_request_url, '') ~ '[^[:space:]]'
  )
);

-- A null URL is already rejected by the staging transition checks. An
-- empty or whitespace-only non-null READY URL must never become evidence.
ALTER TABLE deployments ADD CONSTRAINT deployments_ready_url_nonblank CHECK (
  status <> 'READY' OR url IS NULL OR url ~ '[^[:space:]]'
);
