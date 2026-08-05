#!/usr/bin/env node
/**
 * Mutation check for the tenant isolation test suite.
 *
 * A passing test suite proves nothing on its own — it might pass because the assertions
 * are vacuous. This script answers the harder question: *would these tests notice if the
 * protection were removed?*
 *
 * For each tenant-owned table it disables row-level security, re-runs the isolation
 * suite, and asserts the suite goes RED. Then it restores the policy and asserts the
 * suite goes GREEN again. A table whose sabotage does not break any test is reported as
 * a failure of the test suite, not of the schema.
 *
 * This is the script behind the isolation numbers quoted in the README.
 *
 *   node scripts/verify-isolation.mjs
 *
 * Requires the dev database to be up:  docker compose up -d postgres redis
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = join(ROOT, 'apps', 'api');

if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));

const ADMIN_DSN =
  process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5433/saas';

const TENANT_OWNED = ['memberships', 'projects', 'tasks', 'comments', 'audit_log'];

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * Path to vitest's own entry script.
 *
 * Resolved from its package manifest and run with `process.execPath` rather than shelling
 * out to `npx`. On Windows, Node refuses to spawn a `.cmd` shim without `shell: true`
 * (the fix for CVE-2024-27980), and `shell: true` concatenates arguments unescaped
 * (DEP0190). Invoking the JS entry point directly sidesteps both and is faster.
 */
function vitestEntry() {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('vitest/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.vitest;
  return join(dirname(manifestPath), bin);
}

const VITEST = vitestEntry();

/** Runs the isolation suite. Returns whether it passed, plus its combined output. */
function runSuite() {
  const res = spawnSync(
    process.execPath,
    [VITEST, 'run', 'tests/isolation', '--reporter=dot'],
    { cwd: API_DIR, encoding: 'utf8', env: { ...process.env, CI: '' } },
  );
  return { passed: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function countFailures(output) {
  const m = /Tests\s+(\d+)\s+failed/.exec(output);
  return m ? Number(m[1]) : 0;
}

const client = new pg.Client({ connectionString: ADMIN_DSN });

async function setRls(table, enabled) {
  if (enabled) {
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  } else {
    await client.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
  }
}

async function main() {
  await client.connect();

  const results = [];
  let ok = true;

  try {
    process.stdout.write('baseline (all policies intact) ... ');
    const baseline = runSuite();
    if (!baseline.passed) {
      console.log(`${RED}FAIL${RESET}`);
      console.error('\nThe suite does not pass before any sabotage. Fix that first.\n');
      console.error(baseline.output.slice(-4000));
      process.exit(1);
    }
    console.log(`${GREEN}green${RESET}`);

    for (const table of TENANT_OWNED) {
      process.stdout.write(`  RLS disabled on ${table.padEnd(12)} ... `);
      await setRls(table, false);
      const sabotaged = runSuite();
      await setRls(table, true);

      const failures = countFailures(sabotaged.output);
      const detected = !sabotaged.passed;
      results.push({ table, detected, failures });

      if (detected) {
        console.log(`${GREEN}detected${RESET} ${DIM}(${failures} test(s) failed)${RESET}`);
      } else {
        console.log(`${RED}NOT DETECTED${RESET}`);
        ok = false;
      }
    }

    process.stdout.write('restored (all policies re-applied) ... ');
    const restored = runSuite();
    if (!restored.passed) {
      console.log(`${RED}FAIL${RESET}`);
      console.error('\nSuite did not return to green after restoring policies.\n');
      console.error(restored.output.slice(-4000));
      process.exit(1);
    }
    console.log(`${GREEN}green${RESET}`);
  } finally {
    // Belt and braces: never leave the database with a policy disabled, even on a crash.
    for (const table of TENANT_OWNED) {
      await setRls(table, true).catch(() => undefined);
    }
    await client.end();
  }

  console.log('\n--- summary ---');
  for (const r of results) {
    console.log(
      `  ${r.detected ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`}  removing RLS from ` +
        `${r.table.padEnd(12)} broke ${r.failures} test(s)`,
    );
  }

  if (!ok) {
    console.error(
      `\n${RED}At least one table's protection can be removed without any test noticing.${RESET}\n` +
        'That table is effectively untested. Add a cross-tenant attack test for it.\n',
    );
    process.exit(1);
  }

  console.log(
    `\n${GREEN}All ${TENANT_OWNED.length} tenant-owned tables are covered by a test that ` +
      `fails when their policy is removed.${RESET}\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
