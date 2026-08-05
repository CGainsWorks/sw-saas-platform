import { z } from 'zod';
import { PrioritySchema, RoleSchema, TaskStatusSchema, UuidSchema } from './domain.js';

/* ------------------------------------------------------------------ projects */

export const CreateProjectSchema = z.object({
  key: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Z][A-Z0-9]*$/, 'key must be upper-case alphanumeric, starting with a letter'),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullish(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;

/* --------------------------------------------------------------------- tasks */

export const CreateTaskSchema = z.object({
  projectId: UuidSchema,
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).nullish(),
  status: TaskStatusSchema.default('todo'),
  priority: PrioritySchema.default('medium'),
  assigneeId: UuidSchema.nullish(),
  dueAt: z.string().datetime().nullish(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

export const UpdateTaskSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(10_000).nullish(),
    status: TaskStatusSchema.optional(),
    priority: PrioritySchema.optional(),
    assigneeId: UuidSchema.nullish(),
    dueAt: z.string().datetime().nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

export const ListTasksQuerySchema = z.object({
  projectId: UuidSchema.optional(),
  status: TaskStatusSchema.optional(),
  assigneeId: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>;

/* ------------------------------------------------------------------ comments */

export const CreateCommentSchema = z.object({
  body: z.string().min(1).max(10_000),
});
export type CreateCommentInput = z.infer<typeof CreateCommentSchema>;

/* --------------------------------------------------------------- memberships */

export const InviteMemberSchema = z.object({
  email: z.string().email().max(320),
  role: RoleSchema.default('member'),
});
export type InviteMemberInput = z.infer<typeof InviteMemberSchema>;

export const UpdateMemberRoleSchema = z.object({ role: RoleSchema });
export type UpdateMemberRoleInput = z.infer<typeof UpdateMemberRoleSchema>;

/* ---------------------------------------------------------------------- auth */

export const SwitchTenantSchema = z.object({ tenantId: UuidSchema });
export type SwitchTenantInput = z.infer<typeof SwitchTenantSchema>;

export const RefreshSchema = z.object({ refreshToken: z.string().min(1) });
export type RefreshInput = z.infer<typeof RefreshSchema>;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface SessionInfo {
  user: { id: string; email: string; name: string };
  tenant: { id: string; slug: string; name: string; plan: string };
  role: string;
  /** Every tenant this user may switch into. Derived from the database, never from the client. */
  availableTenants: Array<{ id: string; slug: string; name: string; role: string }>;
}

/* -------------------------------------------------------------- pagination */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
