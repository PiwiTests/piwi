/**
 * The HTTP error contract.
 *
 * Nuxt serializes a thrown h3 error as
 * `{ error, status, statusCode, message, data }`. `apiError` wraps
 * `createError` and guarantees `data` is always an object shaped
 * `{ errorCode, issues? }`, so a client branches on a stable code rather than
 * on the prose `message`:
 *
 * - `errorCode` is a stable, machine-readable string. It defaults to the
 *   mirror of the HTTP status (404 → `NOT_FOUND`, 409 → `CONFLICT`, …); pass an
 *   explicit code to distinguish failures that share a status — e.g. the two
 *   "not configured" 503s (`AI_NOT_CONFIGURED` vs `SMTP_NOT_CONFIGURED`).
 * - `issues` carries structured validation detail (the zod `.issues` array)
 *   from a predictable place. A 400 that carries `issues` defaults its code to
 *   `VALIDATION_ERROR`.
 *
 * Every server route throws `apiError` instead of `createError`, so the whole
 * surface answers with one error shape. Adding a new `ErrorCode` is additive —
 * clients that do not recognize a code fall back to the status.
 */

import { createError } from 'nitro/h3';
import { type ErrorCode, errorCodeForStatus } from '#shared/utils/error-codes';

export interface ApiErrorInput {
  statusCode: number;
  message?: string;
  statusMessage?: string;
  /** Stable machine-readable code; defaults from the status when omitted. */
  errorCode?: ErrorCode;
  /**
   * Structured detail. A bare array (a zod `.issues` array) is folded into
   * `issues`; an object is merged into the normalized `data`.
   */
  data?: unknown;
  cause?: unknown;
  fatal?: boolean;
  unhandled?: boolean;
}

/**
 * Standardized {@link createError}. Throw it exactly like `createError`:
 * `throw apiError({ statusCode: 404, message: 'Run not found' })`.
 */
export function apiError(input: ApiErrorInput) {
  const { data, errorCode, statusCode, ...rest } = input;

  const dataObj =
    data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  const issues = Array.isArray(data) ? data : dataObj?.issues;

  const code: ErrorCode =
    errorCode ??
    (dataObj?.errorCode as ErrorCode | undefined) ??
    (issues !== undefined && statusCode === 400 ? 'VALIDATION_ERROR' : errorCodeForStatus(statusCode));

  const normalized: { errorCode: ErrorCode; issues?: unknown; [key: string]: unknown } = {
    ...dataObj,
    errorCode: code,
  };
  if (issues !== undefined) normalized.issues = issues;

  return createError({ ...rest, statusCode, data: normalized });
}
