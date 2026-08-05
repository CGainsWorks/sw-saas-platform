import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { closeRedis } from '../../src/cache/redis.js';
import { bearer, closeApp, gql, testApp, tokenFor } from '../helpers/app.js';
import { closeAdmin, dropTenants, seedTwoTenants, type TwoTenants } from '../helpers/fixtures.js';

/**
 * Cross-tenant attacks through GraphQL.
 *
 * GraphQL deserves its own suite rather than being assumed safe because REST is. Two
 * things make it structurally different:
 *
 *   1. **Nested field resolvers.** `project { tasks { comments { ... } } }` reaches data
 *      through resolvers that run *after* the top-level field was authorised. A REST
 *      route guard has no equivalent, and "the parent was allowed, so the children are"
 *      is exactly the reasoning that produces leaks.
 *
 *   2. **One endpoint, many operations.** Per-route middleware does not exist. Anything
 *      enforced by `preHandler` in REST has to be enforced again inside the resolvers,
 *      or the GraphQL endpoint silently becomes the more permissive door.
 */
/**
 * Builds `n` round trips around the Project <-> Task cycle, so the nesting depth is
 * derived rather than hand-counted. Each level adds 2 to the measured depth; `n = 6`
 * gives 13, comfortably past the default limit of 10.
 */
function nestedSelection(levels: number): string {
  return levels === 0 ? 'id' : `tasks { project { ${nestedSelection(levels - 1)} } }`;
}

describe('tenant isolation — GraphQL', () => {
  let app: FastifyInstance;
  let t: TwoTenants;
  let tokenA: string;

  beforeAll(async () => {
    app = await testApp();
    t = await seedTwoTenants();
    tokenA = await tokenFor(t.a);
  });

  afterAll(async () => {
    await dropTenants(t.a.tenantId, t.b.tenantId);
    await closeApp();
    await closeAdmin();
    await closeRedis();
    await pool.end();
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: '{ projects { id } }' }),
    });
    // Unauthenticated: either the transport rejects it or the operation errors — what
    // matters is that no data comes back.
    const body = res.body ? (JSON.parse(res.body) as { data?: unknown }) : {};
    expect(body.data ?? null).toBeNull();
  });

  it('returns only the caller\'s own projects', async () => {
    const { data } = await gql(app, tokenA, '{ projects { id name } }');
    const projects = (data as { projects: Array<{ id: string }> }).projects;

    expect(projects.map((p) => p.id)).toContain(t.a.projectId);
    expect(projects.map((p) => p.id)).not.toContain(t.b.projectId);
  });

  it('returns null for another tenant\'s project by id', async () => {
    const { data } = await gql(app, tokenA, 'query($id: ID!) { project(id: $id) { id name } }', {
      id: t.b.projectId,
    });
    expect((data as { project: unknown }).project).toBeNull();
  });

  it('returns null for another tenant\'s task by id', async () => {
    const { data } = await gql(app, tokenA, 'query($id: ID!) { task(id: $id) { id title } }', {
      id: t.b.taskId,
    });
    expect((data as { task: unknown }).task).toBeNull();
  });

  /**
   * The case REST cannot express. Every nested resolver batches through a DataLoader that
   * opens its own tenant-scoped transaction, so the scoping is re-applied at each level
   * rather than inherited from the parent.
   */
  it('does not leak foreign data through nested resolvers', async () => {
    const { data } = await gql(
      app,
      tokenA,
      `{
        projects {
          id
          tasks {
            id
            title
            comments { id body }
            assignee { id email }
            project { id }
          }
        }
      }`,
    );

    const json = JSON.stringify(data);

    // Nothing belonging to tenant B may appear anywhere in the response tree.
    expect(json).not.toContain(t.b.projectId);
    expect(json).not.toContain(t.b.taskId);
    expect(json).not.toContain(t.b.commentId);
    expect(json).not.toContain(t.b.userEmail);
    // Every fixture belonging to tenant B is prefixed "beta"; tenant A's is "alpha". A
    // bare "private comment" check would match tenant A's own legitimate comment and pass
    // for the wrong reason.
    expect(json).not.toContain('beta');

    // And the query genuinely returned something, so this is not passing vacuously.
    expect(json).toContain(t.a.projectId);
    expect(json).toContain('alpha');
  });

  it('cannot mutate another tenant\'s task', async () => {
    const { data, errors } = await gql(
      app,
      tokenA,
      'mutation($id: ID!) { updateTask(id: $id, input: { title: "pwned" }) { id title } }',
      { id: t.b.taskId },
    );

    expect((data as { updateTask?: unknown } | null)?.updateTask ?? null).toBeNull();
    expect(errors?.[0]?.message).toMatch(/not found/i);
  });

  it('cannot create a task inside another tenant\'s project', async () => {
    const { errors } = await gql(
      app,
      tokenA,
      'mutation($p: ID!) { createTask(input: { projectId: $p, title: "planted" }) { id } }',
      { p: t.b.projectId },
    );
    expect(errors?.[0]?.message).toMatch(/not found/i);
  });

  it('cannot comment on another tenant\'s task', async () => {
    const { errors } = await gql(
      app,
      tokenA,
      'mutation($t: ID!) { addComment(taskId: $t, body: "injected") { id } }',
      { t: t.b.taskId },
    );
    expect(errors?.[0]?.message).toMatch(/not found/i);
  });

  it('cannot enumerate another tenant\'s members', async () => {
    const { data } = await gql(app, tokenA, '{ members { id email } }');
    const emails = (data as { members: Array<{ email: string }> }).members.map((m) => m.email);

    expect(emails).toContain(t.a.userEmail);
    expect(emails).not.toContain(t.b.userEmail);
  });

  /**
   * Role checks live in the resolvers, not only in REST preHandlers, which do not run
   * here. Without this, GraphQL would be the more permissive of the two doors.
   */
  it('enforces roles inside resolvers, not only in REST middleware', async () => {
    const memberToken = await tokenFor(t.a, 'member');
    const { errors } = await gql(
      app,
      memberToken,
      'mutation { createProject(input: { key: "GQL", name: "Member attempt" }) { id } }',
    );
    expect(errors?.[0]?.message).toMatch(/requires the admin role/i);
  });

  /**
   * The schema is cyclic (Project.tasks -> Task.project -> ...), so without a depth limit
   * a short query can demand exponential work. On a pooled database one tenant doing that
   * degrades every other tenant, and rate limiting does not help because the cost is in a
   * single request.
   */
  it('rejects a query nested past the depth limit', async () => {
    const { errors } = await gql(app, tokenA, `{ projects { ${nestedSelection(6)} } }`);
    expect(errors?.[0]?.message).toMatch(/exceeds the maximum/i);
  });

  it('allows a query within the depth limit', async () => {
    // Guards the limiter from the opposite failure: one that rejects everything would
    // make the two tests above pass while breaking the API.
    const { errors, data } = await gql(app, tokenA, `{ projects { ${nestedSelection(2)} } }`);
    expect(errors).toBeUndefined();
    expect(data).not.toBeNull();
  });

  it('follows fragment spreads when measuring depth', async () => {
    // Hiding the deep part inside a fragment is the obvious bypass for a naive limiter.
    const { errors } = await gql(
      app,
      tokenA,
      `{ projects { ...deep } }
       fragment deep on Project { ${nestedSelection(6)} }`,
    );
    expect(errors?.[0]?.message).toMatch(/exceeds the maximum/i);
  });

  it('masks internal errors instead of leaking schema detail', async () => {
    const { errors } = await gql(app, tokenA, 'query($id: ID!) { task(id: $id) { id } }', {
      id: 'not-a-uuid',
    });

    const message = errors?.[0]?.message ?? '';
    // No constraint names, table names or SQL fragments.
    expect(message).not.toMatch(/tenant_isolation|pg_|SELECT|relation|invalid input syntax/i);
  });

  it('scopes correctly for tenant B, proving the fixture is populated on both sides', async () => {
    const tokenB = await tokenFor(t.b);
    const { data } = await gql(app, tokenB, '{ projects { id } }');
    const projects = (data as { projects: Array<{ id: string }> }).projects;

    expect(projects.map((p) => p.id)).toContain(t.b.projectId);
    expect(projects.map((p) => p.id)).not.toContain(t.a.projectId);
  });
});
