import { afterAll, describe, expect, it } from 'vitest';
import { assertLeastPrivilege, pool } from '../../src/db/pool.js';
import { admin, closeAdmin } from '../helpers/fixtures.js';

/**
 * Structural invariants of the isolation mechanism itself.
 *
 * The behavioural tests in rls-reads/rls-writes prove the boundary holds *today*, for
 * the tables that exist today. These assert the properties that make it keep holding:
 * that a new table added next year cannot quietly join the schema without a policy, and
 * that the role the application connects as still cannot step around the whole system.
 *
 * This is the file that fails when someone adds a table and forgets the RLS.
 */
describe('isolation invariants', () => {
  afterAll(async () => {
    await closeAdmin();
    await pool.end();
  });

  /** Tables that hold tenant-owned rows and must therefore be policy-protected. */
  const TENANT_OWNED = ['memberships', 'projects', 'tasks', 'comments', 'audit_log'];

  /** Tables intentionally exempt. Every entry is justified in docs/multi_tenancy.md §4. */
  const EXEMPT = ['tenants', 'users', 'schema_migrations'];

  it('the application role is neither superuser nor BYPASSRLS', async () => {
    const { rows } = await pool.query<{
      role: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
    }>(
      `SELECT current_user AS role, rolsuper, rolbypassrls, rolcreaterole
         FROM pg_roles WHERE rolname = current_user`,
    );

    const r = rows[0]!;
    expect(r.role).toBe('app_user');
    expect(r.rolsuper).toBe(false);
    expect(r.rolbypassrls).toBe(false);
    expect(r.rolcreaterole).toBe(false);
  });

  it('assertLeastPrivilege() passes for the configured DATABASE_URL', async () => {
    // The same check the API runs at boot. If DATABASE_URL were ever repointed at the
    // master user "to fix a permissions error", this is what stops it reaching a
    // serving state — every policy is silently inert for a superuser.
    await expect(assertLeastPrivilege()).resolves.toBeUndefined();
  });

  it('every tenant-owned table has RLS both ENABLED and FORCED', async () => {
    const { rows } = await admin().query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`,
    );

    const byName = new Map(rows.map((r) => [r.relname, r]));

    for (const table of TENANT_OWNED) {
      const r = byName.get(table);
      expect(r, `table ${table} is missing`).toBeDefined();
      expect(r!.relrowsecurity, `${table}: RLS not enabled`).toBe(true);
      // FORCE matters independently: without it the table OWNER is exempt, and running
      // the app as the owner is an easy and silent mistake.
      expect(r!.relforcerowsecurity, `${table}: RLS not FORCED`).toBe(true);
    }
  });

  /**
   * Catches the "new table, forgotten policy" failure. Any future table in `public` is
   * either declared tenant-owned (and must be protected) or explicitly exempt — there is
   * no third option that passes.
   */
  it('has no unclassified tables in the public schema', async () => {
    const { rows } = await admin().query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`,
    );

    const known = new Set([...TENANT_OWNED, ...EXEMPT]);
    const unclassified = rows.map((r) => r.relname).filter((n) => !known.has(n));

    expect(
      unclassified,
      `New table(s) with no isolation decision: ${unclassified.join(', ')}. ` +
        'Add RLS and list it in TENANT_OWNED, or justify it in docs/multi_tenancy.md §4 and list it in EXEMPT.',
    ).toEqual([]);
  });

  it('every policy has BOTH a USING and a WITH CHECK clause', async () => {
    const { rows } = await admin().query<{
      tablename: string;
      policyname: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT tablename, policyname, qual, with_check
         FROM pg_policies WHERE schemaname = 'public'`,
    );

    expect(rows.length).toBe(TENANT_OWNED.length);

    for (const p of rows) {
      // USING alone is the classic half-done policy: reads are filtered, writes are not.
      expect(p.qual, `${p.tablename}.${p.policyname} has no USING clause`).toBeTruthy();
      expect(
        p.with_check,
        `${p.tablename}.${p.policyname} has no WITH CHECK clause — INSERT/UPDATE can forge tenant_id`,
      ).toBeTruthy();
      expect(p.qual).toContain('app_current_tenant()');
      expect(p.with_check).toContain('app_current_tenant()');
    }
  });

  it('every tenant-owned table has a NOT NULL tenant_id', async () => {
    const { rows } = await admin().query<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id'`,
    );

    const byTable = new Map(rows.map((r) => [r.table_name, r.is_nullable]));
    for (const table of TENANT_OWNED) {
      // A nullable tenant_id would produce rows that no policy matches and no tenant can
      // ever see or delete — invisible orphans.
      expect(byTable.get(table), `${table}.tenant_id`).toBe('NO');
    }
  });

  it('app_current_tenant() is NULL when no context is set (fail closed)', async () => {
    const { rows } = await pool.query<{ t: string | null }>('SELECT app_current_tenant() AS t');
    expect(rows[0]!.t).toBeNull();
  });

  // Postgres words these two denials differently — "must be owner of table" for ALTER
  // TABLE, "must be owner of relation" for DROP POLICY — so match the common prefix.
  const NOT_OWNER = /must be owner of|permission denied/i;

  it('the application role cannot disable row-level security', async () => {
    await expect(pool.query('ALTER TABLE projects DISABLE ROW LEVEL SECURITY')).rejects.toThrow(
      NOT_OWNER,
    );
  });

  it('the application role cannot drop a policy', async () => {
    await expect(pool.query('DROP POLICY tenant_isolation ON tasks')).rejects.toThrow(NOT_OWNER);
  });

  it('the application role cannot escalate via SET ROLE', async () => {
    await expect(pool.query('SET ROLE postgres')).rejects.toThrow(/permission denied/i);
  });

  it('the application role cannot read migration bookkeeping', async () => {
    await expect(pool.query('SELECT * FROM schema_migrations')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('the application role cannot create tables in the public schema', async () => {
    await expect(pool.query('CREATE TABLE should_not_exist (id int)')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('app_current_tenant() is not SECURITY DEFINER', async () => {
    // A SECURITY DEFINER function here would execute as the owner and could be turned
    // into an escalation primitive.
    const { rows } = await admin().query<{ prosecdef: boolean }>(
      `SELECT prosecdef FROM pg_proc WHERE proname = 'app_current_tenant'`,
    );
    expect(rows[0]!.prosecdef).toBe(false);
  });
});
