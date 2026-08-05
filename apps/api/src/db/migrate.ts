import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createAdminPool } from './pool.js';

/**
 * Forward-only SQL migration runner.
 *
 * Deliberately hand-written rather than pulled from a library. The whole point of this
 * project is that the row-level security policies are auditable, and a runner you can
 * read in one sitting is part of that: there is no framework behaviour to reason about
 * when asking "did policy X actually get applied to database Y".
 *
 * Properties:
 *   - Forward only. No `down` migrations: rollback in production is a restore or a new
 *     forward migration, and reversible-migration machinery mostly provides false
 *     comfort about operations nobody rehearses.
 *   - Each file plus its bookkeeping row commits in ONE transaction, so a partially
 *     applied migration can never be recorded as complete.
 *   - Checksums are recorded and re-verified. Editing an already-applied migration is a
 *     hard error, because the file no longer describes the database.
 *   - A session-level advisory lock serialises concurrent runners, so N replicas
 *     starting at once (a Kubernetes rollout, a Job with parallelism) do not race.
 *
 * Runs as the admin/owner role, not `app_user`. `app_user` has no access to
 * schema_migrations at all.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Arbitrary but fixed. Any 64-bit constant works as long as every runner agrees. */
const ADVISORY_LOCK_KEY = 8_142_539_771_004_002n;

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const entries = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  return Promise.all(
    entries.map(async (name) => {
      const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
      // Normalise line endings before hashing. Without this, a checkout on Windows with
      // autocrlf produces different checksums from CI on Linux, and every deploy would
      // report the migrations as tampered with.
      const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      return { name, sql, checksum };
    }),
  );
}

async function ensureBookkeepingTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text        PRIMARY KEY,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer     NOT NULL
    )
  `);
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(pool: Pool, log = console.log): Promise<MigrateResult> {
  const files = await loadMigrations();
  if (files.length === 0) throw new Error(`no .sql files found in ${MIGRATIONS_DIR}`);

  const lockConn = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    // Session-scoped: held until explicitly unlocked or the connection closes. Blocks
    // rather than failing, so a second replica waits for the first to finish instead of
    // crash-looping.
    await lockConn.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY.toString()]);

    await ensureBookkeepingTable(pool);

    const { rows } = await pool.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const alreadyApplied = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const recorded = alreadyApplied.get(file.name);

      if (recorded !== undefined) {
        if (recorded !== file.checksum) {
          throw new Error(
            `Migration ${file.name} has changed since it was applied.\n` +
              `  recorded checksum: ${recorded}\n` +
              `  file checksum:     ${file.checksum}\n` +
              `Applied migrations are immutable. Add a new migration instead of editing this one.`,
          );
        }
        skipped.push(file.name);
        continue;
      }

      const started = Date.now();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)',
          [file.name, file.checksum, Date.now() - started],
        );
        await client.query('COMMIT');
        applied.push(file.name);
        log(`  applied ${file.name} (${Date.now() - started} ms)`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(
          `Migration ${file.name} failed and was rolled back: ${(err as Error).message}`,
          { cause: err },
        );
      } finally {
        client.release();
      }
    }
  } finally {
    await lockConn.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY.toString()]).catch(
      () => undefined,
    );
    lockConn.release();
  }

  return { applied, skipped };
}

/** CLI entry point: `npm run migrate`. */
async function main(): Promise<void> {
  const pool = createAdminPool();
  try {
    console.log('running migrations...');
    const { applied, skipped } = await migrate(pool);
    if (applied.length === 0) {
      console.log(`database is up to date (${skipped.length} migrations already applied)`);
    } else {
      console.log(`applied ${applied.length} migration(s); ${skipped.length} already present`);
    }
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly, so the test suite can import migrate() and point it at
// a throwaway database.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
