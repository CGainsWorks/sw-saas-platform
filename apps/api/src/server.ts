import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { assertLeastPrivilege, closePool } from './db/pool.js';
import { closeRedis } from './cache/redis.js';

const cfg = loadConfig();

async function main(): Promise<void> {
  // Refuse to serve if the database role can bypass row-level security. Every isolation
  // guarantee in this system rests on this being false, and it is the kind of thing that
  // gets changed during an incident and never changed back.
  await assertLeastPrivilege();

  const app = await buildApp();

  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  logger.info({ port: cfg.PORT, env: cfg.NODE_ENV }, 'api listening');

  /**
   * Graceful shutdown.
   *
   * On a Kubernetes rolling update the pod receives SIGTERM while it may still be in the
   * load balancer's target list. Draining in-flight requests before exiting is what makes
   * a deploy invisible to users rather than a burst of 502s. `terminationGracePeriodSeconds`
   * in the Deployment must exceed this timeout, or the kubelet SIGKILLs mid-drain.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out; exiting');
      process.exit(1);
    }, 15_000);
    force.unref();

    try {
      await app.close();
      await closePool();
      await closeRedis();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandled promise rejection');
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
