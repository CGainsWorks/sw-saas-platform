import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { cacheEvents } from '../observability/metrics.js';

const cfg = loadConfig();

export const redis = new Redis(cfg.REDIS_URL, {
  maxRetriesPerRequest: 3,
  // Fail fast rather than queueing commands during an outage: a cache is not worth
  // holding requests open for.
  enableOfflineQueue: false,
  lazyConnect: false,
  retryStrategy: (times) => Math.min(times * 200, 3_000),
});

redis.on('error', (err) => {
  logger.error({ err }, 'redis error');
});

/**
 * The ONLY way to build a cache key for tenant-scoped data.
 *
 * A cache is an isolation bypass waiting to happen: a cache hit skips the database, and
 * therefore skips row-level security entirely. Everything RLS guarantees is irrelevant
 * if two tenants can collide on a key. Forcing every key through this function means a
 * tenant id is structurally impossible to omit — you cannot call it without one.
 *
 * Colons in the parts are escaped so that ("a:b", "c") and ("a", "b:c") cannot produce
 * the same key.
 */
export function tenantKey(tenantId: string, ...parts: string[]): string {
  if (!tenantId) throw new Error('tenantKey requires a tenant id');
  return `t:${tenantId}:${parts.map((p) => p.replace(/:/g, '%3A')).join(':')}`;
}

/** Keys that are genuinely global (OAuth state, refresh tokens). Named to stand out in review. */
export function globalKey(namespace: string, id: string): string {
  return `g:${namespace}:${id}`;
}

export async function getJson<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (raw === null) {
    cacheEvents.inc({ result: 'miss' });
    return null;
  }
  cacheEvents.inc({ result: 'hit' });
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt entry should not take down a request path.
    await redis.del(key).catch(() => undefined);
    return null;
  }
}

export async function setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}

/** Deletes every key for a tenant. Used when a tenant's data changes shape underneath a cache. */
export async function invalidateTenant(tenantId: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    // SCAN, not KEYS: KEYS blocks the single-threaded Redis server for the whole sweep,
    // which on a shared instance is an outage for every tenant.
    const [next, keys] = await redis.scan(cursor, 'MATCH', `t:${tenantId}:*`, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) deleted += await redis.del(...keys);
  } while (cursor !== '0');
  return deleted;
}

export async function closeRedis(): Promise<void> {
  await redis.quit().catch(() => undefined);
}
