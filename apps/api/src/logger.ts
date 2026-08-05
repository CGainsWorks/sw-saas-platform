import { pino, type Logger } from 'pino';
import { loadConfig } from './config.js';

const cfg = loadConfig();

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
  // Pretty printing only for interactive development. It is skipped under test because
  // pino transports run in a worker thread, and inside a test runner's own worker that
  // output is silently dropped — which turns a logged error into no error at all, exactly
  // when you are trying to debug a failing suite.
  ...(cfg.isProduction || cfg.isTest
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }),
});
