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

/** An HTTP date as RFC 9110 sends it (IMF-fixdate): `Sun, 08 Nov 2026 06:00:30 GMT`. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * A `Retry-After` header in milliseconds: delay-seconds (`120`) or an HTTP date (`Sun, 08 Nov 2026 06:00:30 GMT`),
 * counted from `now`, capped at {@link RETRY_AFTER_CAP_MS}. Undefined for a missing header or one in neither form; a
 * date in the past waits 0.
 */
export function parseRetryAfter(header: string | null | undefined, now: number = Date.now()): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  let ms: number;
  if (/^\d+$/.test(value)) {
    ms = Number(value) * 1000;
  } else if (IMF_FIXDATE.test(value)) {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return undefined;
    ms = Math.max(0, at - now);
  } else {
    return undefined;
  }
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}
