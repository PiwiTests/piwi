/**
 * A mutex per key: calls holding the same key run one at a time, in arrival
 * order, and calls for other keys run alongside them. A call that fails never
 * fails the one queued behind it.
 *
 * In-memory, so it serializes within one server process.
 */
export function createKeyedLock<K>(): <T>(key: K, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<K, Promise<unknown>>();
  return async function withLock<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const prior = tails.get(key) ?? Promise.resolve();
    const run = prior.then(
      () => fn(),
      () => fn(),
    );
    tails.set(key, run);
    try {
      return await run;
    } finally {
      if (tails.get(key) === run) tails.delete(key);
    }
  };
}
