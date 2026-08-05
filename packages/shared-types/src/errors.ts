/**
 * Wire format for API errors. Kept deliberately small.
 *
 * Note the absence of a `403 forbidden` for cross-tenant access: asking for a resource
 * that belongs to another tenant returns 404, because 403 would confirm the resource
 * exists. See docs/multi_tenancy.md §6.
 */
export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Field-level validation detail. Present only for `bad_request`. */
    details?: Array<{ path: string; message: string }>;
    /** Correlates a client-visible error with the server log line. */
    requestId: string;
  };
}

export const HTTP_STATUS_FOR_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};
