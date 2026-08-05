import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { InvalidTenantIdError, withTenant } from '../../src/db/tenant-context.js';
import {
  admin,
  closeAdmin,
  dropTenants,
  orphanUuid,
  seedTwoTenants,
  type TwoTenants,
} from '../helpers/fixtures.js';

/**
 * Cross-tenant WRITE attacks.
 *
 * Reads are the obvious risk and the one everybody tests. Writes are where the subtle
 * bugs live, and they are strictly worse: a read leak exposes data, a write leak
 * *corrupts another customer's data*, which is not recoverable by revoking a token.
 *
 * The specific mistake these exist to catch is a policy declared with `USING` but no
 * `WITH CHECK`. Such a policy hides foreign rows on read — so every read test above
 * still passes — while permitting an INSERT that stamps a foreign tenant_id, and an
 * UPDATE that moves one of your own rows into someone else's tenant.
 */
describe('tenant isolation — writes', () => {
  let t: TwoTenants;

  beforeAll(async () => {
    t = await seedTwoTenants();
  });

  afterAll(async () => {
    await dropTenants(t.a.tenantId, t.b.tenantId);
    await closeAdmin();
    await pool.end();
  });

  it('rejects an INSERT that forges another tenant\'s id (WITH CHECK)', async () => {
    await expect(
      withTenant(t.a.tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO projects (tenant_id, key, name) VALUES ($1, 'EVIL', 'planted')`,
          [t.b.tenantId],
        );
      }),
    ).rejects.toThrow(/row-level security/i);

    // And nothing was written.
    const { rows } = await admin().query('SELECT id FROM projects WHERE key = $1', ['EVIL']);
    expect(rows).toHaveLength(0);
  });

  it('rejects an UPDATE that moves one of its own rows into another tenant', async () => {
    await expect(
      withTenant(t.a.tenantId, async (tx) => {
        await tx.query('UPDATE projects SET tenant_id = $1 WHERE id = $2', [
          t.b.tenantId,
          t.a.projectId,
        ]);
      }),
    ).rejects.toThrow(/row-level security/i);

    const { rows } = await admin().query<{ tenant_id: string }>(
      'SELECT tenant_id FROM projects WHERE id = $1',
      [t.a.projectId],
    );
    expect(rows[0]!.tenant_id).toBe(t.a.tenantId);
  });

  /**
   * Note the shape of this failure: not an error, but zero rows affected. The foreign row
   * is invisible to the UPDATE's row scan, so there is nothing to update. Handlers must
   * therefore treat `rowCount === 0` as "not found", which is what the service layer does.
   */
  it('affects zero rows when UPDATEing a foreign row by known id', async () => {
    const rowCount = await withTenant(t.a.tenantId, async (tx) => {
      const r = await tx.query('UPDATE tasks SET title = $1 WHERE id = $2', [
        'pwned',
        t.b.taskId,
      ]);
      return r.rowCount;
    });

    expect(rowCount).toBe(0);

    const { rows } = await admin().query<{ title: string }>(
      'SELECT title FROM tasks WHERE id = $1',
      [t.b.taskId],
    );
    expect(rows[0]!.title).not.toBe('pwned');
  });

  it('affects zero rows when DELETEing a foreign row by known id', async () => {
    const rowCount = await withTenant(t.a.tenantId, async (tx) => {
      const r = await tx.query('DELETE FROM tasks WHERE id = $1', [t.b.taskId]);
      return r.rowCount;
    });

    expect(rowCount).toBe(0);

    const { rows } = await admin().query('SELECT id FROM tasks WHERE id = $1', [t.b.taskId]);
    expect(rows).toHaveLength(1); // still there
  });

  it('affects zero rows on an unscoped mass DELETE', async () => {
    const rowCount = await withTenant(t.b.tenantId, async (tx) => {
      // No WHERE clause at all — the nightmare query. It can only reach tenant B's rows.
      const r = await tx.query('DELETE FROM comments');
      return r.rowCount;
    });

    // It deleted B's own comment (that is legitimate — B owns it) and nothing of A's.
    expect(rowCount).toBe(1);
    const { rows } = await admin().query('SELECT id FROM comments WHERE id = $1', [t.a.commentId]);
    expect(rows).toHaveLength(1);
  });

  /**
   * Referential integrity doing isolation work. `tasks` references its project as
   * (tenant_id, project_id) against `projects (tenant_id, id)`, so a task in tenant A
   * pointing at a project in tenant B is not merely denied — it is unrepresentable.
   *
   * This holds independently of RLS. FK checks run with the table owner's privileges and
   * deliberately bypass row security, so this is a genuinely separate layer rather than
   * the same check counted twice.
   */
  it('cannot create a task pointing at another tenant\'s project (composite FK)', async () => {
    await expect(
      withTenant(t.a.tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO tasks (tenant_id, project_id, title) VALUES ($1, $2, 'cross-tenant task')`,
          [t.a.tenantId, t.b.projectId],
        );
      }),
    ).rejects.toThrow(/violates foreign key constraint "tasks_project_fk"/i);
  });

  it('cannot assign a task to a user who is not a member of this tenant (composite FK)', async () => {
    await expect(
      withTenant(t.a.tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO tasks (tenant_id, project_id, title, assignee_id)
           VALUES ($1, $2, 'assigned to an outsider', $3)`,
          [t.a.tenantId, t.a.projectId, t.b.userId],
        );
      }),
    ).rejects.toThrow(/violates foreign key constraint "tasks_assignee_fk"/i);
  });

  it('cannot comment on another tenant\'s task', async () => {
    await expect(
      withTenant(t.a.tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO comments (tenant_id, task_id, author_id, body)
           VALUES ($1, $2, $3, 'injected')`,
          [t.a.tenantId, t.b.taskId, t.a.userId],
        );
      }),
    ).rejects.toThrow(/violates foreign key constraint "comments_task_fk"/i);
  });

  it('cannot insert an audit entry attributed to another tenant', async () => {
    await expect(
      withTenant(t.a.tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO audit_log (tenant_id, action, entity_type) VALUES ($1, 'forged', 'task')`,
          [t.b.tenantId],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot rewrite its own audit trail (append-only: no UPDATE or DELETE grant)', async () => {
    await expect(
      withTenant(t.a.tenantId, async (tx) => {
        await tx.query('UPDATE audit_log SET action = $1 WHERE tenant_id = $2', [
          'covered-up',
          t.a.tenantId,
        ]);
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenant(t.a.tenantId, async (tx) => {
        await tx.query('DELETE FROM audit_log WHERE tenant_id = $1', [t.a.tenantId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('writes to a tenant that does not exist are rejected by the FK, not silently accepted', async () => {
    const ghost = orphanUuid();
    await expect(
      withTenant(ghost, async (tx) => {
        await tx.query(
          `INSERT INTO projects (tenant_id, key, name) VALUES ($1, 'GHOST', 'nowhere')`,
          [ghost],
        );
      }),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  /**
   * The tenant id reaches `set_config` as a bind parameter, so it is not an injection
   * vector even unvalidated. The explicit UUID check in withTenant() is a second,
   * independent layer — this asserts it rejects before any SQL is issued.
   */
  it('refuses a malformed tenant id before touching the database', async () => {
    const attacks = [
      "00000000-0000-0000-0000-000000000000'; DROP TABLE tasks; --",
      'not-a-uuid',
      '',
      '../../etc/passwd',
    ];

    for (const attack of attacks) {
      await expect(
        withTenant(attack, async (tx) => tx.query('SELECT 1')),
      ).rejects.toBeInstanceOf(InvalidTenantIdError);
    }

    // The table is, unsurprisingly, still there.
    const { rows } = await admin().query('SELECT to_regclass($1) AS t', ['public.tasks']);
    expect(rows[0]!.t).toBe('tasks');
  });
});
