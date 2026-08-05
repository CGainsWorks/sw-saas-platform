import { createRequire } from 'node:module';
import { pino, type Logger } from 'pino';
import { loadConfig } from './config.js';

const cfg = loadConfig();

/**
 * Is pino-pretty actually installed?
 *
 * It is a devDependency, so the production image prunes it — but the container may still
 * run with NODE_ENV=development (the compose demo does exactly that, to pick up the dev
 * identity provider defaults). Pino resolves transport targets lazily and throws at
 * construction if the target is missing, which would take the whole process down over a
 * log formatter. Checking first turns that into a silent fallback to JSON.
 */
function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

const usePretty = !cfg.isProduction && !cfg.isTest && prettyAvailable();

/**
 * Structured JSON logs. Every line carries `tenantId` where one is known, because the
 * first question during an incident is almost always "is this one customer or all of
 * them", and grepping for it is the difference between a two-minute and a two-hour
 * answer.
 */
export const logger: Logger = pino({
  level: cfg.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'refreshToken',
      'accessToken',
      'client_secret',
      'code_verifier',
      '*.refreshToken',
      '*.accessToken',
    ],
    censor: '[redacted]',
  },
  base: { service: 'saas-api' },
  // Pretty printing only for interactive development. Skipped under test because pino
  // transports run in a worker thread, and inside a test runner's own worker that output
  // is silently dropped — which turns a logged error into no error at all, exactly when
  // you are trying to debug a failing suite. JSON everywhere else, which is what log
  // aggregation wants anyway.
  ...(usePretty
    ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
    : {}),
});
