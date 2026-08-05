import { randomBytes } from 'node:crypto';
import type { Role } from '@saas/shared-types';
import { pool } from '../db/pool.js';
import { withProvisioningTransaction } from '../db/tenant-context.js';
import { logger } from '../logger.js';

/**
 * Identity and tenant provisioning: the code that runs between "the provider says this
 * is alice@acme.test" and "here is an access token scoped to tenant X".
 *
 * This is the only part of the system that legitimately operates without a tenant
 * context, because determining the tenant is its job.
 */

export interface MembershipRow {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantPlan: string;
  userId: string;
  userName: string;
  role: Role;
}

/**
 * Every tenant this email may act in.
 *
 * Goes through the SECURITY DEFINER function from migration 0003 — the single sanctioned
 * way to read membership with no tenant context. `users` and `tenants` are not
 * RLS-protected, but `memberships` is, and joining to it is the whole point.
 *
 * Critically, this is a **database lookup keyed on a verified email**, not a claim the
 * client made. A client can ask to log in as anyone; it cannot make the database agree.
 */
export async function membershipsForEmail(email: string): Promise<MembershipRow[]> {
  const { rows } = await pool.query<{
    tenant_id: string;
    tenant_slug: string;
    tenant_name: string;
    tenant_plan: string;
    user_id: string;
    user_name: string;
    role: Role;
  }>('SELECT * FROM auth_memberships_for_email($1)', [email]);

  return rows.map((r) => ({
    tenantId: r.tenant_id,
    tenantSlug: r.tenant_slug,
    tenantName: r.tenant_name,
    tenantPlan: r.tenant_plan,
    userId: r.user_id,
    userName: r.user_name,
    role: r.role,
  }));
}

/**
 * Upserts the global user identity.
 *
 * `users` carries no tenant_id and no RLS policy — a person is one row regardless of how
 * many customers they work for. ON CONFLICT against the case-insensitive unique index
 * makes concurrent first-logins from the same address idempotent rather than a race.
 */
export async function findOrCreateUser(email: string, name: string): Promise<string> {
  const normalised = email.toLowerCase();

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name)
          VALUES ($1, $2)
     ON CONFLICT (lower(email))
     DO UPDATE SET name = COALESCE(NULLIF(EXCLUDED.name, ''), users.name)
       RETURNING id`,
    [normalised, name],
  );

  return rows[0]!.id;
}

function slugFor(email: string): string {
  const local = email.split('@')[0] ?? 'tenant';
  const base = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 20);
  const suffix = randomBytes(3).toString('hex');
  // The CHECK constraint requires: starts with a letter, ends alphanumeric, 3-40 chars.
  return `${base.length >= 2 ? base : 'workspace'}-${suffix}`;
}

export interface ProvisionResult {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantPlan: string;
  userId: string;
  role: Role;
}

/**
 * Self-serve signup: a verified identity with no existing membership gets its own tenant
 * and becomes its owner.
 *
 * Uses `withProvisioningTransaction` — the deliberately conspicuous primitive that starts
 * with no tenant context and adopts one part-way. The ordering is forced: the tenant row
 * must exist before there is an id to scope by, and the membership INSERT must happen
 * *after* `setTenant`, because `memberships` is RLS-protected and its WITH CHECK clause
 * would otherwise reject the row.
 *
 * Note this grants no extra database privilege — the connection is still `app_user`.
 * Before `setTenant` is called, every RLS-protected table accepts and returns nothing.
 */
export async function provisionTenantForUser(input: {
  userId: string;
  email: string;
  name: string;
  tenantName?: string;
}): Promise<ProvisionResult> {
  return withProvisioningTransaction(async (tx) => {
    const slug = slugFor(input.email);
    const name = input.tenantName ?? `${input.name}'s workspace`;

    const { rows: tenantRows } = await tx.query<{
      id: string;
      slug: string;
      name: string;
      plan: string;
    }>(
      `INSERT INTO tenants (slug, name, plan) VALUES ($1, $2, 'free')
       RETURNING id, slug, name, plan`,
      [slug, name],
    );
    const tenant = tenantRows[0]!;

    // From here on the transaction is scoped, and the membership INSERT satisfies the
    // tenant_isolation WITH CHECK clause.
    await tx.setTenant(tenant.id);

    await tx.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [tenant.id, input.userId],
    );

    await tx.query(
      `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'tenant.provisioned', 'tenant', $1, $3)`,
      [tenant.id, input.userId, JSON.stringify({ via: 'self-serve-signup' })],
    );

    logger.info({ tenantId: tenant.id, slug: tenant.slug }, 'provisioned new tenant');

    return {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
      tenantPlan: tenant.plan,
      userId: input.userId,
      role: 'owner' as Role,
    };
  });
}

/**
 * Resolves the identity from the provider into a concrete tenant to issue a token for.
 *
 * `requestedTenantId` is client-supplied and therefore treated as a *request*, not an
 * instruction: it is only honoured if it appears in the membership list the database
 * returned. An unrecognised value falls back to the first membership rather than
 * erroring, so a stale bookmark degrades to a working session instead of a dead end.
 */
export async function resolveSession(input: {
  email: string;
  name: string;
  requestedTenantId?: string;
}): Promise<{ selected: MembershipRow; all: MembershipRow[]; provisioned: boolean }> {
  const userId = await findOrCreateUser(input.email, input.name);

  let memberships = await membershipsForEmail(input.email);
  let provisioned = false;

  if (memberships.length === 0) {
    const created = await provisionTenantForUser({
      userId,
      email: input.email,
      name: input.name,
    });
    provisioned = true;
    memberships = [
      {
        tenantId: created.tenantId,
        tenantSlug: created.tenantSlug,
        tenantName: created.tenantName,
        tenantPlan: created.tenantPlan,
        userId: created.userId,
        userName: input.name,
        role: created.role,
      },
    ];
  }

  const requested = input.requestedTenantId
    ? memberships.find((m) => m.tenantId === input.requestedTenantId)
    : undefined;

  return { selected: requested ?? memberships[0]!, all: memberships, provisioned };
}

/**
 * Membership check for tenant switching.
 *
 * Re-queries the database rather than trusting anything in the current token. A token
 * proves the user was a member of tenant A when it was issued; it says nothing about
 * tenant B, and it does not prove the membership still exists — access revoked five
 * minutes ago must not be switchable back into.
 */
export async function assertMembership(
  email: string,
  tenantId: string,
): Promise<MembershipRow | null> {
  const memberships = await membershipsForEmail(email);
  return memberships.find((m) => m.tenantId === tenantId) ?? null;
}
