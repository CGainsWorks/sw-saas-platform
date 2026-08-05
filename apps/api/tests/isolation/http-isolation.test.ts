import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { closeRedis, redis } from '../../src/cache/redis.js';
import {
  bearer,
  closeApp,
  foreignlySignedToken,
  tamperTenantClaim,
  testApp,
  tokenFor,
} from '../helpers/app.js';
import { closeAdmin, dropTenants, seedTwoTenants, type TwoTenants } from '../helpers/fixtures.js';

/**
 * Cross-tenant attacks over HTTP, against the real application.
 *
 * These go through `buildApp()` — the same middleware stack, the same auth, the same
 * services, the same database as production. Nothing is stubbed. The database-level tests
 * prove RLS holds; these prove the layers above it do not hand an attacker a way around it.
 *
 * The attacker here holds a completely valid token for tenant A and knows tenant B's ids.
 */
describe('tenant isolation — HTTP', () => {
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

  /* ------------------------------------------------------ authentication */

  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/projects' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token signed with someone else\'s key', async () => {
    const forged = await foreignlySignedToken(t.b.tenantId, t.b.userId);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: bearer(forged),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token whose tenant claim was edited after signing', async () => {
    const tampered = tamperTenantClaim(tokenA, t.b.tenantId);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: bearer(tampered),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token with no tenant claim at all', async () => {
    const stripped = tamperTenantClaim(tokenA, '');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: bearer(stripped),
    });
    expect(res.statusCode).toBe(401);
  });

  /* --------------------------------------------------------- happy path */

  it('lets a tenant read its own data', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/projects', headers: bearer(tokenA) });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items.map((p) => p.id)).toContain(t.a.projectId);
    expect(body.items.map((p) => p.id)).not.toContain(t.b.projectId);
  });

  /* ------------------------------------------------------- cross-tenant */

  /**
   * 404 and not 403. A 403 would confirm the resource exists, which lets one customer
   * probe another's id space — how many projects they have, whether a given id is real.
   * From inside tenant A's view of the database the row genuinely does not exist, because
   * RLS removed it before the handler ran.
   */
  it('returns 404, not 403, for another tenant\'s project', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${t.b.projectId}`,
      headers: bearer(tokenA),
    });

    expect(res.statusCode).toBe(404);
    expect(res.statusCode).not.toBe(403);
  });

  it('returns 404 for another tenant\'s task', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${t.b.taskId}`,
      headers: bearer(tokenA),
    });
    expect(res.statusCode).toBe(404);
  });

  it('cannot modify another tenant\'s project', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${t.b.projectId}`,
      headers: bearer(tokenA),
      payload: { name: 'pwned' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('cannot delete another tenant\'s task', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/tasks/${t.b.taskId}`,
      headers: bearer(tokenA),
    });
    expect(res.statusCode).toBe(404);
  });

  it('cannot create a task inside another tenant\'s project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: bearer(tokenA),
      payload: { projectId: t.b.projectId, title: 'planted' },
    });
    // The composite FK rejects it; the service maps that to 404 rather than surfacing a
    // constraint name, which would confirm the project exists.
    expect(res.statusCode).toBe(404);
  });

  it('cannot comment on another tenant\'s task', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${t.b.taskId}/comments`,
      headers: bearer(tokenA),
      payload: { body: 'injected' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('cannot see another tenant\'s members', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/members', headers: bearer(tokenA) });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { items: Array<{ email: string }> };
    expect(body.items.map((m) => m.email)).toContain(t.a.userEmail);
    expect(body.items.map((m) => m.email)).not.toContain(t.b.userEmail);
  });

  /**
   * `X-Tenant-Id` is a very common convenience header in multi-tenant APIs, and it is a
   * straightforward account-takeover primitive whenever any code path trusts it. Nothing
   * in this application reads a tenant from anywhere except the verified token.
   */
  it('ignores an X-Tenant-Id header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { ...bearer(tokenA), 'x-tenant-id': t.b.tenantId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ tenantId: string }> };
    for (const project of body.items) expect(project.tenantId).toBe(t.a.tenantId);
  });

  it('ignores a tenantId supplied in a query string or body', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects?tenantId=${t.b.tenantId}`,
      headers: bearer(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ tenantId: string }> };
    for (const project of body.items) expect(project.tenantId).toBe(t.a.tenantId);
  });

  /* --------------------------------------------------------------- cache */

  /**
   * A cache hit skips the database, and therefore skips RLS. If two tenants could share a
   * key, everything the policies guarantee would be void for any cached read.
   */
  it('does not serve one tenant a cached response belonging to another', async () => {
    const tokenB = await tokenFor(t.b);

    // Prime the cache as A.
    const first = await app.inject({ method: 'GET', url: '/v1/projects', headers: bearer(tokenA) });
    expect(first.statusCode).toBe(200);

    // Confirm something really is cached, so this test is not passing vacuously.
    const keysA = await redis.keys(`t:${t.a.tenantId}:*`);
    expect(keysA.length).toBeGreaterThan(0);

    const second = await app.inject({ method: 'GET', url: '/v1/projects', headers: bearer(tokenB) });
    expect(second.statusCode).toBe(200);

    const body = second.json() as { items: Array<{ id: string; tenantId: string }> };
    expect(body.items.map((p) => p.id)).not.toContain(t.a.projectId);
    for (const project of body.items) expect(project.tenantId).toBe(t.b.tenantId);
  });

  /* ---------------------------------------------------------------- roles */

  it('enforces role within the tenant', async () => {
    const memberToken = await tokenFor(t.a, 'member');

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: bearer(memberToken),
      payload: { key: 'NEW', name: 'Member attempt' },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: bearer(await tokenFor(t.a, 'admin')),
      payload: { key: 'NEW', name: 'Admin attempt' },
    });
    expect(allowed.statusCode).toBe(201);
  });

  /**
   * Owning tenant A does not make you an owner anywhere else. Role and tenant travel
   * together in one signed token, so there is no way to pair "owner" with a tenant the
   * user does not own.
   */
  it('does not let an owner of one tenant act as owner of another', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${t.b.projectId}`,
      headers: bearer(tokenA), // owner — of tenant A
    });
    expect(res.statusCode).toBe(404);

    // And B's project is untouched.
    const stillThere = await app.inject({
      method: 'GET',
      url: `/v1/projects/${t.b.projectId}`,
      headers: bearer(await tokenFor(t.b)),
    });
    expect(stillThere.statusCode).toBe(200);
  });
});
