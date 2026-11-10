import { isCatalogLookupKey, MAX_CATALOG_LOOKUP_KEYS } from '#shared/integrations/test-management-mapping';

/** What the stored catalog says about one key, as the hover card shows it. */
export type TestCaseKeyState =
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'ready';
      /** Null when the catalog holds no such case. */
      testCase: { name: string; status: string | null; url: string | null } | null;
      /** When the catalog was last read; null while it never was. */
      fetchedAt: string | null;
    };

export interface CatalogCasesResponse {
  fetchedAt: string | null;
  cases: Record<string, { name: string; status: string | null; url: string | null } | null>;
}

export interface TestCaseKeyLoader {
  /** Ask for `key`, once: a key already loading or loaded is not asked for again, one that failed is. */
  load: (key: string) => void;
  /** Forget every queued key and drop the answers of requests still on their way; the caller clears `states`. */
  reset: () => void;
}

/**
 * Looks keys up in the stored catalog for the hover cards of one page. Every key asked for before `schedule` fires goes
 * in one request (up to the most one request names, then the next), and the answers are written into `states`, which
 * the caller keeps reactive. Nothing is asked for until `load` is called: a page with a hundred tags makes no request
 * until a card is opened.
 */
export function createTestCaseKeyLoader(options: {
  states: Record<string, TestCaseKeyState>;
  fetchCases: (keys: string[]) => Promise<CatalogCasesResponse>;
  /** Run `fn` once the keys of this tick are queued; a macrotask by default. */
  schedule?: (fn: () => void) => void;
}): TestCaseKeyLoader {
  const { states, fetchCases } = options;
  const schedule = options.schedule ?? ((fn: () => void) => void setTimeout(fn, 0));
  const queued = new Set<string>();
  let scheduled = false;
  let epoch = 0;

  async function flush(): Promise<void> {
    scheduled = false;
    const keys = [...queued].slice(0, MAX_CATALOG_LOOKUP_KEYS);
    for (const key of keys) queued.delete(key);
    if (queued.size > 0) enqueue();
    if (keys.length === 0) return;
    const asked = epoch;
    try {
      const res = await fetchCases(keys);
      if (asked !== epoch) return;
      for (const key of keys) {
        states[key] = { status: 'ready', testCase: res.cases[key] ?? null, fetchedAt: res.fetchedAt };
      }
    } catch {
      if (asked !== epoch) return;
      for (const key of keys) states[key] = { status: 'error' };
    }
  }

  function enqueue(): void {
    if (scheduled) return;
    scheduled = true;
    schedule(() => void flush());
  }

  return {
    load(key) {
      const known = states[key];
      if (known && known.status !== 'error') return;
      // Zephyr writes a key as `PROJECT-T123`: anything else is not a key it could hold, and is not sent.
      if (!isCatalogLookupKey(key)) {
        states[key] = { status: 'error' };
        return;
      }
      states[key] = { status: 'loading' };
      queued.add(key);
      enqueue();
    },
    reset() {
      epoch += 1;
      queued.clear();
    },
  };
}
