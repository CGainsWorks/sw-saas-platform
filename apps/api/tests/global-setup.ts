import { createAdminPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

/**
 * Runs once before the whole suite: brings the test database up to the current schema.
 *
 * The isolation tests are only meaningful against a real PostgreSQL with real row-level
 * security. There is no mock here and there should not be — a mock would be asserting
 * that the test double behaves the way I believe Postgres does, which is precisely the
 * belief under test.
 */
export default async function setup(): Promise<void> {
  const pool = createAdminPool();
  try {
    await migrate(pool, () => undefined);
  } catch (err) {
    throw new Error(
      'Could not migrate the test database. Is it running? Try: docker compose up -d postgres redis\n' +
        `Underlying error: ${(err as Error).message}`,
    );
  } finally {
    await pool.end();
  }
}
