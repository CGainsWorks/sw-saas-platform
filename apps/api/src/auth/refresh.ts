import { randomBytes, createHash, randomUUID } from 'node:crypto';
import type { Role } from '@saas/shared-types';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { globalKey, redis } from '../cache/redis.js';
import { authEvents } from '../observability/metrics.js';

const cfg = loadConfig();

/**
 * Refresh tokens with rotation and reuse detection.
 *
 * Refresh tokens are long-lived, which makes a stolen one valuable. Rotation means each
 * refresh invalidates the token that was presented and issues a new one. Reuse detection
 * turns that into an alarm: if a token that has already been rotated is presented again,
 * either the legitimate client replayed it or an attacker is using a stolen copy — and
 * there is no way to tell which. The safe response is to revoke the entire family,
 * logging both parties out and forcing a fresh login.
 *
 * Opaque random strings, not JWTs. There is nothing to gain from a self-describing
 * refresh token — it has to be checked against server state on every use anyway, because
 * revocation is the entire point.
 *
 * Only the SHA-256 of the token is stored. A dump of Redis therefore does not yield
 * usable credentials, the same reason password hashes exist.
 */

interface StoredRefresh {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  /** All tokens descended from one login share a family id, so they can be revoked together. */
  familyId: string;
  /** Set once the token has been exchanged. A second presentation is the reuse signal. */
  rotatedAt: number | null;
}

const REFRESH_NS = 'rt';
const FAMILY_NS = 'rtfam';

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedRefresh {
  token: string;
  familyId: string;
}

export async function issueRefreshToken(input: {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  familyId?: string;
}): Promise<IssuedRefresh> {
  const token = randomBytes(32).toString('base64url');
  const familyId = input.familyId ?? randomUUID();

  const record: StoredRefresh = {
    userId: input.userId,
    tenantId: input.tenantId,
    role: input.role,
    email: input.email,
    familyId,
    rotatedAt: null,
  };

  const key = globalKey(REFRESH_NS, hash(token));
  const ttl = cfg.REFRESH_TOKEN_TTL_SECONDS;

  await redis
    .multi()
    .set(key, JSON.stringify(record), 'EX', ttl)
    .sadd(globalKey(FAMILY_NS, familyId), hash(token))
    .expire(globalKey(FAMILY_NS, familyId), ttl)
    .exec();

  return { token, familyId };
}

export class RefreshReuseError extends Error {
  constructor() {
    super('refresh token has already been used; the session family has been revoked');
    this.name = 'RefreshReuseError';
  }
}

export class RefreshInvalidError extends Error {
  constructor() {
    super('refresh token is invalid or expired');
    this.name = 'RefreshInvalidError';
  }
}

/** Revokes every refresh token descended from one login. */
export async function revokeFamily(familyId: string): Promise<number> {
  const famKey = globalKey(FAMILY_NS, familyId);
  const members = await redis.smembers(famKey);
  if (members.length === 0) {
    await redis.del(famKey);
    return 0;
  }
  const keys = members.map((h) => globalKey(REFRESH_NS, h));
  const removed = await redis.del(...keys, famKey);
  return removed;
}

export interface RotatedSession {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  refreshToken: string;
  familyId: string;
}

/**
 * Exchanges a refresh token for a new one.
 *
 * The check-and-mark is done with an atomic Lua script rather than GET-then-SET. Two
 * concurrent refreshes with the same token — which happens routinely when a browser
 * opens several tabs at once — would otherwise both read `rotatedAt: null`, both succeed,
 * and produce two live tokens where there should be one. Worse, under the opposite
 * interleaving both could be treated as reuse and log a legitimate user out. Atomicity
 * makes exactly one of them the winner.
 */
const ROTATE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local rec = cjson.decode(raw)
if rec.rotatedAt ~= nil and rec.rotatedAt ~= cjson.null then
  return 'REUSE:' .. rec.familyId
end
rec.rotatedAt = tonumber(ARGV[1])
redis.call('SET', KEYS[1], cjson.encode(rec), 'KEEPTTL')
return raw
`;

export async function rotateRefreshToken(presented: string): Promise<RotatedSession> {
  const key = globalKey(REFRESH_NS, hash(presented));

  const result = (await redis.eval(ROTATE_SCRIPT, 1, key, Date.now().toString())) as
    | string
    | null;

  if (result === null) {
    authEvents.inc({ event: 'refresh', outcome: 'invalid' });
    throw new RefreshInvalidError();
  }

  if (result.startsWith('REUSE:')) {
    const familyId = result.slice('REUSE:'.length);
    const revoked = await revokeFamily(familyId);
    authEvents.inc({ event: 'refresh', outcome: 'reuse_detected' });
    logger.warn(
      { familyId, revoked },
      'refresh token reuse detected; revoked the whole token family',
    );
    throw new RefreshReuseError();
  }

  const record = JSON.parse(result) as StoredRefresh;

  const next = await issueRefreshToken({
    userId: record.userId,
    tenantId: record.tenantId,
    role: record.role,
    email: record.email,
    familyId: record.familyId,
  });

  authEvents.inc({ event: 'refresh', outcome: 'success' });

  return {
    userId: record.userId,
    tenantId: record.tenantId,
    role: record.role,
    email: record.email,
    refreshToken: next.token,
    familyId: record.familyId,
  };
}

/** Logout. Revokes the presented token's entire family, not just the token. */
export async function revokeRefreshToken(presented: string): Promise<void> {
  const key = globalKey(REFRESH_NS, hash(presented));
  const raw = await redis.get(key);
  if (!raw) return;
  const record = JSON.parse(raw) as StoredRefresh;
  await revokeFamily(record.familyId);
  authEvents.inc({ event: 'logout', outcome: 'success' });
}
