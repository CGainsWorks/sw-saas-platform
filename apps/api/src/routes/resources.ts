import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateCommentSchema,
  CreateProjectSchema,
  CreateTaskSchema,
  InviteMemberSchema,
  ListTasksQuerySchema,
  UpdateMemberRoleSchema,
  UpdateProjectSchema,
  UpdateTaskSchema,
} from '@saas/shared-types';
import { authOf, requireAuth, requireRole } from '../auth/middleware.js';
import { badRequest } from '../http/errors.js';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from '../services/projects.js';
import { createTask, deleteTask, getTask, listTasks, updateTask } from '../services/tasks.js';
import { addComment, listComments } from '../services/comments.js';
import { inviteMember, listMembers, removeMember, updateMemberRole } from '../services/members.js';

/**
 * REST surface.
 *
 * Every handler follows the same three steps: validate the input, take `tenantId` from
 * the verified token, call a service that cannot reach the database without it. No
 * handler reads a tenant from a header, a path segment or a body field — the tenant is
 * not part of the addressable API surface at all, which is what makes tenant confusion
 * impossible to introduce by editing a route.
 *
 * Resource ids are bare UUIDs rather than tenant-qualified paths (`/v1/tenants/:tid/...`).
 * A tenant-in-path design invites exactly the bug this architecture is built to prevent:
 * it puts an attacker-controlled tenant id in front of every query, and correctness then
 * depends on remembering to check it against the token on every single route.
 */

const IdParams = z.object({ id: z.string().uuid() });
const TaskIdParams = z.object({ taskId: z.string().uuid() });
const UserIdParams = z.object({ userId: z.string().uuid() });

// Generic over the schema rather than over its output type: `z.ZodType<T>` lets TS infer
// T from the schema's *input* side, which drops `.default()`s and makes defaulted fields
// look optional to the caller.
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(
      'request failed validation',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export async function resourceRoutes(app: FastifyInstance): Promise<void> {
  // Applied to every route in this plugin scope. A new route added below is authenticated
  // by default — the safe thing requires no action, and opting out would be conspicuous.
  app.addHook('preHandler', requireAuth);

  /* ------------------------------------------------------------ projects */

  app.get('/v1/projects', async (req) => {
    const auth = authOf(req);
    const q = parse(z.object({ includeArchived: z.coerce.boolean().default(false) }), req.query);
    return { items: await listProjects(auth.tenantId, q) };
  });

  app.get('/v1/projects/:id', async (req) => {
    const auth = authOf(req);
    const { id } = parse(IdParams, req.params);
    return getProject(auth.tenantId, id);
  });

  app.post('/v1/projects', { preHandler: requireRole('admin') }, async (req, reply) => {
    const auth = authOf(req);
    const body = parse(CreateProjectSchema, req.body);
    const project = await createProject(auth.tenantId, auth.userId, body);
    return reply.status(201).send(project);
  });

  app.patch('/v1/projects/:id', { preHandler: requireRole('admin') }, async (req) => {
    const auth = authOf(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(UpdateProjectSchema, req.body);
    return updateProject(auth.tenantId, auth.userId, id, body);
  });

  app.delete('/v1/projects/:id', { preHandler: requireRole('owner') }, async (req, reply) => {
    const auth = authOf(req);
    const { id } = parse(IdParams, req.params);
    await deleteProject(auth.tenantId, auth.userId, id);
    return reply.status(204).send();
  });

  /* --------------------------------------------------------------- tasks */

  app.get('/v1/tasks', async (req) => {
    const auth = authOf(req);
    const query = parse(ListTasksQuerySchema, req.query);
    return listTasks(auth.tenantId, query);
  });

  app.get('/v1/tasks/:id', async (req) => {
    const auth = authOf(req);
    const { id } = parse(IdParams, req.params);
    return getTask(auth.tenantId, id);
  });

  app.post('/v1/tasks', async (req, reply) => {
    const auth = authOf(req);
    const body = parse(CreateTaskSchema, req.body);
    const task = await createTask(auth.tenantId, auth.userId, body);
    return reply.status(201).send(task);
  });

  app.patch('/v1/tasks/:id', async (req) => {
    const auth = authOf(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(UpdateTaskSchema, req.body);
    return updateTask(auth.tenantId, auth.userId, id, body);
  });

  app.delete('/v1/tasks/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const auth = authOf(req);
    const { id } = parse(IdParams, req.params);
    await deleteTask(auth.tenantId, auth.userId, id);
    return reply.status(204).send();
  });

  /* ------------------------------------------------------------ comments */

  app.get('/v1/tasks/:taskId/comments', async (req) => {
    const auth = authOf(req);
    const { taskId } = parse(TaskIdParams, req.params);
    return { items: await listComments(auth.tenantId, taskId) };
  });

  app.post('/v1/tasks/:taskId/comments', async (req, reply) => {
    const auth = authOf(req);
    const { taskId } = parse(TaskIdParams, req.params);
    const body = parse(CreateCommentSchema, req.body);
    const comment = await addComment(auth.tenantId, auth.userId, taskId, body);
    return reply.status(201).send(comment);
  });

  /* ------------------------------------------------------------- members */

  app.get('/v1/members', async (req) => {
    const auth = authOf(req);
    return { items: await listMembers(auth.tenantId) };
  });

  app.post('/v1/members', { preHandler: requireRole('admin') }, async (req, reply) => {
    const auth = authOf(req);
    const body = parse(InviteMemberSchema, req.body);
    const member = await inviteMember(auth.tenantId, auth.userId, body);
    return reply.status(201).send(member);
  });

  app.patch('/v1/members/:userId', { preHandler: requireRole('owner') }, async (req, reply) => {
    const auth = authOf(req);
    const { userId } = parse(UserIdParams, req.params);
    const { role } = parse(UpdateMemberRoleSchema, req.body);
    await updateMemberRole(auth.tenantId, auth.userId, userId, role);
    return reply.status(204).send();
  });

  app.delete('/v1/members/:userId', { preHandler: requireRole('owner') }, async (req, reply) => {
    const auth = authOf(req);
    const { userId } = parse(UserIdParams, req.params);
    await removeMember(auth.tenantId, auth.userId, userId);
    return reply.status(204).send();
  });
}
