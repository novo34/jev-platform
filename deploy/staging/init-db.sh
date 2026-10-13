#!/bin/sh
set -eu
# Runs once for a brand-new PostgreSQL data directory under bootstrap superuser.
# Give migrations schema ownership, but no cluster superuser powers.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v owner_password="$JEV_STAGING_DB_OWNER_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE jev_owner LOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', :'owner_password') \gexec
ALTER DATABASE jev_staging OWNER TO jev_owner;
ALTER SCHEMA public OWNER TO jev_owner;
SQL
