/**
 * Reads a value a page shows again, on each call: an answer replaces the value, and a read that fails (a proxy's 502
 * while the instance restarts) leaves the value as it is. An answer that comes after the answer of a later read is
 * dropped. Each call resolves to whether its read answered, and never rejects.
 */
export function refetchKeeping<T>(target: { value: T }, read: () => Promise<T>): () => Promise<boolean> {
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
      return true;
    } catch {
      return false;
    }
  };
}
