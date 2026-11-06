/**
 * Why a read failed for good, as Piwi itself answered it: `gone` (404, 410: the entity was deleted), `signed-out` (401:
 * the session ended) or `forbidden` (403: the viewer's access was removed). Reading again answers the same until
 * someone acts.
 */
export type FinalRefetchFailure = 'gone' | 'signed-out' | 'forbidden';

/**
 * Why a read failed: a final failure, or `failed` for any other (a proxy's 502 while the instance restarts, no answer
 * at all), which a later read can get past.
 */
export type RefetchFailure = FinalRefetchFailure | 'failed';

/** How a read ended: it answered, or why it failed. */
export type RefetchResult = 'answered' | RefetchFailure;

/** Whether a read that ended so answers the same when tried again: the entity is gone, or the viewer cannot read it. */
export function isFinalRefetch(result: RefetchResult): result is FinalRefetchFailure {
  return result === 'gone' || result === 'signed-out' || result === 'forbidden';
}

/** The HTTP status of the error answer `error` carries, as `$fetch` throws it; undefined when no answer came. */
function answeredStatus(error: unknown): number | undefined {
  const { status, statusCode } = (error ?? {}) as { status?: unknown; statusCode?: unknown };
  if (typeof status === 'number') return status;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

/** The body of `error`'s answer when it is Piwi's own JSON error (with its `statusCode` or `message`), else null. */
function piwiErrorBody(error: unknown): { statusCode?: unknown; message?: unknown } | null {
  const data = (error as { data?: unknown } | null | undefined)?.data;
  if (!data || typeof data !== 'object') return null;
  const body = data as { statusCode?: unknown; message?: unknown };
  return typeof body.statusCode === 'number' || typeof body.message === 'string' ? body : null;
}

/**
 * Why `error`, thrown by `$fetch`, failed. A 404 or 410, 401 or 403 is final only when Piwi itself answered it, with
 * its JSON error: the same status from a proxy in front of it (a 404 page while the container restarts) is `failed`,
 * as is any other status and a read that got no answer.
 */
export function refetchFailure(error: unknown): RefetchFailure {
  if (!piwiErrorBody(error)) return 'failed';
  const code = answeredStatus(error);
  if (code === 404 || code === 410) return 'gone';
  if (code === 401) return 'signed-out';
  if (code === 403) return 'forbidden';
  return 'failed';
}

/**
 * Why a read failed, in a sentence for the person who asked for it: Piwi's own message, else the status the answer
 * carried; null when no answer came.
 */
export function refetchReason(error: unknown): string | null {
  const message = piwiErrorBody(error)?.message;
  if (typeof message === 'string' && message.trim()) return message.trim().replace(/([^.!?])$/, '$1.');
  const code = answeredStatus(error);
  return code === undefined ? null : `The instance answered with HTTP ${code}.`;
}

/**
 * `read`, with `settle` run on each result in the order the reads started: a result that comes after the result of a
 * later read still resolves its own call, but is not settled, so an older answer never undoes what a newer one did.
 */
export function settleInOrder<T>(read: () => Promise<T>, settle: (result: T) => void): () => Promise<T> {
  let started = 0;
  let settled = 0;
  return async () => {
    const id = ++started;
    const result = await read();
    if (id > settled) {
      settled = id;
      settle(result);
    }
    return result;
  };
}

/**
 * Reads a value a page shows again, on each call: an answer replaces the value, and a read that fails (a proxy's 502
 * while the instance restarts, a run deleted meanwhile) leaves the value as it is. An answer that comes after the
 * answer of a later read is dropped. Each call resolves to how its read ended, and never rejects.
 */
export function refetchKeeping<T>(target: { value: T }, read: () => Promise<T>): () => Promise<RefetchResult> {
  let started = 0;
  let shown = 0;
  return async () => {
    const id = ++started;
    try {
      const value = await read();
      if (id > shown) {
        shown = id;
        target.value = value;
      }
      return 'answered';
    } catch (error) {
      return refetchFailure(error);
    }
  };
}
