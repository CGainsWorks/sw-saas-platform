import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Role } from '@saas/shared-types';
import { loadConfig } from '../config.js';
import { getKeys } from './keys.js';

const cfg = loadConfig();

/**
 * Access tokens issued by this API.
 *
 * The `tenantId` claim is the isolation boundary. It is put here, inside a signed token,
 * precisely so that it cannot be supplied by the client — see docs/multi_tenancy.md §3.
 * A request carries its tenant identity in a payload the client cannot alter without
 * invalidating the signature.
 *
 * A user who belongs to several tenants holds a separate token per tenant and switches
 * explicitly. There is no "current tenant" stored server-side per session, because that
 * would make the effective tenant depend on request ordering under concurrency.
 */

export interface VerifiedClaims {
  sub: string;
  tenantId: string;
  role: Role;
  email: string;
  jti: string;
  exp: number;
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

export async function signAccessToken(input: {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
}): Promise<{ token: string; expiresIn: number; jti: string }> {
  const { privateKey, kid } = await getKeys();
  const jti = randomUUID();
  const expiresIn = cfg.ACCESS_TOKEN_TTL_SECONDS;

  const token = await new SignJWT({
    tenantId: input.tenantId,
    role: input.role,
    email: input.email,
  })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setSubject(input.userId)
    .setIssuer(cfg.JWT_ISSUER)
    .setAudience(cfg.JWT_AUDIENCE)
    .setIssuedAt()
    .setJti(jti)
    .setExpirationTime(`${expiresIn}s`)
    .sign(privateKey);

  return { token, expiresIn, jti };
}

function isRole(v: unknown): v is Role {
  return v === 'owner' || v === 'admin' || v === 'member';
}

/**
 * Verifies signature, issuer, audience and expiry, then checks that the claims this
 * application depends on are actually present and well-formed.
 *
 * The shape checks are not paranoia for its own sake: `tenantId` flows straight into
 * `withTenant()` and from there into the row-level security predicate. A token that
 * verified cryptographically but carried `tenantId: null` would otherwise reach the
 * database layer and be rejected there — much better to reject it at the edge with a
 * clear reason, and to have that reason recorded as a scope violation.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedClaims> {
  const { publicKey } = await getKeys();

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, publicKey, {
      issuer: cfg.JWT_ISSUER,
      audience: cfg.JWT_AUDIENCE,
      // Pinning the algorithm defeats the "alg: none" and RS256->HS256 confusion attacks,
      // where a token is re-signed with the public key treated as an HMAC secret.
      algorithms: ['RS256'],
      clockTolerance: 5,
    });
    payload = result.payload;
  } catch (err) {
    const reason = (err as { code?: string }).code ?? 'invalid';
    throw new TokenError('invalid or expired token', reason);
  }

  const { sub, tenantId, role, email, jti, exp } = payload as JWTPayload & {
    tenantId?: unknown;
    role?: unknown;
    email?: unknown;
  };

  if (typeof sub !== 'string' || sub.length === 0) throw new TokenError('token has no subject', 'no_sub');
  if (typeof tenantId !== 'string' || tenantId.length === 0)
    throw new TokenError('token has no tenant claim', 'no_tenant');
  if (!isRole(role)) throw new TokenError('token has no valid role claim', 'no_role');
  if (typeof email !== 'string') throw new TokenError('token has no email claim', 'no_email');
  if (typeof jti !== 'string') throw new TokenError('token has no jti', 'no_jti');

  return { sub, tenantId, role, email, jti, exp: exp ?? 0 };
}
