// Prints an access token for alice@acme.test (owner of the seeded Acme Corp tenant).
//
// Runs INSIDE the api container, so it signs with the application's own code and key:
//
//   docker compose exec -T api node --input-type=module - < loadtest/mint-token.mjs
//
// Relative imports resolve from the container's working directory, /app/apps/api.
import { createAdminPool } from './dist/db/pool.js';
import { signAccessToken } from './dist/auth/jwt.js';

const db = createAdminPool();
try {
  const { rows } = await db.query(
    `SELECT u.id AS user_id, m.tenant_id, m.role, u.email
       FROM users u JOIN memberships m ON m.user_id = u.id
       JOIN tenants t ON t.id = m.tenant_id
      WHERE u.email = 'alice@acme.test' AND t.slug = 'acme-corp'`,
  );
  if (rows.length !== 1) throw new Error('seeded user alice@acme.test not found');
  const r = rows[0];
  const { token } = await signAccessToken({
    userId: r.user_id,
    tenantId: r.tenant_id,
    role: r.role,
    email: r.email,
  });
  process.stdout.write(token);
} finally {
  await db.end();
}
// Imported modules may hold open handles (a Redis client, the app pool); do not wait for them.
process.exit(0);
