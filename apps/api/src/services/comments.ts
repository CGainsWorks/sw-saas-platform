import type { Comment, CreateCommentInput } from '@saas/shared-types';
import { withTenant, withTenantReadOnly, type TenantClient } from '../db/tenant-context.js';
import { notFound } from '../http/errors.js';
import { writeAudit } from './audit.js';

interface CommentRow {
  id: string;
  tenant_id: string;
  task_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
}

function toComment(r: CommentRow): Comment {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    taskId: r.task_id,
    authorId: r.author_id ?? '',
    body: r.body,
    createdAt: r.created_at,
  };
}

const COLUMNS = `id, tenant_id, task_id, author_id, body, created_at`;

export async function listComments(tenantId: string, taskId: string): Promise<Comment[]> {
  return withTenantReadOnly(tenantId, async (tx) => {
    const { rows } = await tx.query<CommentRow>(
      `SELECT ${COLUMNS} FROM comments
        WHERE tenant_id = $1 AND task_id = $2
        ORDER BY created_at ASC`,
      [tenantId, taskId],
    );
    return rows.map(toComment);
  });
}

/** Batch load for GraphQL, avoiding an N+1 across a task list. */
export async function getCommentsForTasksIn(
  tx: TenantClient,
  taskIds: readonly string[],
): Promise<Comment[]> {
  const { rows } = await tx.query<CommentRow>(
    `SELECT ${COLUMNS} FROM comments
      WHERE tenant_id = $1 AND task_id = ANY($2::uuid[])
      ORDER BY created_at ASC`,
    [tx.tenantId, taskIds as string[]],
  );
  return rows.map(toComment);
}

export async function addComment(
  tenantId: string,
  actorId: string,
  taskId: string,
  input: CreateCommentInput,
): Promise<Comment> {
  return withTenant(tenantId, async (tx) => {
    let rows: CommentRow[];
    try {
      ({ rows } = await tx.query<CommentRow>(
        `INSERT INTO comments (tenant_id, task_id, author_id, body)
              VALUES ($1, $2, $3, $4)
           RETURNING ${COLUMNS}`,
        [tenantId, taskId, actorId, input.body],
      ));
    } catch (err) {
      // The composite FK (tenant_id, task_id) rejects a comment on another tenant's task.
      // Surfaced as 404 so it does not confirm the task exists elsewhere.
      if ((err as { constraint?: string }).constraint === 'comments_task_fk') throw notFound('task');
      throw err;
    }

    const comment = toComment(rows[0]!);
    await writeAudit(tx, {
      actorId,
      action: 'comment.created',
      entityType: 'comment',
      entityId: comment.id,
      metadata: { taskId },
    });
    return comment;
  });
}
