import type { InviteMemberInput, Membership, Role } from '@saas/shared-types';
import { withTenant, withTenantReadOnly, type TenantClient } from '../db/tenant-context.js';
import { badRequest, conflict, notFound } from '../http/errors.js';
import { findOrCreateUser } from './identity.js';
import { writeAudit } from './audit.js';

/**
 * Membership management, scoped to the caller's tenant.
 *
 * Note what is *not* possible here: there is no way to read or modify membership of any
 * tenant other than the one in the token, because `memberships` is RLS-protected and
 * every query runs inside `withTenant`. The login-time lookup that does cross tenants
 * goes through a single narrow SECURITY DEFINER function (migration 0003) and is
 * read-only.
 */

export interface MemberView {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

export async function listMembers(tenantId: string): Promise<MemberView[]> {
  return withTenantReadOnly(tenantId, async (tx) => {
    const { rows } = await tx.query<{
      membership_id: string;
      user_id: string;
      email: string;
      name: string;
      role: Role;
      created_at: string;
    }>(
      // The join to `users` is safe despite users having no RLS: the driving table is
      // `memberships`, which is policy-filtered, so only this tenant's users are reachable.
      `SELECT m.id AS membership_id, u.id AS user_id, u.email, u.name, m.role, m.created_at
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1
        ORDER BY u.name`,
      [tenantId],
    );

    return rows.map((r) => ({
      membershipId: r.membership_id,
      userId: r.user_id,
      email: r.email,
      name: r.name,
      role: r.role,
      createdAt: r.created_at,
    }));
  });
}

export async function inviteMember(
  tenantId: string,
  actorId: string,
  input: InviteMemberInput,
): Promise<MemberView> {
  const email = input.email.toLowerCase();
  // Creating the global user row happens outside the tenant transaction: `users` is not
  // tenant-scoped, and the address may already exist because they work for another
  // customer too.
  const userId = await findOrCreateUser(email, email.split('@')[0] ?? email);

  return withTenant(tenantId, async (tx) => {
    let rows: Array<{ id: string; created_at: string }>;
    try {
      ({ rows } = await tx.query<{ id: string; created_at: string }>(
        `INSERT INTO memberships (tenant_id, user_id, role)
              VALUES ($1, $2, $3)
           RETURNING id, created_at`,
        [tenantId, userId, input.role],
      ));
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'memberships_unique') {
        throw conflict('that person is already a member of this tenant');
      }
      throw err;
    }

    await writeAudit(tx, {
      actorId,
      action: 'member.invited',
      entityType: 'membership',
      entityId: rows[0]!.id,
      metadata: { role: input.role },
    });

    const { rows: userRows } = await tx.query<{ name: string }>(
      `SELECT name FROM users WHERE id = $1`,
      [userId],
    );

    return {
      membershipId: rows[0]!.id,
      userId,
      email,
      name: userRows[0]?.name ?? email,
      role: input.role,
      createdAt: rows[0]!.created_at,
    };
  });
}

export async function updateMemberRole(
  tenantId: string,
  actorId: string,
  userId: string,
  role: Role,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    if (role !== 'owner') await assertNotLastOwner(tx, tenantId, userId);

    const { rowCount } = await tx.query(
      `UPDATE memberships SET role = $3 WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId, role],
    );
    if (rowCount === 0) throw notFound('member');

    await writeAudit(tx, {
      actorId,
      action: 'member.role_changed',
      entityType: 'membership',
      entityId: userId,
      metadata: { role },
    });
  });
}

export async function removeMember(
  tenantId: string,
  actorId: string,
  userId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await assertNotLastOwner(tx, tenantId, userId);

    // tasks_assignee_fk is ON DELETE NO ACTION, so assignments must be cleared before the
    // membership row can go. Doing it inside the same transaction means a failure leaves
    // neither change applied.
    await tx.query(`UPDATE tasks SET assignee_id = NULL WHERE tenant_id = $1 AND assignee_id = $2`, [
      tenantId,
      userId,
    ]);

    const { rowCount } = await tx.query(
      `DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
    if (rowCount === 0) throw notFound('member');

    await writeAudit(tx, {
      actorId,
      action: 'member.removed',
      entityType: 'membership',
      entityId: userId,
    });
  });
}

/**
 * A tenant with no owner is unadministrable: nobody can invite, change roles, or delete
 * it, and recovering it needs operator intervention. Cheap to prevent, tedious to fix.
 */
async function assertNotLastOwner(
  tx: TenantClient,
  tenantId: string,
  userId: string,
): Promise<void> {
  const { rows } = await tx.query<{ is_owner: boolean; owner_count: number }>(
    `SELECT (SELECT role = 'owner' FROM memberships WHERE tenant_id = $1 AND user_id = $2) AS is_owner,
            (SELECT count(*)::int8 FROM memberships WHERE tenant_id = $1 AND role = 'owner') AS owner_count`,
    [tenantId, userId],
  );

  const row = rows[0];
  if (row?.is_owner && row.owner_count <= 1) {
    throw badRequest('cannot remove or demote the last owner of a tenant');
  }
}

export function toMembership(r: {
  id: string;
  tenant_id: string;
  user_id: string;
  role: Role;
  created_at: string;
}): Membership {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    role: r.role,
    createdAt: r.created_at,
  };
}
