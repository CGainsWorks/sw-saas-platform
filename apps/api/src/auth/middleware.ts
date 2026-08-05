import type { FastifyReply, FastifyRequest } from 'fastify';
import { ROLE_RANK, type Role } from '@saas/shared-types';
import { forbidden, unauthorized } from '../http/errors.js';
import { tenantScopeViolations } from '../observability/metrics.js';
import { TokenError, verifyAccessToken } from './jwt.js';

/** Everything a handler is allowed to know about who is calling. */
export interface AuthContext {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  tokenId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export const ACCESS_COOKIE = 'saas_at';
export const REFRESH_COOKIE = 'saas_rt';

/**
 * Two accepted transports, in priority order:
 *
 *   1. `Authorization: Bearer <token>` — API clients, curl, GraphQL tooling.
 *   2. An httpOnly cookie — the browser app, which never handles the token in JS and so
 *      cannot leak it to an XSS payload.
 *
 * The header wins when both are present. That ordering matters: it means an explicit
 * credential always beats an ambient one, so a stale cookie cannot silently override the
 * token a caller deliberately supplied.
 */
function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && value) return value.trim();
  }

  const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  const fromCookie = cookies?.[ACCESS_COOKIE];
  if (typeof fromCookie === 'string' && fromCookie.length > 0) return fromCookie;

  return null;
}

/**
 * Authenticates the request and installs the tenant scope.
 *
 * The tenant id comes from the verified token and from nowhere else. There is no code
 * path in this application that reads a tenant from a header, a query parameter or a
 * body field — see the `rejects an X-Tenant-Id header` test. That header is a common
 * convenience in multi-tenant APIs and it is a straightforward account-takeover primitive.
 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    tenantScopeViolations.inc({ surface: 'http', reason: 'no_token' });
    throw unauthorized('no access token supplied');
  }

  try {
    const claims = await verifyAccessToken(token);
    req.auth = {
      userId: claims.sub,
      tenantId: claims.tenantId,
      role: claims.role,
      email: claims.email,
      tokenId: claims.jti,
    };
  } catch (err) {
    if (err instanceof TokenError) {
      tenantScopeViolations.inc({ surface: 'http', reason: err.reason });
      throw unauthorized(err.message);
    }
    throw err;
  }
}

/** Narrows `req.auth` for handlers, and fails loudly if a route forgot `requireAuth`. */
export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) {
    // A programming error, not a client error: this route is missing its preHandler.
    throw unauthorized('route requires authentication but none was performed');
  }
  return req.auth;
}

/**
 * Role gate, within the tenant the token is scoped to.
 *
 * Roles are per-tenant: being an owner of tenant A confers nothing in tenant B, because
 * the token that names tenant B carries whatever role that membership has. Authorisation
 * therefore never needs to ask "which tenant is this role for" — the token pairs them.
 */
export function requireRole(minimum: Role) {
  return async function roleGuard(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const auth = authOf(req);
    if (ROLE_RANK[auth.role] < ROLE_RANK[minimum]) {
      throw forbidden(`this action requires the ${minimum} role or higher`);
    }
  };
}
