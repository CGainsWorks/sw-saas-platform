import { z } from 'zod';

/** Role a user holds *within a single tenant*. A user may hold different roles in different tenants. */
export const RoleSchema = z.enum(['owner', 'admin', 'member']);
export type Role = z.infer<typeof RoleSchema>;

/** Ordering used for permission checks: owner outranks admin outranks member. */
export const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 };

export const PlanSchema = z.enum(['free', 'pro', 'enterprise']);
export type Plan = z.infer<typeof PlanSchema>;

/**
 * Tenancy model for a single tenant. See docs/multi_tenancy.md §7.
 * `silo` is schema-supported but not exercised in the demo.
 */
export const IsolationModelSchema = z.enum(['pool', 'silo']);
export type IsolationModel = z.infer<typeof IsolationModelSchema>;

export const TaskStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'done']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const PrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
export type Priority = z.infer<typeof PrioritySchema>;

export const UuidSchema = z.string().uuid();

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  plan: Plan;
  isolationModel: IsolationModel;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface Membership {
  id: string;
  tenantId: string;
  userId: string;
  role: Role;
  createdAt: string;
}

export interface Project {
  id: string;
  tenantId: string;
  key: string;
  name: string;
  description: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  tenantId: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Priority;
  assigneeId: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  tenantId: string;
  taskId: string;
  authorId: string;
  body: string;
  createdAt: string;
}

/** An entry in the per-tenant audit trail. */
export interface AuditEntry {
  id: string;
  tenantId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Claims carried by an API-issued access token. `tenantId` is the isolation boundary. */
export interface AccessTokenClaims {
  sub: string;
  tenantId: string;
  role: Role;
  email: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
}
