/**
 * One tab of the browser at a time holds a lease, kept in `localStorage` under `key`: the holder writes its id and the
 * time every `renewMs`, and another tab takes the lease once the holder released it (as its page goes away) or has not
 * renewed it for `staleMs`. A tab that writes the lease waits `settleMs` and holds it only if its own id is still
 * there. A tab can see another tab's write late, so tabs that take it at once can each pass that check: as soon as a
 * holder sees another tab's fresh lease (a `storage` event, or its next renewal), the smaller id keeps it and writes
 * it again, and the other loses it. An id starts with its tab's start time, so the older tab keeps it.
 * `localStorage` works in every context, a page served over plain HTTP included.
 *
 * `staleMs` outlasts the minute a browser may wait between two timers of a tab hidden for a while, so a hidden holder
 * keeps its lease. A holder whose own lease went stale loses it to another tab's fresh one, whatever their ids. A
 * holder that loses it is told so (`lost`).
 */
export interface TabLeaseOptions {
  key: string;
  /** Called once this tab holds the lease. */
  held: () => void;
  /** Called once this tab, which held it, lost it to another. */
  lost: () => void;
  renewMs?: number;
  staleMs?: number;
  settleMs?: number;
}

/** What the lease uses of the browser, given by the tests. */
export interface TabLeaseHost {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** Listens to `storage`, `pagehide` and `pageshow` on the window. */
  on: (
    type: 'storage' | 'pagehide' | 'pageshow',
    listener: (event: { key?: string | null; persisted?: boolean }) => void,
  ) => void;
}

export const TAB_LEASE_RENEW_MS = 10_000;
export const TAB_LEASE_STALE_MS = 90_000;
export const TAB_LEASE_SETTLE_MS = 250;

interface Lease {
  id: string;
  at: number;
}

/**
 * Hold the lease of `options.key` in one tab of the browser. Without a `localStorage` this page may write (a browser
 * that refuses it, or one whose storage is full), every tab holds it. Returns a function that gives the lease up.
 */
export function holdInOneTab(options: TabLeaseOptions, host: TabLeaseHost = browserHost()): () => void {
  const renewMs = options.renewMs ?? TAB_LEASE_RENEW_MS;
  const staleMs = options.staleMs ?? TAB_LEASE_STALE_MS;
  const settleMs = options.settleMs ?? TAB_LEASE_SETTLE_MS;
  const id = `${host.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let holding = false;
  let claiming = false;
  let stopped = false;
  /** When this tab last wrote its lease. */
  let wroteAt = Number.NEGATIVE_INFINITY;

  const read = (): Lease | null => {
    try {
      const lease = JSON.parse(host.storage.getItem(options.key) ?? 'null') as Partial<Lease> | null;
      return lease && typeof lease.id === 'string' && typeof lease.at === 'number' ? (lease as Lease) : null;
    } catch {
      return null;
    }
  };
  /** Write this tab's lease; false when the storage refuses it. */
  const write = (): boolean => {
    try {
      const at = host.now();
      host.storage.setItem(options.key, JSON.stringify({ id, at }));
      wroteAt = at;
      return true;
    } catch {
      return false;
    }
  };
  /** Whether this holder keeps the lease beside another tab's fresh `lease`: its own is fresh and its id is smaller. */
  const keepsBeside = (lease: Lease): boolean => host.now() - wroteAt < staleMs && id < lease.id;

  try {
    const probe = `${options.key}:probe`;
    host.storage.setItem(probe, id);
    host.storage.removeItem(probe);
  } catch {
    options.held();
    return () => {};
  }

  const tick = (): void => {
    if (stopped || claiming) return;
    const lease = read();
    if (holding) {
      // Another tab's stale lease is no claim on a holder, as when the storage refused this tab's own write over it.
      if (lease && lease.id !== id && host.now() - lease.at < staleMs && !keepsBeside(lease)) {
        holding = false;
        options.lost();
        return;
      }
      write();
      return;
    }
    if (lease && lease.id !== id && host.now() - lease.at < staleMs) return;
    // A storage that refuses the claim leaves no lease to agree on: this tab holds it, as without a storage.
    if (!write()) {
      holding = true;
      options.held();
      return;
    }
    claiming = true;
    host.setTimeout(() => {
      claiming = false;
      if (stopped || read()?.id !== id) return;
      holding = true;
      write();
      options.held();
    }, settleMs);
  };

  const release = (): void => {
    try {
      if (holding && read()?.id === id) {
        // A lease this tab released is no claim beside the next holder's.
        wroteAt = Number.NEGATIVE_INFINITY;
        host.storage.removeItem(options.key);
      }
    } catch {
      // The lease goes stale instead.
    }
  };

  host.on('storage', (event) => {
    if (event.key !== options.key) return;
    const lease = read();
    if (lease === null || (holding && lease.id !== id)) tick();
  });
  host.on('pagehide', release);
  host.on('pageshow', (event) => {
    if (event.persisted) tick();
  });
  const timer = host.setInterval(tick, renewMs);
  tick();

  return () => {
    stopped = true;
    host.clearInterval(timer);
    release();
    holding = false;
  };
}

function browserHost(): TabLeaseHost {
  return {
    // Read at each call: a browser that refuses storage throws as `localStorage` is read.
    storage: {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
      removeItem: (key) => window.localStorage.removeItem(key),
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
    on: (type, listener) => window.addEventListener(type, listener as EventListener),
  };
}
