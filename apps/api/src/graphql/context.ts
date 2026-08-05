import DataLoader from 'dataloader';
import type { Comment, Task } from '@saas/shared-types';
import { withTenantReadOnly } from '../db/tenant-context.js';
import { getCommentsForTasksIn } from '../services/comments.js';
import { getTasksByIdsIn, getTasksForProjectsIn } from '../services/tasks.js';
import { getProjectIn } from '../services/projects.js';
import { listMembers, type MemberView } from '../services/members.js';
import type { AuthContext } from '../auth/middleware.js';

/**
 * Per-request GraphQL context.
 *
 * TRANSACTION STRATEGY, and the trade-off it makes.
 *
 * Each DataLoader batch opens its own short `withTenantReadOnly` transaction rather than
 * the whole operation sharing one. That costs a BEGIN/COMMIT per batch and gives up
 * read-consistency *across* levels of the query — projects could be read, then a task
 * created by another request, then tasks read, and the response would reflect both.
 *
 * What it buys is that `withTenant` remains the only way to reach the database. The
 * alternative — a transaction opened at the start of the operation and threaded through
 * context — needs a connection held across the whole resolver tree, plus a second
 * lifecycle primitive that begins and commits outside the callback. That is a second
 * escape hatch, and every escape hatch is somewhere isolation can be got wrong later.
 *
 * For this workload the consistency loss is not observable to users, and the isolation
 * property is worth more. If a future feature genuinely needs a consistent snapshot
 * across levels, the honest fix is a REPEATABLE READ transaction for the operation, and
 * it should be added as a documented variant rather than by loosening the chokepoint.
 *
 * The loaders themselves are what stop the N+1: fetching 50 tasks and their comments is
 * two queries, not 51.
 */
export interface GraphQLContext {
  auth: AuthContext;
  loaders: Loaders;
}

export interface Loaders {
  tasksByProject: DataLoader<string, Task[]>;
  commentsByTask: DataLoader<string, Comment[]>;
  taskById: DataLoader<string, Task | null>;
  projectById: DataLoader<string, unknown>;
  memberById: DataLoader<string, MemberView | null>;
}

/** Groups a flat batch result back into per-key arrays, preserving the requested order. */
function groupBy<T>(items: T[], keys: readonly string[], keyOf: (item: T) => string): T[][] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = keyOf(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return keys.map((k) => map.get(k) ?? []);
}

export function createLoaders(tenantId: string): Loaders {
  return {
    tasksByProject: new DataLoader(async (projectIds) =>
      withTenantReadOnly(tenantId, async (tx) => {
        const tasks = await getTasksForProjectsIn(tx, projectIds);
        return groupBy(tasks, projectIds, (t) => t.projectId);
      }),
    ),

    commentsByTask: new DataLoader(async (taskIds) =>
      withTenantReadOnly(tenantId, async (tx) => {
        const comments = await getCommentsForTasksIn(tx, taskIds);
        return groupBy(comments, taskIds, (c) => c.taskId);
      }),
    ),

    taskById: new DataLoader(async (ids) =>
      withTenantReadOnly(tenantId, async (tx) => {
        const tasks = await getTasksByIdsIn(tx, ids);
        const byId = new Map(tasks.map((t) => [t.id, t]));
        // A miss here is indistinguishable from "belongs to another tenant", which is the
        // intended behaviour — RLS removed the row before the query returned.
        return ids.map((id) => byId.get(id) ?? null);
      }),
    ),

    projectById: new DataLoader(async (ids) =>
      withTenantReadOnly(tenantId, async (tx) => {
        const results = await Promise.all(ids.map((id) => getProjectIn(tx, id)));
        return results;
      }),
    ),

    memberById: new DataLoader(async (ids) => {
      // Membership lists are small and already tenant-scoped; one query serves the batch.
      const members = await listMembers(tenantId);
      const byId = new Map(members.map((m) => [m.userId, m]));
      return ids.map((id) => byId.get(id) ?? null);
    }),
  };
}

export function createContext(auth: AuthContext): GraphQLContext {
  return { auth, loaders: createLoaders(auth.tenantId) };
}
