import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import type { FastifyInstance } from 'fastify';
import type { Role } from '@saas/shared-types';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { signAccessToken } from '../../src/auth/jwt.js';
import type { SeededTenant } from './fixtures.js';

const cfg = loadConfig();

let app: FastifyInstance | null = null;

/** One application instance per test file, driven through inject() rather than a socket. */
export async function testApp(): Promise<FastifyInstance> {
  app ??= await buildApp();
  await app.ready();
  return app;
}

export async function closeApp(): Promise<void> {
  if (app) {
    await app.close();
    app = null;
  }
}

/**
 * Mints a genuine access token for a seeded tenant.
 *
 * These tests play a *legitimately authenticated* user, not an anonymous attacker. That
 * is the interesting threat model for a multi-tenant system: the dangerous caller is a
 * real customer with a valid token who reaches for someone else's ids.
 */
export async function tokenFor(tenant: SeededTenant, role: Role = 'owner'): Promise<string> {
  const { token } = await signAccessToken({
    userId: tenant.userId,
    tenantId: tenant.tenantId,
    role,
    email: tenant.userEmail,
  });
  return token;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/**
 * A token that is structurally perfect and correctly claims tenant B, but is signed with
 * a *different* RSA key.
 *
 * This is the attack where someone understands the token format exactly and simply signs
 * their own. It must fail on the signature alone, with no help from any other check.
 */
export async function foreignlySignedToken(tenantId: string, userId: string): Promise<string> {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const key = await importPKCS8(pair.privateKey, 'RS256');

  return new SignJWT({ tenantId, role: 'owner', email: 'attacker@evil.test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'attacker', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(cfg.JWT_ISSUER)
    .setAudience(cfg.JWT_AUDIENCE)
    .setIssuedAt()
    .setJti('forged')
    .setExpirationTime('15m')
    .sign(key);
}

/**
 * Takes a valid token and rewrites the tenant claim in its payload, leaving the original
 * signature attached — the "just edit the JWT" attack that works against any
 * implementation which decodes without verifying.
 */
export function tamperTenantClaim(token: string, newTenantId: string): string {
  const [header, payload, signature] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  decoded.tenantId = newTenantId;
  const repacked = Buffer.from(JSON.stringify(decoded)).toString('base64url');
  return `${header}.${repacked}.${signature}`;
}

/** Convenience wrapper for GraphQL requests through inject(). */
export async function gql(
  instance: FastifyInstance,
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<{ status: number; data: unknown; errors?: Array<{ message: string }> }> {
  const res = await instance.inject({
    method: 'POST',
    url: '/graphql',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });

  const body = res.body ? (JSON.parse(res.body) as { data?: unknown; errors?: never }) : {};
  const errors = (body as { errors?: Array<{ message: string }> }).errors;

  // Surfaces the real failure when a test breaks. Yoga masks internal errors to
  // "Unexpected error.", which is correct for clients and useless when debugging a suite.
  if (errors?.some((e) => e.message === 'Unexpected error.')) {
    console.error('[gql] masked internal error for query:', query, '\nraw:', res.body);
  }

  return { status: res.statusCode, data: body.data ?? null, errors };
}
