import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { HTTP_STATUS_FOR_CODE, type ApiErrorBody, type ApiErrorCode } from '@saas/shared-types';
import { logger } from '../logger.js';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get status(): number {
    return HTTP_STATUS_FOR_CODE[this.code];
  }
}

export const badRequest = (m: string, d?: ApiError['details']) => new ApiError('bad_request', m, d);
export const unauthorized = (m = 'authentication required') => new ApiError('unauthorized', m);
export const forbidden = (m = 'insufficient permissions') => new ApiError('forbidden', m);
export const conflict = (m: string) => new ApiError('conflict', m);

/**
 * Cross-tenant access is reported as 404, never 403.
 *
 * 403 means "this exists and you may not have it", which confirms the resource exists —
 * an oracle that lets one customer probe another's id space and learn, for example, how
 * many projects a competitor has. 404 means "no such thing here", which is also, from
 * inside this tenant's view of the database, literally true: RLS filtered the row out
 * before the handler saw it.
 */
export const notFound = (what = 'resource') => new ApiError('not_found', `${what} not found`);

/** Fastify's global error handler. The only place that turns a thrown value into a response. */
export function errorHandler(
  err: FastifyError | ApiError | ZodError,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = req.id;

  if (err instanceof ApiError) {
    const body: ApiErrorBody = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
        requestId,
      },
    };
    // 4xx is a client problem and expected traffic; logging it at error level trains
    // people to ignore the error log.
    req.log.info({ code: err.code, status: err.status }, err.message);
    void reply.status(err.status).send(body);
    return;
  }

  if (err instanceof ZodError) {
    const body: ApiErrorBody = {
      error: {
        code: 'bad_request',
        message: 'request failed validation',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId,
      },
    };
    void reply.status(400).send(body);
    return;
  }

  const fastifyErr = err as FastifyError;

  // Fastify's own 4xx (body parse failures, rate limit, unsupported media type).
  if (typeof fastifyErr.statusCode === 'number' && fastifyErr.statusCode < 500) {
    const code: ApiErrorCode = fastifyErr.statusCode === 429 ? 'rate_limited' : 'bad_request';
    void reply.status(fastifyErr.statusCode).send({
      error: { code, message: fastifyErr.message, requestId },
    } satisfies ApiErrorBody);
    return;
  }

  // Anything unrecognised is a bug. Log it in full, tell the client nothing beyond the
  // request id — internal messages leak schema names, file paths and query fragments.
  logger.error({ err, requestId, url: req.url, method: req.method }, 'unhandled error');
  void reply.status(500).send({
    error: { code: 'internal', message: 'internal server error', requestId },
  } satisfies ApiErrorBody);
}
