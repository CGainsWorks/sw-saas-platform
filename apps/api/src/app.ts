import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { errorHandler } from './http/errors.js';
import { authRoutes } from './routes/auth.js';
import { resourceRoutes } from './routes/resources.js';
import { registerGraphql } from './graphql/index.js';
import { pool, reportPoolMetrics } from './db/pool.js';
import { redis } from './cache/redis.js';
import { httpRequestDuration, httpRequestsTotal, metricsText } from './observability/metrics.js';

const cfg = loadConfig();

/**
 * Builds the HTTP application without listening.
 *
 * Kept separate from `server.ts` so tests can drive the real application through
 * `app.inject()` — the full middleware stack, real auth, real database — without binding
 * a port. The HTTP-level isolation tests depend on this: they have to exercise the same
 * code path production uses, or they are testing something else.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Cast because pino's `Logger` and Fastify's `FastifyBaseLogger` differ on `msgPrefix`;
    // they are runtime-compatible, and typing the instance with pino's Logger would leak
    // that generic into every route signature in the codebase.
    loggerInstance: logger as unknown as import('fastify').FastifyBaseLogger,
    // Trust the ALB/ingress for client IPs. Without this, rate limiting keyed on IP would
    // see one load-balancer address for every request and throttle everyone together.
    trustProxy: cfg.isProduction,
    // Honour an upstream request id so a trace spans the ingress, the web app and the API.
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
    bodyLimit: 1_048_576,
  });

  app.setErrorHandler(errorHandler);

  await app.register(helmet, {
    // The API serves JSON, not documents; the GraphiQL page is the one exception and
    // ships its own policy.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cors, {
    origin: cfg.WEB_ORIGIN,
    // Required for the httpOnly session cookies to be sent cross-origin from the web app.
    // Note this makes a wildcard origin impossible, which is the correct trade-off.
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie);

  /**
   * Rate limiting keyed on tenant where possible, falling back to IP.
   *
   * Keying purely on IP is wrong for B2B SaaS: an entire customer behind one corporate
   * NAT shares an address, so a large tenant throttles itself while a distributed
   * attacker is barely inconvenienced. Keying on tenant gives each customer their own
   * budget, which is also the only per-tenant bulkhead the pool model has (see
   * multi_tenancy.md §8 — noisy neighbours are otherwise unaddressed).
   */
  await app.register(rateLimit, {
    max: cfg.RATE_LIMIT_MAX,
    timeWindow: cfg.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req) => req.auth?.tenantId ?? req.ip,
    // A shared store so the limit is global rather than per-replica; with N pods an
    // in-memory limiter would let through N times the intended rate.
    redis,
    nameSpace: 'ratelimit:',
  });

  /* ------------------------------------------------------------ metrics */

  app.addHook('onResponse', async (req, reply) => {
    // The route TEMPLATE, not the resolved URL: "/v1/tasks/:id" has one label value,
    // "/v1/tasks/<uuid>" has one per task and would blow up Prometheus cardinality.
    const route = req.routeOptions?.url ?? 'unmatched';
    const labels = {
      method: req.method,
      route,
      status_code: String(reply.statusCode),
    };
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
    httpRequestsTotal.inc(labels);
  });

  /* ------------------------------------------------------------- health */

  // Liveness: is the process running? Deliberately does NOT check dependencies — a
  // database outage should not make Kubernetes kill every pod, which turns a recoverable
  // dependency failure into a crash loop that prevents recovery.
  app.get('/healthz', async () => ({ status: 'ok', service: 'saas-api' }));

  // Readiness: can this pod actually serve? Dependency failures pull it out of the
  // load-balancer rotation without restarting it.
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    try {
      await pool.query('SELECT 1');
      checks.postgres = 'ok';
    } catch (err) {
      checks.postgres = (err as Error).message;
      healthy = false;
    }

    try {
      await redis.ping();
      checks.redis = 'ok';
    } catch (err) {
      checks.redis = (err as Error).message;
      healthy = false;
    }

    return reply.status(healthy ? 200 : 503).send({ status: healthy ? 'ready' : 'degraded', checks });
  });

  app.get('/metrics', async (_req, reply) => {
    reportPoolMetrics();
    return reply.type('text/plain; version=0.0.4').send(await metricsText());
  });

  /* -------------------------------------------------------------- routes */

  await app.register(authRoutes);
  await app.register(resourceRoutes);
  await registerGraphql(app);

  return app;
}
