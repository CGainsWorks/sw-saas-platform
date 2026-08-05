import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { withTenant } from '../../src/db/tenant-context.js';
import {
  admin,
  closeAdmin,
  dropTenants,
  seedTwoTenants,
  type TwoTenants,
} from '../helpers/fixtures.js';

/**
 * Cross-tenant READ attacks.
 *
 * Every test here plays the same role: an authenticated, legitimate user of tenant A who
 * has somehow learned the primary keys of tenant B's rows — from a leaked log, a shared
 * screenshot, an enumeration bug elsewhere, or simply by being a former employee. Knowing
 * the id must not be enough.
 *
 * These run as `app_user` through withTenant(), which is exactly how request handlers
 * reach the database. Nothing is mocked.
 */
describe('tenant isolation — reads', () => {
  let t: TwoTenants;

  beforeAll(async () => {
    t = await seedTwoTenants();
  });

  afterAll(async () => {
    await dropTenants(t.a.tenantId, t.b.tenantId);
    await closeAdmin();
    await pool.end();
  });

  it('sees its own project and only its own', async () => {
    const rows = await withTenant(t.a.tenantId, async (tx) => {
      const r = await tx.query<{ id: string }>('SELECT id FROM projects');
      return r.rows;
    });

    expect(rows.map((r) => r.id)).toContain(t.a.projectId);
    expect(rows.map((r) => r.id)).not.toContain(t.b.projectId);
  });

  it('cannot read another tenant\'s task by its known primary key', async () => {
    const rows = await withTenant(t.a.tenantId, async (tx) => {
      const r = await tx.query('SELECT id, title FROM tasks WHERE id = $1', [t.b.taskId]);
      return r.rows;
    });

    expect(rows).toHaveLength(0);
  });

  it('cannot read another tenant\'s comment by its known primary key', async () => {
    const rows = await withTenant(t.a.tenantId, async (tx) => {
      const r = await tx.query('SELECT body FROM comments WHERE id = $1', [t.b.commentId]);
      return r.rows;
    });

    expect(rows).toHaveLength(0);
  });

  /**
   * The single most valuable test in this file.
   *
   * The service layer writes `WHERE tenant_id = $1` on every query. This test asserts the
   * system is still safe when a developer forgets it — which is the failure the pool
   * tenancy model is otherwise wide open to, and the entire justification for pushing
   * enforcement into the database (docs/multi_tenancy.md §2).
   */
  it('is safe even when the query forgets its WHERE tenant_id clause', async () => {
    const { tasks, comments, projects } = await withTenant(t.a.tenantId, async (tx) => {
      // Deliberately unscoped SQL. In an application-enforced design this returns every
      // customer's rows.
      const tasksR = await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM tasks');
      const commentsR = await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM comments');
      const projectsR = await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM projects');
      return { tasks: tasksR.rows, comments: commentsR.rows, projects: projectsR.rows };
    });

    for (const row of [...tasks, ...comments, ...projects]) {
      expect(row.tenant_id).toBe(t.a.tenantId);
    }
    expect(tasks.length).toBeGreaterThan(0); // guard: an empty result would pass vacuously
  });

  it('cannot reach a foreign row by pivoting through a join', async () => {
    const rows = await withTenant(t.a.tenantId, async (tx) => {
      const r = await tx.query(
        `SELECT c.id, c.body
           FROM comments c
           JOIN tasks t     ON t.id = c.task_id
           JOIN projects p  ON p.id = t.project_id
          WHERE t.id = $1`,
        [t.b.taskId],
      );
      return r.rows;
    });

    expect(rows).toHaveLength(0);
  });

  it('does not leak the existence of foreign rows through aggregates', async () => {
    // Ground truth from the admin connection, which bypasses RLS: rows for both tenants
    // genuinely exist in the table.
    const { rows: truth } = await admin().query<{ count: number }>(
      'SELECT count(*)::int8 AS count FROM tasks',
    );
    const actualTotal = truth[0]!.count;

    const { unscoped, own } = await withTenant(t.a.tenantId, async (tx) => {
      const a = await tx.query<{ count: number }>('SELECT count(*)::int8 AS count FROM tasks');
      const b = await tx.query<{ count: number }>(
        'SELECT count(*)::int8 AS count FROM tasks WHERE tenant_id = $1',
        [t.a.tenantId],
      );
      return { unscoped: a.rows[0]!.count, own: b.rows[0]!.count };
    });

    // COUNT(*) is evaluated over the policy-filtered relation, so tenant B's rows are not
    // merely omitted from a result set — they are not counted. An aggregate is a classic
    // way to confirm a record exists without being able to read it; this closes it.
    expect(unscoped).toBe(own);
    expect(actualTotal).toBeGreaterThan(unscoped);
  });

  it('cannot enumerate another tenant\'s membership (no cross-customer user oracle)', async () => {
    const rows = await withTenant(t.a.tenantId, async (tx) => {
      const r = await tx.query('SELECT user_id, role FROM memberships WHERE user_id = $1', [
        t.b.userId,
      ]);
      return r.rows;
    });

    expect(rows).toHaveLength(0);
  });

  it('cannot read another tenant\'s audit trail', async () => {
    const rows = await withTenant(t.a.tenantId, async (tx) => {
      const r = await tx.query('SELECT action FROM audit_log WHERE tenant_id = $1', [
        t.b.tenantId,
      ]);
      return r.rows;
    });

    expect(rows).toHaveLength(0);
  });

  /**
   * Fail-closed check. If `app.current_tenant` is unset, `app_current_tenant()` is NULL,
   * `tenant_id = NULL` evaluates to NULL rather than TRUE, and no row qualifies.
   *
   * The alternative — a policy that defaults to permitting when unset — would mean any
   * code path that skipped withTenant() silently saw everything.
   */
  it('returns zero rows on a connection with no tenant context at all', async () => {
    const projects = await pool.query('SELECT id FROM projects');
    const tasks = await pool.query('SELECT id FROM tasks');
    const comments = await pool.query('SELECT id FROM comments');

    expect(projects.rowCount).toBe(0);
    expect(tasks.rowCount).toBe(0);
    expect(comments.rowCount).toBe(0);
  });

  /**
   * Regression test for the failure mode that made `SET LOCAL` mandatory.
   *
   * With plain `SET`, the tenant setting persists on the pooled connection and is
   * inherited by whichever request picks that connection up next — a cross-tenant leak
   * that only appears under concurrency and passes every serial test. Here the same
   * connection is deliberately reused immediately after a scoped transaction.
   */
  it('does not let tenant context survive the transaction that set it', async () => {
    await withTenant(t.a.tenantId, async (tx) => {
      const r = await tx.query('SELECT id FROM projects');
      expect(r.rowCount).toBeGreaterThan(0); // context was genuinely in effect
    });

    // Same pool, very likely the same physical connection, no context this time.
    const after = await pool.query('SELECT id FROM projects');
    expect(after.rowCount).toBe(0);

    const setting = await pool.query<{ v: string | null }>(
      "SELECT current_setting('app.current_tenant', true) AS v",
    );
    expect(setting.rows[0]!.v ?? '').toBe('');
  });

  it('scopes to B when asked for B, proving the fixture is not simply empty', async () => {
    const rows = await withTenant(t.b.tenantId, async (tx) => {
      const r = await tx.query<{ id: string }>('SELECT id FROM tasks');
      return r.rows;
    });

    expect(rows.map((r) => r.id)).toContain(t.b.taskId);
    expect(rows.map((r) => r.id)).not.toContain(t.a.taskId);
  });
});
