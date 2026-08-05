import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createAdminPool } from './pool.js';

/**
 * Demo data.
 *
 * Two tenants with deliberately similar-looking content, because the point of the demo is
 * that you cannot see one from the other. The seeded users line up with the accounts
 * offered by the dev identity provider (apps/dev-idp/src/users.ts):
 *
 *   Acme Corp    alice (owner), bob (member), dave (admin)
 *   Globex       carol (owner), dave (member)
 *
 * dave belongs to both, which is what makes tenant switching demonstrable — and makes the
 * "a token for Acme grants nothing in Globex" test meaningful, since the same human is
 * legitimately present on both sides.
 *
 * erin@newco.test is intentionally NOT seeded: logging in as her exercises the self-serve
 * provisioning path and creates a fresh tenant.
 *
 * Runs on the admin connection, which bypasses RLS. That is required and unavoidable — a
 * tenant-scoped connection cannot, by construction, write rows for two tenants. It is
 * also why seeding is a separate script and not something the application can do.
 *
 * Idempotent: safe to run on every container start.
 */

interface SeedUser {
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
}

interface SeedTenant {
  slug: string;
  name: string;
  plan: 'free' | 'pro' | 'enterprise';
  users: SeedUser[];
  projects: Array<{
    key: string;
    name: string;
    description: string;
    tasks: Array<{
      title: string;
      status: 'todo' | 'in_progress' | 'blocked' | 'done';
      priority: 'low' | 'medium' | 'high' | 'urgent';
      assignee?: string;
      comments?: string[];
    }>;
  }>;
}

const TENANTS: SeedTenant[] = [
  {
    slug: 'acme-corp',
    name: 'Acme Corp',
    plan: 'pro',
    users: [
      { email: 'alice@acme.test', name: 'Alice Nguyen', role: 'owner' },
      { email: 'bob@acme.test', name: 'Bob Ferreira', role: 'member' },
      { email: 'dave@globex.test', name: 'Dave Okonkwo', role: 'admin' },
    ],
    projects: [
      {
        key: 'PLAT',
        name: 'Platform migration',
        description: 'Move the monolith onto the new cluster.',
        tasks: [
          {
            title: 'Acme: negotiate renewal with supplier',
            status: 'in_progress',
            priority: 'urgent',
            assignee: 'alice@acme.test',
            comments: [
              'Confidential to Acme: our ceiling is 180k.',
              'Supplier came back at 205k. Pushing back.',
            ],
          },
          {
            title: 'Acme: cut over the staging database',
            status: 'todo',
            priority: 'high',
            assignee: 'bob@acme.test',
          },
          { title: 'Acme: decommission the old load balancers', status: 'done', priority: 'low' },
        ],
      },
      {
        key: 'OPS',
        name: 'Operations',
        description: 'Routine operational work.',
        tasks: [
          {
            title: 'Acme: rotate production credentials',
            status: 'blocked',
            priority: 'high',
            assignee: 'dave@globex.test',
            comments: ['Blocked on the security review.'],
          },
        ],
      },
    ],
  },
  {
    slug: 'globex',
    name: 'Globex',
    plan: 'enterprise',
    users: [
      { email: 'carol@globex.test', name: 'Carol Baptiste', role: 'owner' },
      { email: 'dave@globex.test', name: 'Dave Okonkwo', role: 'member' },
    ],
    projects: [
      {
        key: 'OPS',
        // Same project key as Acme's, on purpose: keys are unique per tenant, not
        // globally, and a demo where every value is distinct hides that.
        name: 'Operations',
        description: 'Globex operational work.',
        tasks: [
          {
            title: 'Globex: prepare the Q3 board pack',
            status: 'in_progress',
            priority: 'urgent',
            assignee: 'carol@globex.test',
            comments: [
              'Confidential to Globex: margin slipped to 11%. Do not circulate.',
              'Legal wants the contingent liability footnote reworded.',
            ],
          },
          {
            title: 'Globex: audit third-party data processors',
            status: 'todo',
            priority: 'medium',
            assignee: 'dave@globex.test',
          },
        ],
      },
    ],
  },
];

async function seedTenant(db: Pool, spec: SeedTenant): Promise<void> {
  const { rows: tenantRows } = await db.query<{ id: string }>(
    `INSERT INTO tenants (slug, name, plan) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, plan = EXCLUDED.plan
     RETURNING id`,
    [spec.slug, spec.name, spec.plan],
  );
  const tenantId = tenantRows[0]!.id;

  const userIds = new Map<string, string>();
  for (const u of spec.users) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, $2)
       ON CONFLICT (lower(email)) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [u.email, u.name],
    );
    const userId = rows[0]!.id;
    userIds.set(u.email, userId);

    await db.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [tenantId, userId, u.role],
    );
  }

  for (const p of spec.projects) {
    const { rows: projectRows } = await db.query<{ id: string }>(
      `INSERT INTO projects (tenant_id, key, name, description) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
       RETURNING id`,
      [tenantId, p.key, p.name, p.description],
    );
    const projectId = projectRows[0]!.id;

    for (const t of p.tasks) {
      // Tasks have no natural key, so re-running would duplicate them without this check.
      const { rows: existing } = await db.query<{ id: string }>(
        `SELECT id FROM tasks WHERE tenant_id = $1 AND project_id = $2 AND title = $3`,
        [tenantId, projectId, t.title],
      );

      const assigneeId = t.assignee ? (userIds.get(t.assignee) ?? null) : null;
      let taskId: string;

      if (existing[0]) {
        taskId = existing[0].id;
        await db.query(`UPDATE tasks SET status = $2, priority = $3, assignee_id = $4 WHERE id = $1`, [
          taskId,
          t.status,
          t.priority,
          assigneeId,
        ]);
      } else {
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO tasks (tenant_id, project_id, title, status, priority, assignee_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [tenantId, projectId, t.title, t.status, t.priority, assigneeId],
        );
        taskId = rows[0]!.id;
      }

      for (const body of t.comments ?? []) {
        await db.query(
          `INSERT INTO comments (tenant_id, task_id, author_id, body)
           SELECT $1, $2, $3, $4
            WHERE NOT EXISTS (
              SELECT 1 FROM comments WHERE tenant_id = $1 AND task_id = $2 AND body = $4
            )`,
          [tenantId, taskId, assigneeId, body],
        );
      }
    }
  }

  console.log(`  seeded ${spec.name} (${spec.slug})`);
}

export async function seed(db: Pool): Promise<void> {
  for (const spec of TENANTS) await seedTenant(db, spec);
}

async function main(): Promise<void> {
  const pool = createAdminPool();
  try {
    console.log('seeding demo data...');
    await seed(pool);
    console.log('done. Log in at http://localhost:3000 as any of the demo users.');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
