/**
 * The 1.0 machine-readable error vocabulary.
 *
 * Every API error carries `data.errorCode` — a stable string a client can
 * branch on instead of parsing the prose `message`. This module is the single
 * source of truth for the vocabulary and the status → code default, shared by
 * the server error helper (`server/utils/api-error.ts`) and the demo service
 * worker so both surfaces answer identically. Adding a code is additive: a
 * client that does not recognize one falls back to the HTTP status.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNPROCESSABLE_ENTITY'
  | 'RATE_LIMITED'
  | 'AI_NOT_CONFIGURED'
  | 'SMTP_NOT_CONFIGURED'
  | 'SECRET_KEY_NOT_CONFIGURED'
  | 'RUN_TARGET_KEY_REVOKED'
  | 'TRACKER_SEARCH_FAILED'
  | 'SERVICE_UNAVAILABLE'
  | 'BAD_GATEWAY'
  | 'INTERNAL';

const STATUS_CODE: Record<number, ErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
  500: 'INTERNAL',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
};

/** The machine-readable code mirroring an HTTP status; `INTERNAL` for unknowns. */
export function errorCodeForStatus(statusCode: number): ErrorCode {
  return STATUS_CODE[statusCode] ?? 'INTERNAL';
}
