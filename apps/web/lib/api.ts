import type {
  ApiErrorBody,
  Comment,
  CreateProjectInput,
  CreateTaskInput,
  Page,
  Project,
  SessionInfo,
  Task,
  UpdateTaskInput,
} from '@saas/shared-types';

/**
 * Typed API client.
 *
 * The request and response types come from `@saas/shared-types`, the same package the API
 * validates against. If a route's contract changes, this file stops compiling — which is
 * the point of having the package at all.
 *
 * `credentials: 'include'` on every call is what makes the httpOnly session cookies work.
 * The access token is never read by JavaScript, so an XSS payload on this origin cannot
 * exfiltrate it. The cost is that CORS must name an exact origin (no wildcard), which the
 * API does.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = (body as ApiErrorBody | null)?.error;
    throw new ApiRequestError(
      res.status,
      err?.code ?? 'internal',
      err?.message ?? `request failed with ${res.status}`,
      err?.requestId,
    );
  }

  return body as T;
}

/* ---------------------------------------------------------------- session */

export const loginUrl = (returnTo: string): string =>
  `${API_URL}/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

export const getSession = (): Promise<SessionInfo> => request<SessionInfo>('/v1/auth/session');

export const logout = (): Promise<void> =>
  request<void>('/v1/auth/logout', { method: 'POST', body: '{}' });

export const switchTenant = (tenantId: string): Promise<unknown> =>
  request('/v1/auth/switch-tenant', {
    method: 'POST',
    body: JSON.stringify({ tenantId }),
  });

/* --------------------------------------------------------------- projects */

export const listProjects = (): Promise<{ items: Project[] }> =>
  request<{ items: Project[] }>('/v1/projects');

export const getProject = (id: string): Promise<Project> => request<Project>(`/v1/projects/${id}`);

export const createProject = (input: CreateProjectInput): Promise<Project> =>
  request<Project>('/v1/projects', { method: 'POST', body: JSON.stringify(input) });

/* ------------------------------------------------------------------ tasks */

export const listTasks = (params: { projectId?: string } = {}): Promise<Page<Task>> => {
  const qs = new URLSearchParams();
  if (params.projectId) qs.set('projectId', params.projectId);
  qs.set('limit', '100');
  return request<Page<Task>>(`/v1/tasks?${qs.toString()}`);
};

export const getTask = (id: string): Promise<Task> => request<Task>(`/v1/tasks/${id}`);

export const createTask = (input: CreateTaskInput): Promise<Task> =>
  request<Task>('/v1/tasks', { method: 'POST', body: JSON.stringify(input) });

export const updateTask = (id: string, input: UpdateTaskInput): Promise<Task> =>
  request<Task>(`/v1/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(input) });

/* --------------------------------------------------------------- comments */

export const listComments = (taskId: string): Promise<{ items: Comment[] }> =>
  request<{ items: Comment[] }>(`/v1/tasks/${taskId}/comments`);

export const addComment = (taskId: string, body: string): Promise<Comment> =>
  request<Comment>(`/v1/tasks/${taskId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });

/* --------------------------------------------------------------- members */

export interface MemberView {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  role: string;
}

export const listMembers = (): Promise<{ items: MemberView[] }> =>
  request<{ items: MemberView[] }>('/v1/members');
