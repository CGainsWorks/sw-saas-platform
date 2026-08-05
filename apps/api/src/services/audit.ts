import type { TenantClient } from '../db/tenant-context.js';

/**
 * Appends to the per-tenant audit trail.
 *
 * Takes an existing `TenantClient` rather than opening its own transaction, so the audit
 * row commits or rolls back with the change it describes. An audit trail that can record
 * an action which never happened — or miss one that did — is worse than none, because it
 * is trusted.
 *
 * `audit_log` is append-only at the privilege level: app_user has SELECT and INSERT but
 * no UPDATE or DELETE (migration 0002). An application that can rewrite its own audit
 * trail does not have one.
 */
export async function writeAudit(
  tx: TenantClient,
  entry: {
    actorId: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      tx.tenantId,
      entry.actorId,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}
