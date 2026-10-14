#!/bin/sh
set -eu
# Fresh PostgreSQL volume only. Bootstrap privileged roles once, then
# expose only non-superuser jev_owner to the regular migration job.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v owner_password="$JEV_STAGING_DB_OWNER_PASSWORD" -v runtime_password="$JEV_STAGING_RUNTIME_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE jev_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', :'owner_password') \gexec
SELECT format('CREATE ROLE jev_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', :'runtime_password') \gexec
ALTER DATABASE jev_staging OWNER TO jev_owner;
ALTER SCHEMA public OWNER TO jev_owner;
SQL
