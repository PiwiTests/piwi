import { BUG_EVIDENCE_LIMITS, type BugConsoleEntry, type BugFailedRequest } from '@piwitests/core/bug-report';

/**
 * The messages between the main-world evidence script (`bug-evidence-main.ts`)
 * and the recorder in the isolated world, both on `window.postMessage`.
 *
 * The recorder announces the recording's token (`HELLO`); the evidence script
 * holds its entries until it has one, then sends each with it (`ENTRY`). An
 * evidence script that loads after the recorder asks for the token (`READY`).
 * A `HELLO` with a `since` time leaves out the entries held from before it:
 * they reached the report another way, or came before the replay listening
 * now. The page sees these messages too: the token keeps entries from another
 * recording or from unrelated messages out, not a page that means to add some.
 */
export const BUG_RELAY = {
  HELLO: 'piwi-bug-evidence:hello',
  READY: 'piwi-bug-evidence:ready',
  ENTRY: 'piwi-bug-evidence:entry',
} as const;

export type BugRelayEntry = { kind: 'console'; entry: BugConsoleEntry } | { kind: 'request'; entry: BugFailedRequest };

export interface RelayedEntries {
  console: BugConsoleEntry[];
  requests: BugFailedRequest[];
}

interface BugRelayMessage {
  source: typeof BUG_RELAY.ENTRY;
  token: string;
  item: BugRelayEntry;
}

/** The longest request method kept. */
const METHOD_LENGTH = 16;

/** How long the relay gathers entries before it stores them. */
const RELAY_BATCH_MS = 250;

/** The target origin for a message to this same window. */
export function ownOrigin(): string {
  return location.origin && location.origin !== 'null' ? location.origin : '*';
}

/** A relayed entry, checked field by field: the page can post anything under the same source. */
export function readRelayedEntry(data: unknown, token: string): BugRelayEntry | null {
  if (!data || typeof data !== 'object') return null;
  const msg = data as Partial<BugRelayMessage>;
  if (msg.source !== BUG_RELAY.ENTRY || msg.token !== token || !msg.item || typeof msg.item !== 'object') return null;
  const { kind, entry } = msg.item as unknown as { kind?: unknown; entry?: unknown };
  return readEntry(kind, entry);
}

/** Entries handed over in one message (a page being left), checked as relayed ones are, up to the limits. */
export function readRelayedEntries(value: unknown): RelayedEntries {
  const v = (value && typeof value === 'object' ? value : {}) as { console?: unknown; requests?: unknown };
  const list = (items: unknown, limit: number) => (Array.isArray(items) ? items.slice(0, limit) : []);
  return {
    console: list(v.console, BUG_EVIDENCE_LIMITS.console).flatMap((e) => {
      const item = readEntry('console', e);
      return item?.kind === 'console' ? [item.entry] : [];
    }),
    requests: list(v.requests, BUG_EVIDENCE_LIMITS.requests).flatMap((e) => {
      const item = readEntry('request', e);
      return item?.kind === 'request' ? [item.entry] : [];
    }),
  };
}

function readEntry(kind: unknown, value: unknown): BugRelayEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const text = (v: unknown, max: number = BUG_EVIDENCE_LIMITS.messageLength) =>
    typeof v === 'string' ? v.slice(0, max) : '';
  const time = typeof entry.time === 'number' && Number.isFinite(entry.time) ? entry.time : Date.now();
  if (kind === 'console') {
    const level = entry.level === 'warn' ? 'warn' : 'error';
    const source = entry.source === 'error' || entry.source === 'rejection' ? entry.source : 'console';
    return { kind, entry: { level, source, message: text(entry.message), page: text(entry.page), time } };
  }
  if (kind === 'request') {
    const status = typeof entry.status === 'number' && Number.isInteger(entry.status) ? entry.status : 0;
    return {
      kind,
      entry: {
        method: text(entry.method, METHOD_LENGTH).toUpperCase() || 'GET',
        url: text(entry.url),
        status,
        page: text(entry.page),
        time,
      },
    };
  }
  return null;
}

/**
 * Listens for the evidence script's entries under `token` and hands them to
 * `store` in batches, {@link RELAY_BATCH_MS} after the first of a batch, and
 * to `leave` as the page is left: a read and a write of session storage
 * started then never finish, so `leave` sends them on in one message (see
 * `storeAsPageLeaves`). With `since`, the evidence script leaves out what it
 * noted before that time. Answers the disposer, which stores what is pending
 * and stops listening; `signal` aborting does the same.
 */
export function relayEvidence(
  token: string,
  store: (entries: RelayedEntries) => Promise<void>,
  options: { since?: number; signal?: AbortSignal; leave: (entries: RelayedEntries) => void },
): () => Promise<void> {
  const pending: RelayedEntries = { console: [], requests: [] };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listening = new AbortController();

  /** What is pending, taken out of the batch; null when nothing is. */
  const take = (): RelayedEntries | null => {
    if (timer != null) clearTimeout(timer);
    timer = null;
    if (pending.console.length === 0 && pending.requests.length === 0) return null;
    return { console: pending.console.splice(0), requests: pending.requests.splice(0) };
  };
  const flush = async (): Promise<void> => {
    const entries = take();
    if (!entries) return;
    try {
      await store(entries);
    } catch {
      // Storage full: the recording itself matters more than its evidence.
    }
  };

  const hello = () => window.postMessage({ source: BUG_RELAY.HELLO, token, since: options.since }, ownOrigin());
  window.addEventListener(
    'message',
    (e: MessageEvent) => {
      if (e.source !== window) return;
      const data = e.data as { source?: unknown } | null;
      if (data?.source === BUG_RELAY.READY) return hello();
      const item = readRelayedEntry(data, token);
      if (!item) return;
      if (item.kind === 'console') pending.console.push(item.entry);
      else pending.requests.push(item.entry);
      timer ??= setTimeout(() => void flush(), RELAY_BATCH_MS);
    },
    { signal: listening.signal },
  );
  // A page left mid-batch keeps what it saw.
  window.addEventListener(
    'pagehide',
    () => {
      const entries = take();
      if (entries) options.leave(entries);
    },
    { signal: listening.signal },
  );

  const dispose = async (): Promise<void> => {
    listening.abort();
    await flush();
  };
  if (options.signal?.aborted) void dispose();
  else options.signal?.addEventListener('abort', () => void dispose(), { once: true });
  hello();
  return dispose;
}
