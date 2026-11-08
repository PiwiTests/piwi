/**
 * The error every integration client throws for a refused HTTP call, whatever the provider: its status and, when the
 * provider says so, how long to wait before the next call. The outbox reads only this, so a new provider's client
 * extends it and its refusals, retries and pauses work as the first provider's do.
 */

/** The longest wait a provider's `Retry-After` can ask for: one hour. */
export const RETRY_AFTER_CAP_MS = 60 * 60 * 1000;

export class IntegrationHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** How long the provider asked to wait before the next call, from its `Retry-After`, capped at one hour. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'IntegrationHttpError';
  }
}

/**
 * A `Retry-After` header in milliseconds: delay-seconds (`120`) or an HTTP date (`Wed, 21 Oct 2026 07:28:00 GMT`),
 * counted from `now`, capped at {@link RETRY_AFTER_CAP_MS}. Undefined for a missing or unreadable header; a date in
 * the past waits 0.
 */
export function parseRetryAfter(header: string | null | undefined, now: number = Date.now()): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  let ms: number;
  if (/^\d+$/.test(value)) {
    ms = Number(value) * 1000;
  } else {
    // An HTTP date names its day and month; a bare number such as `-5` is no date.
    const at = /[a-z]/i.test(value) ? Date.parse(value) : NaN;
    if (Number.isNaN(at)) return undefined;
    ms = Math.max(0, at - now);
  }
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}
