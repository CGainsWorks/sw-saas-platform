import type { CreateProjectInput, Project, UpdateProjectInput } from '@saas/shared-types';
import { withTenant, withTenantReadOnly, type TenantClient } from '../db/tenant-context.js';
import { getJson, invalidateTenant, setJson, tenantKey } from '../cache/redis.js';
import { conflict, notFound } from '../http/errors.js';
import { writeAudit } from './audit.js';

/**
 * Project service.
 *
 * Every function takes `tenantId` as its first argument and routes through `withTenant`.
 * That is not a convention for tidiness — it is the only way to obtain a connection, so
 * a query that is not tenant-scoped cannot be written by accident.
 *
 * The explicit `WHERE tenant_id = $1` clauses below are belt and braces on top of RLS.
 * They exist for the query planner (a leading equality on the composite indexes) rather
 * than for correctness; the isolation tests prove the system is safe without them.
 */

interface ProjectRow {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  description: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    key: r.key,
    name: r.name,
    description: r.description,
    archived: r.archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = `id, tenant_id, key, name, description, archived, created_at, updated_at`;

const PROJECTS_CACHE_TTL_SECONDS = 30;

/**
 * Project list, cached in Redis.
 *
 * A cache is the classic way to walk around row-level security: a cache hit skips the
 * database entirely, and with it every policy. Everything RLS guarantees is void if two
 * tenants can collide on a key.
 *
 * The key is therefore built by `tenantKey()`, which cannot be called without a tenant
 * id — the same "make the safe path the only path" tactic as `withTenant`. There is a
 * test that primes this cache as one tenant and reads it as another.
 */
export async function listProjects(
  tenantId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<Project[]> {
  const includeArchived = opts.includeArchived ?? false;
  const key = tenantKey(tenantId, 'projects', includeArchived ? 'all' : 'active');

  const cached = await getJson<Project[]>(key);
  if (cached) return cached;

  const projects = await withTenantReadOnly(tenantId, async (tx) => {
    const { rows } = await tx.query<ProjectRow>(
      `SELECT ${COLUMNS} FROM projects
        WHERE tenant_id = $1 AND ($2::boolean OR archived = false)
        ORDER BY created_at DESC`,
      [tenantId, includeArchived],
    );
    return rows.map(toProject);
  });

  await setJson(key, projects, PROJECTS_CACHE_TTL_SECONDS);
  return projects;
}

export async function getProject(tenantId: string, id: string): Promise<Project> {
  return withTenantReadOnly(tenantId, async (tx) => {
    const { rows } = await tx.query<ProjectRow>(
      `SELECT ${COLUMNS} FROM projects WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    // For a project belonging to another tenant, RLS filtered the row out before this
    // handler ran, so "not found" is the literal truth from inside this tenant's view.
    if (!rows[0]) throw notFound('project');
    return toProject(rows[0]);
  });
}

/** Same lookup, reusing a caller's transaction. Used by GraphQL resolvers and by tasks. */
export async function getProjectIn(tx: TenantClient, id: string): Promise<Project | null> {
  const { rows } = await tx.query<ProjectRow>(
    `SELECT ${COLUMNS} FROM projects WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, id],
  );
  return rows[0] ? toProject(rows[0]) : null;
}

export async function createProject(
  tenantId: string,
  actorId: string,
  input: CreateProjectInput,
): Promise<Project> {
  const created = await withTenant(tenantId, async (tx) => {
    let rows: ProjectRow[];
    try {
      ({ rows } = await tx.query<ProjectRow>(
        `INSERT INTO projects (tenant_id, key, name, description)
              VALUES ($1, $2, $3, $4)
           RETURNING ${COLUMNS}`,
        [tenantId, input.key, input.name, input.description ?? null],
      ));
    } catch (err) {
      // Project keys are unique per tenant, not globally — two customers may both want
      // "OPS". A collision here is therefore always within the caller's own tenant, so
      // reporting it leaks nothing.
      if ((err as { constraint?: string }).constraint === 'projects_key_unique') {
        throw conflict(`a project with key "${input.key}" already exists`);
      }
      throw err;
    }

    const project = toProject(rows[0]!);
    await writeAudit(tx, {
      actorId,
      action: 'project.created',
      entityType: 'project',
      entityId: project.id,
      metadata: { key: project.key },
    });
    return project;
  });

  // After the transaction commits, never before: invalidating first would leave a window
  // in which a concurrent read repopulates the cache from the pre-commit state.
  await invalidateTenant(tenantId);
  return created;
}

export async function updateProject(
  tenantId: string,
  actorId: string,
  id: string,
  input: UpdateProjectInput,
): Promise<Project> {
  const updated = await withTenant(tenantId, async (tx) => {
    // COALESCE against a typed NULL lets one statement handle any subset of fields
    // without building SQL by string concatenation.
    const { rows } = await tx.query<ProjectRow>(
      `UPDATE projects
          SET name        = COALESCE($3, name),
              description = CASE WHEN $4::boolean THEN $5 ELSE description END,
              archived    = COALESCE($6, archived)
        WHERE tenant_id = $1 AND id = $2
    RETURNING ${COLUMNS}`,
      [
        tenantId,
        id,
        input.name ?? null,
        input.description !== undefined,
        input.description ?? null,
        input.archived ?? null,
      ],
    );

    // Zero rows means either "no such project" or "belongs to another tenant". Both
    // present as 404 — deliberately indistinguishable.
    if (!rows[0]) throw notFound('project');

    const project = toProject(rows[0]);
    await writeAudit(tx, {
      actorId,
      action: 'project.updated',
      entityType: 'project',
      entityId: id,
      metadata: { fields: Object.keys(input) },
    });
    return project;
  });

  await invalidateTenant(tenantId);
  return updated;
}

export async function deleteProject(
  tenantId: string,
  actorId: string,
  id: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    // Tasks cascade via the composite FK, and their comments cascade in turn. Assignments
    // are cleared first because tasks_assignee_fk is ON DELETE NO ACTION.
    await tx.query(`UPDATE tasks SET assignee_id = NULL WHERE tenant_id = $1 AND project_id = $2`, [
      tenantId,
      id,
    ]);

    const { rowCount } = await tx.query(`DELETE FROM projects WHERE tenant_id = $1 AND id = $2`, [
      tenantId,
      id,
    ]);
    if (rowCount === 0) throw notFound('project');

    await writeAudit(tx, {
      actorId,
      action: 'project.deleted',
      entityType: 'project',
      entityId: id,
    });
  });

  await invalidateTenant(tenantId);
}
