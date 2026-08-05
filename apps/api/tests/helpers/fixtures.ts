import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createAdminPool } from '../../src/db/pool.js';

/**
 * Fixture builder for isolation tests.
 *
 * Seeding runs on the ADMIN connection (superuser), which bypasses RLS. That is
 * deliberate and it is the only correct way to do it: the tests need two tenants
 * populated with data, and a tenant-scoped connection cannot — by construction — write
 * rows for two different tenants. The admin pool appears here and in migrations, never
 * in a request path.
 */

export interface SeededTenant {
  tenantId: string;
  slug: string;
  userId: string;
  userEmail: string;
  projectId: string;
  taskId: string;
  commentId: string;
}

export interface TwoTenants {
  a: SeededTenant;
  b: SeededTenant;
}

let adminPool: Pool | null = null;

export function admin(): Pool {
  adminPool ??= createAdminPool();
  return adminPool;
}

export async function closeAdmin(): Promise<void> {
  if (adminPool) {
    await adminPool.end();
    adminPool = null;
  }
}

/** Short unique suffix so parallel or repeated runs never collide on unique constraints. */
function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

async function seedTenant(label: string): Promise<SeededTenant> {
  const db = admin();
  const s = suffix();
  const slug = `${label}-${s}`;
  const email = `${label}-${s}@example.test`;

  const { rows: tenantRows } = await db.query<{ id: string }>(
    `INSERT INTO tenants (slug, name, plan) VALUES ($1, $2, 'pro') RETURNING id`,
    [slug, `Tenant ${label} ${s}`],
  );
  const tenantId = tenantRows[0]!.id;

  const { rows: userRows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
    [email, `User ${label}`],
  );
  const userId = userRows[0]!.id;

  await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [
    tenantId,
    userId,
  ]);

  const { rows: projectRows } = await db.query<{ id: string }>(
    `INSERT INTO projects (tenant_id, key, name, description)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, 'CORE', `${label} core project`, `Seeded for ${label}`],
  );
  const projectId = projectRows[0]!.id;

  const { rows: taskRows } = await db.query<{ id: string }>(
    `INSERT INTO tasks (tenant_id, project_id, title, status, priority, assignee_id)
     VALUES ($1, $2, $3, 'todo', 'high', $4) RETURNING id`,
    [tenantId, projectId, `${label} confidential task`, userId],
  );
  const taskId = taskRows[0]!.id;

  const { rows: commentRows } = await db.query<{ id: string }>(
    `INSERT INTO comments (tenant_id, task_id, author_id, body)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, taskId, userId, `${label} private comment — must never be visible elsewhere`],
  );

  await db.query(
    `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id)
     VALUES ($1, $2, 'task.created', 'task', $3)`,
    [tenantId, userId, taskId],
  );

  return {
    tenantId,
    slug,
    userId,
    userEmail: email,
    projectId,
    taskId,
    commentId: commentRows[0]!.id,
  };
}

/**
 * Two fully populated, unrelated tenants. Tenant A is "us"; tenant B is the customer
 * whose data must never be reachable.
 */
export async function seedTwoTenants(): Promise<TwoTenants> {
  const [a, b] = await Promise.all([seedTenant('alpha'), seedTenant('beta')]);
  return { a, b };
}

/** Removes seeded tenants. Cascades handle projects, tasks, comments and audit rows. */
export async function dropTenants(...tenantIds: string[]): Promise<void> {
  const db = admin();
  // Tasks reference memberships via a composite FK with ON DELETE NO ACTION, so the
  // assignment has to be cleared before the membership rows cascade away.
  await db.query(`UPDATE tasks SET assignee_id = NULL WHERE tenant_id = ANY($1::uuid[])`, [
    tenantIds,
  ]);
  await db.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenantIds]);
  await db.query(
    `DELETE FROM users WHERE id NOT IN (SELECT user_id FROM memberships)
       AND email LIKE '%@example.test'`,
  );
}

/** A UUID that is syntactically valid and belongs to nobody. */
export function orphanUuid(): string {
  return randomUUID();
}
