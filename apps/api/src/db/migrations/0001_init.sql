-- 0001_init: core schema.
--
-- Tenancy model: pool (shared schema, tenant_id on every tenant-owned row).
-- See docs/multi_tenancy.md. Row-level security is applied separately in 0002_rls.sql
-- so that the policy layer is reviewable on its own.
--
-- Two conventions carry most of the weight here:
--
--   1. Every tenant-owned table has a NOT NULL `tenant_id`, and a UNIQUE (tenant_id, id)
--      alongside the primary key. That unique constraint exists purely so that child
--      tables can declare a *composite* foreign key including tenant_id.
--
--   2. Child rows reference their parent as (tenant_id, parent_id), not just parent_id.
--      This makes "a task in tenant A pointing at a project in tenant B" unrepresentable
--      at the storage layer, independent of RLS and independent of application code.
--      Referential integrity does isolation work here, not just consistency work.
--
-- No BEGIN/COMMIT in this file: the runner (migrate.ts) wraps each migration and its
-- schema_migrations bookkeeping row in a single transaction, so a half-applied migration
-- cannot be recorded as complete.

/* ---------------------------------------------------------------- tenants */

CREATE TABLE tenants (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            text        NOT NULL UNIQUE,
    name            text        NOT NULL,
    plan            text        NOT NULL DEFAULT 'free',
    isolation_model text        NOT NULL DEFAULT 'pool',
    -- Non-null only for tenants promoted to a dedicated database. See multi_tenancy.md §7.
    -- Null for every tenant in this demo; the silo path is schema-supported, not exercised.
    shard_dsn       text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tenants_slug_format   CHECK (slug ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$'),
    CONSTRAINT tenants_plan_valid    CHECK (plan IN ('free', 'pro', 'enterprise')),
    CONSTRAINT tenants_model_valid   CHECK (isolation_model IN ('pool', 'silo')),
    -- A silo tenant without a DSN would silently fall back to the shared pool.
    CONSTRAINT tenants_silo_has_dsn  CHECK (isolation_model <> 'silo' OR shard_dsn IS NOT NULL)
);

COMMENT ON TABLE tenants IS
    'Tenant registry. Deliberately NOT row-level-secured: it is the table that defines '
    'the boundary. Read by primary key using an id taken from a verified token claim.';

/* ------------------------------------------------------------------ users */

-- A user is a GLOBAL identity: one email, one row, regardless of how many tenants
-- they belong to. Tenant scoping lives on `memberships`, not here.
CREATE TABLE users (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email      text        NOT NULL,
    name       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_email_shape CHECK (position('@' IN email) > 1)
);

-- Case-insensitive uniqueness without depending on the citext extension.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

COMMENT ON TABLE users IS
    'Global user identities. Not tenant-scoped by design; see memberships.';

/* ------------------------------------------------------------ memberships */

-- The join table, and the security-critical one: it answers "may this identity act
-- inside this tenant, and as what". RLS-protected so tenant A cannot enumerate the
-- membership of tenant B (which would be a cross-customer user-enumeration oracle).
CREATE TABLE memberships (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users (id)   ON DELETE CASCADE,
    role       text        NOT NULL DEFAULT 'member',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT memberships_role_valid CHECK (role IN ('owner', 'admin', 'member')),
    CONSTRAINT memberships_unique     UNIQUE (tenant_id, user_id)
);

CREATE INDEX memberships_user_idx ON memberships (user_id);

/* --------------------------------------------------------------- projects */

CREATE TABLE projects (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    key         text        NOT NULL,
    name        text        NOT NULL,
    description text,
    archived    boolean     NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT projects_key_format CHECK (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
    -- Project keys are unique per tenant, not globally: two customers may both want "OPS".
    CONSTRAINT projects_key_unique UNIQUE (tenant_id, key),
    -- Referenced by tasks' composite FK. See the header comment.
    CONSTRAINT projects_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX projects_tenant_idx ON projects (tenant_id, archived, created_at DESC);

/* ------------------------------------------------------------------ tasks */

CREATE TABLE tasks (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id  uuid        NOT NULL,
    title       text        NOT NULL,
    description text,
    status      text        NOT NULL DEFAULT 'todo',
    priority    text        NOT NULL DEFAULT 'medium',
    assignee_id uuid,
    due_at      timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tasks_status_valid   CHECK (status   IN ('todo', 'in_progress', 'blocked', 'done')),
    CONSTRAINT tasks_priority_valid CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    CONSTRAINT tasks_title_len      CHECK (char_length(title) BETWEEN 1 AND 300),

    -- Composite FK: the project must exist AND belong to the same tenant.
    CONSTRAINT tasks_project_fk FOREIGN KEY (tenant_id, project_id)
        REFERENCES projects (tenant_id, id) ON DELETE CASCADE,

    -- Composite FK: an assignee must hold membership IN THIS TENANT. Because assignee_id
    -- is nullable and the default MATCH SIMPLE semantics skip the check when any column
    -- is NULL, unassigned tasks are unaffected. Removing a membership therefore requires
    -- unassigning their tasks first, which the membership service does explicitly.
    CONSTRAINT tasks_assignee_fk FOREIGN KEY (tenant_id, assignee_id)
        REFERENCES memberships (tenant_id, user_id) ON DELETE NO ACTION,

    CONSTRAINT tasks_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX tasks_tenant_project_idx  ON tasks (tenant_id, project_id, created_at DESC);
CREATE INDEX tasks_tenant_status_idx   ON tasks (tenant_id, status);
CREATE INDEX tasks_tenant_assignee_idx ON tasks (tenant_id, assignee_id) WHERE assignee_id IS NOT NULL;

/* --------------------------------------------------------------- comments */

CREATE TABLE comments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    task_id    uuid        NOT NULL,
    author_id  uuid        REFERENCES users (id) ON DELETE SET NULL,
    body       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT comments_body_len CHECK (char_length(body) BETWEEN 1 AND 10000),

    CONSTRAINT comments_task_fk FOREIGN KEY (tenant_id, task_id)
        REFERENCES tasks (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX comments_tenant_task_idx ON comments (tenant_id, task_id, created_at);

/* -------------------------------------------------------------- audit_log */

CREATE TABLE audit_log (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    actor_id    uuid        REFERENCES users (id) ON DELETE SET NULL,
    action      text        NOT NULL,
    entity_type text        NOT NULL,
    entity_id   uuid,
    metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, created_at DESC);

/* ------------------------------------------------- updated_at maintenance */

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_updated_at     BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at       BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER memberships_updated_at BEFORE UPDATE ON memberships
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER projects_updated_at    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tasks_updated_at       BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
