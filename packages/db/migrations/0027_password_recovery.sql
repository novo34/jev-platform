CREATE TABLE password_reset_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX password_reset_tokens_expiry ON password_reset_tokens(expires_at);

CREATE FUNCTION jev_issue_password_reset(p_organization uuid, p_email text, p_token_hash text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $jev$
DECLARE
  account_id uuid;
  recipient text;
BEGIN
  SELECT id INTO account_id FROM users
  WHERE organization_id = p_organization AND lower(email) = lower(p_email)
    AND status = 'ACTIVE' AND password_hash IS NOT NULL;
  IF account_id IS NULL THEN RETURN NULL; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(account_id::text, 51));
  SELECT email INTO recipient FROM users
  WHERE id = account_id AND organization_id = p_organization
    AND lower(email) = lower(p_email) AND status = 'ACTIVE' AND password_hash IS NOT NULL
  FOR UPDATE;
  IF recipient IS NULL OR EXISTS (
    SELECT 1 FROM password_reset_tokens
    WHERE user_id = account_id AND created_at > clock_timestamp() - interval '1 minute'
  ) THEN RETURN NULL; END IF;

  DELETE FROM password_reset_tokens WHERE expires_at <= clock_timestamp();
  INSERT INTO password_reset_tokens (token_hash, user_id, email, expires_at)
  VALUES (p_token_hash, account_id, recipient, clock_timestamp() + interval '20 minutes');
  RETURN recipient;
END;
$jev$;

CREATE FUNCTION jev_consume_password_reset(p_token_hash text, p_password_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $jev$
DECLARE
  account_id uuid;
BEGIN
  IF p_password_hash IS NULL OR p_password_hash !~ '^scrypt[$][a-f0-9]{32}[$][a-f0-9]{128}$' THEN
    RAISE EXCEPTION 'invalid password hash';
  END IF;

  SELECT user_id INTO account_id FROM password_reset_tokens WHERE token_hash = p_token_hash;
  IF account_id IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(account_id::text, 51));

  UPDATE users u SET password_hash = p_password_hash
  FROM password_reset_tokens t
  WHERE t.token_hash = p_token_hash AND t.user_id = account_id AND u.id = account_id
    AND t.expires_at > clock_timestamp() AND t.email = u.email AND u.status = 'ACTIVE';
  IF NOT FOUND THEN RETURN false; END IF;

  DELETE FROM password_reset_tokens WHERE user_id = account_id;
  DELETE FROM auth_sessions WHERE user_id = account_id;
  RETURN true;
END;
$jev$;

DO $jev_acl$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.jev_issue_password_reset(uuid,text,text) SET search_path = pg_catalog, %I, pg_temp', current_schema(), current_schema());
  EXECUTE format('ALTER FUNCTION %I.jev_consume_password_reset(text,text) SET search_path = pg_catalog, %I, pg_temp', current_schema(), current_schema());
END;
$jev_acl$;

REVOKE ALL ON FUNCTION jev_issue_password_reset(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION jev_consume_password_reset(text,text) FROM PUBLIC;
