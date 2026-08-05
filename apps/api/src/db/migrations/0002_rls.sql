-- 0002_rls: row-level security policies and the least-privilege application role.
--
-- This migration is the enforcement boundary described in docs/multi_tenancy.md §2.
-- If it is reverted, the application still *appears* to work — every query in the
-- service layer carries its own `WHERE tenant_id = $1` — but the backstop is gone.
-- The isolation test suite exists to make that failure loud instead of silent.
--
-- Three things must hold together. Each is asserted by a test in
-- apps/api/tests/isolation/rls-invariants.test.ts:
--
--   (a) ENABLE + FORCE row level security on every tenant-owned table.
--       ENABLE alone exempts the table OWNER, and it is easy to accidentally run the
--       application as the owner. FORCE closes that.
--
--   (b) The application connects as `app_user`: NOSUPERUSER, NOBYPASSRLS, owner of
--       nothing. Superusers and table owners silently ignore policies, which would
--       make everything below decorative.
--
--   (c) Tenant identity arrives per-transaction via SET LOCAL app.current_tenant.
--       Unset => app_current_tenant() is NULL => `tenant_id = NULL` is NULL, not TRUE
--       => zero rows. Fail closed.
--
-- No BEGIN/COMMIT: the runner wraps each migration in a transaction. See 0001_init.sql.

/* ------------------------------------------------ tenant context accessor */

-- Reads the per-transaction tenant id. The `true` argument to current_setting makes an
-- unset variable return NULL instead of raising, which is what makes an unscoped
-- connection see nothing rather than error in some places and leak in others.
--
-- SECURITY INVOKER (the default) is deliberate: a SECURITY DEFINER function here would
-- run as the owner and could be used to escalate.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    SELECT nullif(current_setting('app.current_tenant', true), '')::uuid;
$$;

COMMENT ON FUNCTION app_current_tenant() IS
    'Per-transaction tenant id set by withTenant(). NULL when unset, which denies all rows.';

/* -------------------------------------------------- least-privilege role */

-- Normally created by the Postgres container init script (infra/postgres/init/) or, on
-- RDS, by the bootstrap step in docs/runbook.md. Created here without a password if it
-- is missing, so that migrations are runnable against a bare database.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user LOGIN;
        RAISE NOTICE 'created role app_user with no password; set one before use';
    END IF;
END
$$;

-- Idempotent and explicit. NOBYPASSRLS is the default for a fresh role, but this
-- migration is the place where that guarantee is stated rather than assumed.
ALTER ROLE app_user NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

/* ----------------------------------------------------- enable + force RLS */

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE  ROW LEVEL SECURITY;

ALTER TABLE projects    ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects    FORCE  ROW LEVEL SECURITY;

ALTER TABLE tasks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks       FORCE  ROW LEVEL SECURITY;

ALTER TABLE comments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments    FORCE  ROW LEVEL SECURITY;

ALTER TABLE audit_log   ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log   FORCE  ROW LEVEL SECURITY;

/* ---------------------------------------------------------------- policies */

-- One policy shape, applied uniformly. Both clauses are required:
--
--   USING      -> which rows are VISIBLE to SELECT / UPDATE / DELETE.
--   WITH CHECK -> which rows may be WRITTEN by INSERT / UPDATE.
--
-- A USING-only policy is the classic mistake: it correctly hides other tenants' rows on
-- read, while still allowing an INSERT that stamps a foreign tenant_id, and allowing an
-- UPDATE that moves one of your own rows *into* another tenant. Both of those have
-- dedicated tests.

CREATE POLICY tenant_isolation ON memberships
    FOR ALL
    USING      (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

CREATE POLICY tenant_isolation ON projects
    FOR ALL
    USING      (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

CREATE POLICY tenant_isolation ON tasks
    FOR ALL
    USING      (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

CREATE POLICY tenant_isolation ON comments
    FOR ALL
    USING      (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

-- audit_log is append-only for the application (no UPDATE/DELETE grant below), so the
-- policy only has to cover reads and inserts.
CREATE POLICY tenant_isolation ON audit_log
    FOR ALL
    USING      (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

/* ----------------------------------------------------------------- grants */

GRANT USAGE ON SCHEMA public TO app_user;

-- Nobody should be creating objects at runtime. (Postgres 15+ already revokes this from
-- PUBLIC by default; stated explicitly so the guarantee does not depend on the version.)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM app_user;

-- Not row-level-secured (see multi_tenancy.md §4). No DELETE: removing a tenant or a
-- user is an operator action, run with different credentials, not something a request
-- handler can do.
GRANT SELECT, INSERT, UPDATE ON tenants TO app_user;
GRANT SELECT, INSERT, UPDATE ON users   TO app_user;

-- Row-level-secured. Full DML, constrained by the policies above.
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects    TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON tasks       TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON comments    TO app_user;

-- Append-only: an application that can rewrite its own audit trail does not have one.
GRANT SELECT, INSERT ON audit_log TO app_user;

-- schema_migrations is intentionally omitted: app_user gets no access to migration
-- bookkeeping at all. Tables grant nothing to PUBLIC by default, so this is the
-- absence of a GRANT rather than a REVOKE.
