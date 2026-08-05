import { GraphQLScalarType, Kind } from 'graphql';
import { ROLE_RANK, type Project, type Role, type Task } from '@saas/shared-types';
import { forbidden } from '../http/errors.js';
import { createProject, deleteProject, listProjects, updateProject } from '../services/projects.js';
import { createTask, deleteTask, listTasks, updateTask } from '../services/tasks.js';
import { addComment } from '../services/comments.js';
import { listMembers } from '../services/members.js';
import { membershipsForEmail } from '../services/identity.js';
import type { GraphQLContext } from './context.js';

/**
 * Resolvers.
 *
 * Every one of these delegates to the same service functions the REST routes call, with
 * `tenantId` taken from the verified token in context. No resolver builds SQL, and no
 * resolver accepts a tenant argument — the schema has no way to express one.
 *
 * Role checks are applied here rather than relying on the REST layer's `requireRole`
 * preHandlers, which do not run for GraphQL. That asymmetry is a classic way for a
 * GraphQL endpoint to end up more permissive than the REST API it sits beside.
 */

const DateTime = new GraphQLScalarType({
  name: 'DateTime',
  description: 'ISO 8601 timestamp in UTC',
  serialize: (v) => (v instanceof Date ? v.toISOString() : String(v)),
  parseValue: (v) => {
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
      throw new TypeError('DateTime must be an ISO 8601 string');
    }
    return v;
  },
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.STRING || Number.isNaN(Date.parse(ast.value))) {
      throw new TypeError('DateTime must be an ISO 8601 string');
    }
    return ast.value;
  },
});

function assertRole(ctx: GraphQLContext, minimum: Role): void {
  if (ROLE_RANK[ctx.auth.role] < ROLE_RANK[minimum]) {
    throw forbidden(`this action requires the ${minimum} role or higher`);
  }
}

export const resolvers = {
  DateTime,

  Query: {
    async me(_p: unknown, _a: unknown, ctx: GraphQLContext) {
      const memberships = await membershipsForEmail(ctx.auth.email);
      const current = memberships.find((m) => m.tenantId === ctx.auth.tenantId);
      if (!current) throw forbidden('your membership of this tenant is no longer active');

      return {
        user: {
          id: current.userId,
          email: ctx.auth.email,
          name: current.userName,
          role: current.role,
        },
        tenant: {
          id: current.tenantId,
          slug: current.tenantSlug,
          name: current.tenantName,
          plan: current.tenantPlan,
        },
        role: current.role,
        availableTenants: memberships.map((m) => ({
          id: m.tenantId,
          slug: m.tenantSlug,
          name: m.tenantName,
          plan: m.tenantPlan,
        })),
      };
    },

    projects(_p: unknown, args: { includeArchived?: boolean }, ctx: GraphQLContext) {
      return listProjects(ctx.auth.tenantId, { includeArchived: args.includeArchived ?? false });
    },

    async project(_p: unknown, args: { id: string }, ctx: GraphQLContext) {
      // Returns null rather than throwing for a foreign id: the field is nullable, and a
      // null is exactly what a caller in this tenant should observe.
      return ctx.loaders.projectById.load(args.id);
    },

    tasks(
      _p: unknown,
      args: { projectId?: string; status?: Task['status']; assigneeId?: string; limit?: number; cursor?: string },
      ctx: GraphQLContext,
    ) {
      return listTasks(ctx.auth.tenantId, {
        projectId: args.projectId,
        status: args.status,
        assigneeId: args.assigneeId,
        limit: Math.min(args.limit ?? 25, 100),
        cursor: args.cursor,
      });
    },

    task(_p: unknown, args: { id: string }, ctx: GraphQLContext) {
      return ctx.loaders.taskById.load(args.id);
    },

    members(_p: unknown, _a: unknown, ctx: GraphQLContext) {
      return listMembers(ctx.auth.tenantId).then((ms) =>
        ms.map((m) => ({ id: m.userId, email: m.email, name: m.name, role: m.role })),
      );
    },
  },

  Mutation: {
    createProject(
      _p: unknown,
      args: { input: { key: string; name: string; description?: string | null } },
      ctx: GraphQLContext,
    ) {
      assertRole(ctx, 'admin');
      return createProject(ctx.auth.tenantId, ctx.auth.userId, args.input);
    },

    updateProject(
      _p: unknown,
      args: { id: string; input: { name?: string; description?: string | null; archived?: boolean } },
      ctx: GraphQLContext,
    ) {
      assertRole(ctx, 'admin');
      return updateProject(ctx.auth.tenantId, ctx.auth.userId, args.id, args.input);
    },

    async deleteProject(_p: unknown, args: { id: string }, ctx: GraphQLContext) {
      assertRole(ctx, 'owner');
      await deleteProject(ctx.auth.tenantId, ctx.auth.userId, args.id);
      return true;
    },

    createTask(_p: unknown, args: { input: Parameters<typeof createTask>[2] }, ctx: GraphQLContext) {
      return createTask(ctx.auth.tenantId, ctx.auth.userId, args.input);
    },

    updateTask(
      _p: unknown,
      args: { id: string; input: Parameters<typeof updateTask>[3] },
      ctx: GraphQLContext,
    ) {
      return updateTask(ctx.auth.tenantId, ctx.auth.userId, args.id, args.input);
    },

    async deleteTask(_p: unknown, args: { id: string }, ctx: GraphQLContext) {
      assertRole(ctx, 'admin');
      await deleteTask(ctx.auth.tenantId, ctx.auth.userId, args.id);
      return true;
    },

    addComment(_p: unknown, args: { taskId: string; body: string }, ctx: GraphQLContext) {
      return addComment(ctx.auth.tenantId, ctx.auth.userId, args.taskId, { body: args.body });
    },
  },

  /* ------------------------------------------------------ nested fields */

  Project: {
    tasks(parent: Project, _a: unknown, ctx: GraphQLContext) {
      return ctx.loaders.tasksByProject.load(parent.id);
    },
    async taskCount(parent: Project, _a: unknown, ctx: GraphQLContext) {
      const tasks = await ctx.loaders.tasksByProject.load(parent.id);
      return tasks.length;
    },
  },

  Task: {
    project(parent: Task, _a: unknown, ctx: GraphQLContext) {
      return ctx.loaders.projectById.load(parent.projectId);
    },
    assignee(parent: Task, _a: unknown, ctx: GraphQLContext) {
      if (!parent.assigneeId) return null;
      return ctx.loaders.memberById.load(parent.assigneeId).then(
        (m) => m && { id: m.userId, email: m.email, name: m.name, role: m.role },
      );
    },
    comments(parent: Task, _a: unknown, ctx: GraphQLContext) {
      return ctx.loaders.commentsByTask.load(parent.id);
    },
  },

  Comment: {
    author(parent: { authorId: string }, _a: unknown, ctx: GraphQLContext) {
      if (!parent.authorId) return null;
      return ctx.loaders.memberById.load(parent.authorId).then(
        (m) => m && { id: m.userId, email: m.email, name: m.name, role: m.role },
      );
    },
  },
};
