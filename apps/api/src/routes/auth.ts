import type { FastifyInstance, FastifyReply } from 'fastify';
import { RefreshSchema, SwitchTenantSchema, type SessionInfo } from '@saas/shared-types';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  authOf,
  requireAuth,
} from '../auth/middleware.js';
import { signAccessToken } from '../auth/jwt.js';
import { jwks } from '../auth/keys.js';
import { OidcError, beginAuthorization, completeAuthorization, safeReturnTo } from '../auth/oidc.js';
import {
  RefreshInvalidError,
  RefreshReuseError,
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
} from '../auth/refresh.js';
import { assertMembership, membershipsForEmail, resolveSession } from '../services/identity.js';
import { badRequest, forbidden, unauthorized } from '../http/errors.js';
import { authEvents } from '../observability/metrics.js';

const cfg = loadConfig();

/**
 * Cookies are httpOnly so an XSS payload cannot read the token, `sameSite: lax` so a
 * cross-site POST cannot ride the session, and `secure` in production.
 *
 * `lax` rather than `strict`: the OAuth callback is a top-level GET arriving from the
 * identity provider's origin, and `strict` would withhold the cookie on exactly that
 * navigation, breaking login. `lax` sends cookies on top-level GETs while still blocking
 * the cross-site POST that CSRF depends on.
 */
function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: cfg.isProduction,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

async function issueSession(
  reply: FastifyReply,
  input: { userId: string; tenantId: string; role: 'owner' | 'admin' | 'member'; email: string },
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const { token: accessToken, expiresIn } = await signAccessToken(input);
  const { token: refreshToken } = await issueRefreshToken(input);

  reply.setCookie(ACCESS_COOKIE, accessToken, cookieOptions(expiresIn));
  reply.setCookie(REFRESH_COOKIE, refreshToken, cookieOptions(cfg.REFRESH_TOKEN_TTL_SECONDS));

  return { accessToken, refreshToken, expiresIn };
}

function clearSession(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_COOKIE, { path: '/' });
  reply.clearCookie(REFRESH_COOKIE, { path: '/' });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** Public key material, so other services can verify our tokens without minting them. */
  app.get('/.well-known/jwks.json', async () => jwks());

  /* ------------------------------------------------------------- login */

  app.get<{ Querystring: { returnTo?: string } }>('/v1/auth/login', async (req, reply) => {
    const returnTo = safeReturnTo(req.query.returnTo);
    const { url } = await beginAuthorization(returnTo);
    authEvents.inc({ event: 'login_started', outcome: 'success' });
    return reply.redirect(url, 302);
  });

  /**
   * OAuth2 redirect target. Everything security-relevant happens inside
   * `completeAuthorization`: single-use state, PKCE verifier, ID token signature against
   * the provider's JWKS, issuer, audience, expiry and nonce.
   *
   * Only after all of that does the email get used to look up membership — in the
   * database, not from any client-supplied value.
   */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/v1/auth/callback',
    async (req, reply) => {
      const { code, state, error } = req.query;

      if (error) {
        authEvents.inc({ event: 'login_callback', outcome: 'provider_error' });
        throw unauthorized(`identity provider returned an error: ${error}`);
      }
      if (!code || !state) throw badRequest('callback requires both code and state');

      let identity;
      try {
        identity = await completeAuthorization({ code, state });
      } catch (err) {
        if (err instanceof OidcError) {
          authEvents.inc({ event: 'login_callback', outcome: err.reason });
          throw unauthorized(`login failed: ${err.message}`);
        }
        throw err;
      }

      const { selected, provisioned } = await resolveSession({
        email: identity.email,
        name: identity.name,
      });

      await issueSession(reply, {
        userId: selected.userId,
        tenantId: selected.tenantId,
        role: selected.role,
        email: identity.email,
      });

      authEvents.inc({ event: 'login_callback', outcome: 'success' });
      logger.info(
        { tenantId: selected.tenantId, userId: selected.userId, provisioned },
        'login succeeded',
      );

      return reply.redirect(safeReturnTo(identity.returnTo), 302);
    },
  );

  /* ----------------------------------------------------------- session */

  app.get(
    '/v1/auth/session',
    { preHandler: requireAuth },
    async (req): Promise<SessionInfo> => {
      const auth = authOf(req);

      // Re-read from the database rather than reflecting the token back. The token is a
      // snapshot from up to 15 minutes ago; membership may have been revoked since.
      const memberships = await membershipsForEmail(auth.email);
      const current = memberships.find((m) => m.tenantId === auth.tenantId);

      if (!current) {
        // The token is validly signed but the membership behind it is gone.
        throw forbidden('your membership of this tenant is no longer active');
      }

      return {
        user: { id: current.userId, email: auth.email, name: current.userName },
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
          role: m.role,
        })),
      };
    },
  );

  /* ----------------------------------------------------------- refresh */

  app.post('/v1/auth/refresh', async (req, reply) => {
    const fromCookie = req.cookies[REFRESH_COOKIE];
    const fromBody = req.body ? RefreshSchema.safeParse(req.body) : null;
    const presented = fromCookie ?? (fromBody?.success ? fromBody.data.refreshToken : undefined);

    if (!presented) throw unauthorized('no refresh token supplied');

    try {
      const rotated = await rotateRefreshToken(presented);

      const { token: accessToken, expiresIn } = await signAccessToken({
        userId: rotated.userId,
        tenantId: rotated.tenantId,
        role: rotated.role,
        email: rotated.email,
      });

      reply.setCookie(ACCESS_COOKIE, accessToken, cookieOptions(expiresIn));
      reply.setCookie(
        REFRESH_COOKIE,
        rotated.refreshToken,
        cookieOptions(cfg.REFRESH_TOKEN_TTL_SECONDS),
      );

      return {
        accessToken,
        refreshToken: rotated.refreshToken,
        expiresIn,
        tokenType: 'Bearer' as const,
      };
    } catch (err) {
      clearSession(reply);
      if (err instanceof RefreshReuseError) {
        // Either a replay by the legitimate client or a stolen token in use, and there is
        // no way to tell them apart. The whole family is already revoked by this point.
        throw unauthorized('session revoked: refresh token reuse detected');
      }
      if (err instanceof RefreshInvalidError) throw unauthorized('refresh token is not valid');
      throw err;
    }
  });

  /* ----------------------------------------------------- switch tenant */

  /**
   * Issues a token for a different tenant.
   *
   * The requested tenant is re-checked against the database every time. A token proving
   * membership of tenant A says nothing about tenant B, and — just as importantly — an
   * old token does not prove the membership still exists. There is no path here that
   * takes the client's word for it.
   */
  app.post(
    '/v1/auth/switch-tenant',
    { preHandler: requireAuth },
    async (req, reply) => {
      const auth = authOf(req);
      const parsed = SwitchTenantSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('a valid tenantId is required');

      const membership = await assertMembership(auth.email, parsed.data.tenantId);
      if (!membership) {
        authEvents.inc({ event: 'switch_tenant', outcome: 'denied' });
        logger.warn(
          { userId: auth.userId, fromTenant: auth.tenantId, toTenant: parsed.data.tenantId },
          'tenant switch denied: no membership',
        );
        // 404, not 403: a 403 would confirm that the tenant exists.
        throw unauthorized('no membership of the requested tenant');
      }

      const session = await issueSession(reply, {
        userId: membership.userId,
        tenantId: membership.tenantId,
        role: membership.role,
        email: auth.email,
      });

      authEvents.inc({ event: 'switch_tenant', outcome: 'success' });

      return {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: session.expiresIn,
        tokenType: 'Bearer' as const,
        tenant: {
          id: membership.tenantId,
          slug: membership.tenantSlug,
          name: membership.tenantName,
          role: membership.role,
        },
      };
    },
  );

  /* ------------------------------------------------------------ logout */

  app.post('/v1/auth/logout', async (req, reply) => {
    const presented = req.cookies[REFRESH_COOKIE];
    if (presented) await revokeRefreshToken(presented);
    clearSession(reply);
    return { ok: true };
  });
}
