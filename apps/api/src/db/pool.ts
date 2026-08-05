import pg from 'pg';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { dbPoolGauge } from '../observability/metrics.js';

const cfg = loadConfig();

/**
 * Return timestamps as ISO strings rather than JS Date objects.
 *
 * node-postgres parses `timestamptz` into a Date using the *server process* timezone,
 * which is a well-known source of off-by-hours bugs when the API container and the
 * database disagree. The wire format is ISO 8601 UTC end to end; JSON serialisation of
 * a Date would produce that anyway, so this only removes an opportunity to get it wrong.
 */
const TIMESTAMPTZ_OID = 1184;
const TIMESTAMP_OID = 1114;
pg.types.setTypeParser(TIMESTAMPTZ_OID, (v) => (v === null ? null : new Date(v).toISOString()));
pg.types.setTypeParser(TIMESTAMP_OID, (v) => (v === null ? null : new Date(`${v}Z`).toISOString()));

// int8 arrives as a string by default to avoid precision loss. Every int8 in this schema
// is a COUNT(*), which is safely within Number range.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

/**
 * The application pool. Connects as `app_user`: NOSUPERUSER, NOBYPASSRLS, owner of
 * nothing. This is not a detail — RLS policies are silently ignored for superusers and
 * table owners, so connecting as `postgres` here would disable every policy in
 * migration 0002 while leaving the code looking correct.
 *
 * `assertLeastPrivilege()` below verifies this at boot instead of trusting the DSN.
 */
export const pool = new pg.Pool({
  connectionString: cfg.DATABASE_URL,
  max: cfg.PGPOOL_MAX,
  idleTimeoutMillis: cfg.PGPOOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: cfg.PGPOOL_CONNECT_TIMEOUT_MS,
  // Applied to every session in the pool: a single runaway query cannot pin a
  // connection forever and starve other tenants of the shared pool.
  statement_timeout: cfg.PG_STATEMENT_TIMEOUT_MS,
  idle_in_transaction_session_timeout: cfg.PG_STATEMENT_TIMEOUT_MS * 2,
  application_name: 'saas-api',
});

pool.on('error', (err) => {
  // An error on an *idle* client. Not tied to a request, so it has to be logged here or
  // it is lost; left unhandled it would take the process down.
  logger.error({ err }, 'idle postgres client error');
});

/** Admin pool for migrations and seeding only. Never used by a request path. */
export function createAdminPool(): pg.Pool {
  const dsn = cfg.DATABASE_ADMIN_URL ?? cfg.DATABASE_URL;
  return new pg.Pool({ connectionString: dsn, max: 2, application_name: 'saas-api-admin' });
}

/**
 * Boot-time assertion that the application's own database role cannot bypass RLS.
 *
 * The failure this guards against is a deployment where someone "fixed" a permissions
 * error by pointing DATABASE_URL at the master user. Every isolation test would still
 * pass in CI (they connect as app_user explicitly), the application would work, and
 * tenant isolation would be gone. Checking it at boot means that mistake cannot reach
 * a serving state.
 */
export async function assertLeastPrivilege(): Promise<void> {
  const { rows } = await pool.query<{
    role: string;
    is_super: boolean;
    can_bypass_rls: boolean;
  }>(
    `SELECT current_user                AS role,
            rolsuper                    AS is_super,
            rolbypassrls                AS can_bypass_rls
       FROM pg_roles
      WHERE rolname = current_user`,
  );

  const row = rows[0];
  if (!row) throw new Error('could not resolve current database role');

  if (row.is_super || row.can_bypass_rls) {
    throw new Error(
      `Refusing to start: database role "${row.role}" ` +
        `(superuser=${row.is_super}, bypassrls=${row.can_bypass_rls}) can bypass row-level ` +
        `security, which disables tenant isolation. Point DATABASE_URL at app_user.`,
    );
  }

  logger.info({ role: row.role }, 'database role verified as non-bypassing');
}

export function reportPoolMetrics(): void {
  dbPoolGauge.set({ state: 'total' }, pool.totalCount);
  dbPoolGauge.set({ state: 'idle' }, pool.idleCount);
  dbPoolGauge.set({ state: 'waiting' }, pool.waitingCount);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
