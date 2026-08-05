-- Runs once, as superuser, on first initialisation of the Postgres container.
-- (The official image executes /docker-entrypoint-initdb.d/*.sql only when the data
-- directory is empty. `make reset` drops the volume to force a re-run.)
--
-- Creates the least-privilege role the application connects as. Everything else —
-- grants, RLS policies — lives in the migrations so that it is versioned and applies
-- to RDS too. The equivalent bootstrap for RDS is in docs/runbook.md; there the role is
-- created by the migration itself and the password set from Secrets Manager.
--
-- The password here is a development credential for a database bound to localhost. It is
-- not a secret, and it is not used anywhere else.

CREATE ROLE app_user
    LOGIN
    PASSWORD 'app_dev_password'
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOBYPASSRLS
    NOINHERIT;

COMMENT ON ROLE app_user IS
    'Application runtime role. NOBYPASSRLS is load-bearing: a role that can bypass '
    'row-level security would silently disable every tenant isolation policy.';
