import type {
  CreateTaskInput,
  ListTasksQuery,
  Page,
  Task,
  UpdateTaskInput,
} from '@saas/shared-types';
import { withTenant, withTenantReadOnly, type TenantClient } from '../db/tenant-context.js';
import { badRequest, notFound } from '../http/errors.js';
import { writeAudit } from './audit.js';

interface TaskRow {
  id: string;
  tenant_id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: Task['status'];
  priority: Task['priority'];
  assignee_id: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
}

function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    projectId: r.project_id,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    assigneeId: r.assignee_id,
    dueAt: r.due_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = `id, tenant_id, project_id, title, description, status, priority,
                 assignee_id, due_at, created_at, updated_at`;

/**
 * Keyset (not OFFSET) pagination.
 *
 * OFFSET makes the database walk and discard every skipped row, so page 500 costs 500
 * pages of work, and rows shift under the reader when data changes mid-scroll. A cursor
 * on (created_at, id) is stable and costs the same for every page.
 *
 * The cursor is opaque to clients but not secret — it encodes only a timestamp and an id
 * the caller has already seen. It is still validated on the way back in, and the values
 * are used as bind parameters, so a forged cursor is either a 400 or simply a different
 * (still tenant-scoped) starting point. It cannot widen the result set beyond the tenant,
 * because RLS is applied regardless of where the scan starts.
 */
function encodeCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(`${row.created_at}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) {
    throw badRequest('malformed cursor');
  }
  return { createdAt, id };
}

export async function listTasks(tenantId: string, query: ListTasksQuery): Promise<Page<Task>> {
  return withTenantReadOnly(tenantId, async (tx) => {
    const after = query.cursor ? decodeCursor(query.cursor) : null;

    // Fetch one extra row to determine whether a further page exists, without a second
    // COUNT query.
    const { rows } = await tx.query<TaskRow>(
      `SELECT ${COLUMNS}
         FROM tasks
        WHERE tenant_id = $1
          AND ($2::uuid IS NULL OR project_id  = $2)
          AND ($3::text IS NULL OR status      = $3)
          AND ($4::uuid IS NULL OR assignee_id = $4)
          AND ($5::timestamptz IS NULL OR (created_at, id) < ($5, $6))
        ORDER BY created_at DESC, id DESC
        LIMIT $7`,
      [
        tenantId,
        query.projectId ?? null,
        query.status ?? null,
        query.assigneeId ?? null,
        after?.createdAt ?? null,
        after?.id ?? null,
        query.limit + 1,
      ],
    );

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(toTask),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  });
}

export async function getTask(tenantId: string, id: string): Promise<Task> {
  return withTenantReadOnly(tenantId, async (tx) => {
    const { rows } = await tx.query<TaskRow>(
      `SELECT ${COLUMNS} FROM tasks WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    if (!rows[0]) throw notFound('task');
    return toTask(rows[0]);
  });
}

/** Batch load for GraphQL's DataLoader. `= ANY($2)` is one round trip for N ids. */
export async function getTasksByIdsIn(tx: TenantClient, ids: readonly string[]): Promise<Task[]> {
  const { rows } = await tx.query<TaskRow>(
    `SELECT ${COLUMNS} FROM tasks WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tx.tenantId, ids as string[]],
  );
  return rows.map(toTask);
}

export async function getTasksForProjectsIn(
  tx: TenantClient,
  projectIds: readonly string[],
): Promise<Task[]> {
  const { rows } = await tx.query<TaskRow>(
    `SELECT ${COLUMNS} FROM tasks
      WHERE tenant_id = $1 AND project_id = ANY($2::uuid[])
      ORDER BY created_at DESC`,
    [tx.tenantId, projectIds as string[]],
  );
  return rows.map(toTask);
}

/**
 * Constraint violations are translated into 404, not 400 or 409.
 *
 * If `projectId` names a project in another tenant, the composite FK rejects the insert.
 * Reporting that as "foreign key violation" would confirm the project exists somewhere —
 * so from the caller's point of view the project simply is not found, which is what a
 * caller in this tenant should see.
 */
function translateWriteError(err: unknown): never {
  const constraint = (err as { constraint?: string }).constraint;
  if (constraint === 'tasks_project_fk') throw notFound('project');
  if (constraint === 'tasks_assignee_fk') {
    throw badRequest('assignee is not a member of this tenant');
  }
  throw err;
}

export async function createTask(
  tenantId: string,
  actorId: string,
  input: CreateTaskInput,
): Promise<Task> {
  return withTenant(tenantId, async (tx) => {
    let rows: TaskRow[];
    try {
      ({ rows } = await tx.query<TaskRow>(
        `INSERT INTO tasks (tenant_id, project_id, title, description, status, priority, assignee_id, due_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${COLUMNS}`,
        [
          tenantId,
          input.projectId,
          input.title,
          input.description ?? null,
          input.status,
          input.priority,
          input.assigneeId ?? null,
          input.dueAt ?? null,
        ],
      ));
    } catch (err) {
      translateWriteError(err);
    }

    const task = toTask(rows[0]!);
    await writeAudit(tx, {
      actorId,
      action: 'task.created',
      entityType: 'task',
      entityId: task.id,
      metadata: { projectId: task.projectId, priority: task.priority },
    });
    return task;
  });
}

export async function updateTask(
  tenantId: string,
  actorId: string,
  id: string,
  input: UpdateTaskInput,
): Promise<Task> {
  return withTenant(tenantId, async (tx) => {
    let rows: TaskRow[];
    try {
      ({ rows } = await tx.query<TaskRow>(
        `UPDATE tasks
            SET title       = COALESCE($3, title),
                description = CASE WHEN $4::boolean THEN $5  ELSE description END,
                status      = COALESCE($6, status),
                priority    = COALESCE($7, priority),
                assignee_id = CASE WHEN $8::boolean THEN $9  ELSE assignee_id END,
                due_at      = CASE WHEN $10::boolean THEN $11 ELSE due_at END
          WHERE tenant_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
        [
          tenantId,
          id,
          input.title ?? null,
          input.description !== undefined,
          input.description ?? null,
          input.status ?? null,
          input.priority ?? null,
          input.assigneeId !== undefined,
          input.assigneeId ?? null,
          input.dueAt !== undefined,
          input.dueAt ?? null,
        ],
      ));
    } catch (err) {
      translateWriteError(err);
    }

    if (!rows[0]) throw notFound('task');

    const task = toTask(rows[0]);
    await writeAudit(tx, {
      actorId,
      action: 'task.updated',
      entityType: 'task',
      entityId: id,
      metadata: { fields: Object.keys(input) },
    });
    return task;
  });
}

export async function deleteTask(tenantId: string, actorId: string, id: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const { rowCount } = await tx.query(`DELETE FROM tasks WHERE tenant_id = $1 AND id = $2`, [
      tenantId,
      id,
    ]);
    // An UPDATE or DELETE aimed at another tenant's row affects zero rows rather than
    // raising — RLS removes it from the scan, so there is nothing to delete.
    if (rowCount === 0) throw notFound('task');

    await writeAudit(tx, { actorId, action: 'task.deleted', entityType: 'task', entityId: id });
  });
}
