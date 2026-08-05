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
  ...(cfg.isProduction
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }),
});
