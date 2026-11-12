/**
 * A small in-memory cache whose entries expire after a fixed time to live,
 * bounded in size: when full, a new key drops an expired entry first, else the
 * entry set longest ago. Setting a key again makes it the newest.
 */
export class TtlCache<V> {
  private readonly store = new Map<string, { value: V; expiry: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSize = 500,
  ) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /** Drop every entry whose value matches. */
  deleteWhere(test: (value: V, key: string) => boolean): number {
    let dropped = 0;
    for (const [key, entry] of this.store) {
      if (test(entry.value, key)) {
        this.store.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.store.size;
  }

  set(key: string, value: V): void {
    this.store.delete(key);
    if (this.store.size >= this.maxSize) {
      const now = Date.now();
      for (const [k, v] of this.store) {
        if (now > v.expiry) {
          this.store.delete(k);
          break;
        }
      }
      if (this.store.size >= this.maxSize) {
        const first = this.store.keys().next().value;
        if (first !== undefined) this.store.delete(first);
      }
    }
    this.store.set(key, { value, expiry: Date.now() + this.ttlMs });
  }
}
