import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { pool } from './pool.js';
import { dbQueryDuration, dbTransactionDuration } from '../observability/metrics.js';

/**
 * Tenant-scoped database access. This module is the chokepoint described in
 * docs/multi_tenancy.md §2 — it is the only place in the codebase that hands a database
 * connection to business logic.
 *
 * The rule it enforces: you cannot obtain a connection without naming a tenant, and the
 * tenant you name is installed into the transaction as `app.current_tenant`, which is
 * what every row-level security policy reads.
 */

/** Postgres session variable read by the `tenant_isolation` policies. */
const TENANT_SETTING = 'app.current_tenant';

/**
 * Shape check, not a version check. Version-agnostic on purpose — pinning to v4 would
 * reject UUIDv7 if the schema ever moves to time-ordered keys, and the security property
 * wanted here is just "hex digits and dashes, nothing else", which this gives.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantIdError extends Error {
  constructor(value: unknown) {
    super(`invalid tenant id: ${typeof value === 'string' ? JSON.stringify(value) : typeof value}`);
    this.name = 'InvalidTenantIdError';
  }
}

/**
 * The restricted handle handed to business logic.
 *
 * Note what is *absent*: no `release()`, no `BEGIN`/`COMMIT`, no access to the underlying
 * pool. Business logic cannot escape the transaction, cannot hold the connection beyond
 * the callback, and cannot change the tenant setting mid-flight.
 */
export interface TenantClient {
  readonly tenantId: string;
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

function labelFor(sql: string): string {
  // First keyword only. Metric labels must stay low-cardinality; the full statement
  // would be unbounded.
  const m = /^\s*(select|insert|update|delete|with)/i.exec(sql);
  return m?.[1]?.toLowerCase() ?? 'other';
}

function wrap(client: PoolClient, tenantId: string): TenantClient {
  return {
    tenantId,
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      const stop = dbQueryDuration.startTimer({ operation: labelFor(text) });
      try {
        return await client.query<R>(text, params as unknown[] | undefined);
      } finally {
        stop();
      }
    },
  };
}

/**
 * Run `fn` inside a transaction scoped to `tenantId`.
 *
 * Why a transaction even for a single SELECT: `SET LOCAL` is transaction-scoped and is
 * reverted on COMMIT/ROLLBACK. Plain `SET` would persist on the pooled connection and be
 * inherited by whichever tenant's request picks that connection up next — an
 * intermittent, concurrency-dependent cross-tenant leak that passes every serial test.
 * The extra BEGIN/COMMIT round trip (~0.3 ms locally) buys the guarantee that the tenant
 * setting cannot outlive the request that set it.
 *
 * `set_config(name, value, is_local := true)` is the function form of `SET LOCAL`, and
 * unlike the statement form it accepts a bind parameter — so the tenant id never reaches
 * the SQL string. The UUID check above it is a second, independent layer: it means that
 * even if this were later rewritten to interpolate, a non-UUID could not get through.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
    throw new InvalidTenantIdError(tenantId);
  }

  const stopTxTimer = dbTransactionDuration.startTimer();
  const client = await pool.connect();
  let released = false;

  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', [TENANT_SETTING, tenantId]);

    const result = await fn(wrap(client, tenantId));

    await client.query('COMMIT');
    stopTxTimer({ outcome: 'commit' });
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
      stopTxTimer({ outcome: 'rollback' });
    } catch (rollbackErr) {
      // A failed ROLLBACK means the session is unusable. Releasing *with an error* tells
      // pg to destroy the connection rather than return a poisoned session — one that
      // may still hold an open transaction, and with it another tenant's setting — to
      // the pool. Marked as released so the finally block does not double-release,
      // which pg treats as an error in its own right.
      client.release(rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)));
      released = true;
      stopTxTimer({ outcome: 'broken' });
    }
    throw err;
  } finally {
    if (!released) client.release();
  }
}

/**
 * Read-only variant. Adds `SET TRANSACTION READ ONLY`, so a handler that is supposed to
 * be a query cannot write even if a future edit introduces an INSERT. Used by the
 * GraphQL query path, which fans out through many resolvers and is the easiest place for
 * an unintended write to hide.
 */
export async function withTenantReadOnly<T>(
  tenantId: string,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
    throw new InvalidTenantIdError(tenantId);
  }

  const client = await pool.connect();
  let released = false;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SELECT set_config($1, $2, true)', [TENANT_SETTING, tenantId]);
    const result = await fn(wrap(client, tenantId));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      client.release(rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)));
      released = true;
    }
    throw err;
  } finally {
    if (!released) client.release();
  }
}

/**
 * A transaction that begins with **no** tenant context, and can adopt one part-way.
 *
 * This exists for exactly one job: provisioning. Signing up a new tenant has to insert
 * the `tenants` row (not RLS-protected) and the `users` row (not RLS-protected) before a
 * tenant id exists to scope by, then insert the `memberships` row (RLS-protected), which
 * requires the context to be set. All three must be atomic.
 *
 * It is named to be conspicuous in a diff. It is used in one file — `services/provisioning.ts`
 * — and a test asserts that no other module imports it. Note that it grants no extra
 * database privilege: the connection is still `app_user`, so before `setTenant` is called
 * every RLS-protected table returns and accepts nothing.
 */
export interface ProvisioningClient extends Omit<TenantClient, 'tenantId'> {
  readonly tenantId: string | null;
  setTenant(tenantId: string): Promise<void>;
}

export async function withProvisioningTransaction<T>(
  fn: (tx: ProvisioningClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let current: string | null = null;

  const tx: ProvisioningClient = {
    get tenantId() {
      return current;
    },
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      return client.query<R>(text, params as unknown[] | undefined);
    },
    async setTenant(tenantId: string): Promise<void> {
      if (!UUID_RE.test(tenantId)) throw new InvalidTenantIdError(tenantId);
      await client.query('SELECT set_config($1, $2, true)', [TENANT_SETTING, tenantId]);
      current = tenantId;
    },
  };

  let released = false;
  try {
    await client.query('BEGIN');
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      client.release(rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)));
      released = true;
    }
    throw err;
  } finally {
    if (!released) client.release();
  }
}
