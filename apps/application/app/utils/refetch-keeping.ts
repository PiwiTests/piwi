/**
 * Why a read failed for good: `gone` (404, 410: the entity was deleted), `signed-out` (401: the session ended) or
 * `forbidden` (403: the viewer's access was removed). Reading again answers the same until someone acts.
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

/** Why `error`, thrown by `$fetch`, failed: by the HTTP status of its error answer, `failed` when none came. */
export function refetchFailure(error: unknown): RefetchFailure {
  const { status, statusCode } = (error ?? {}) as { status?: unknown; statusCode?: unknown };
  const code = typeof status === 'number' ? status : statusCode;
  if (code === 404 || code === 410) return 'gone';
  if (code === 401) return 'signed-out';
  if (code === 403) return 'forbidden';
  return 'failed';
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
