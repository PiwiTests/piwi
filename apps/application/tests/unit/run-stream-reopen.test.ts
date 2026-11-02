import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The shared run stream opens again after an error answer closed it (a proxy's 502 while the instance restarts, an
 * expired session), waiting longer each time, and its subscribers read again once it is open.
 */

const { unmounts } = vi.hoisted(() => ({ unmounts: [] as Array<() => void> }));

vi.mock('vue', () => ({ onUnmounted: (fn: () => void) => unmounts.push(fn) }));
vi.mock('~/demo/run-events', () => ({ subscribeDemoEvents: () => () => {} }));

/** The browser's EventSource on `/api/stream`, played by the test. */
class FakeSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static all: FakeSource[] = [];
  readyState = FakeSource.CONNECTING;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  open() {
    this.readyState = FakeSource.OPEN;
    this.onopen?.();
  }
  /** An error answer: the browser closes the stream for good. */
  refuse() {
    this.readyState = FakeSource.CLOSED;
    this.onerror?.();
  }
  /** A dropped connection: the browser reconnects by itself. */
  drop() {
    this.readyState = FakeSource.CONNECTING;
    this.onerror?.();
  }
  close() {
    this.closed = true;
    this.readyState = FakeSource.CLOSED;
  }
}

const documentListeners: Record<string, () => void> = {};
const page = { visibilityState: 'visible' as DocumentVisibilityState };

function stubBrowser() {
  vi.stubGlobal('__IMPORT_META_CLIENT__', true);
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: false } }));
  vi.stubGlobal('window', { addEventListener: () => {} });
  vi.stubGlobal('document', {
    get visibilityState() {
      return page.visibilityState;
    },
    addEventListener: (type: string, fn: () => void) => (documentListeners[type] = fn),
  });
}

async function subscribe() {
  vi.resetModules();
  const { useRunStream } = await import('../../app/composables/useRunStream');
  const reads = { count: 0 };
  useRunStream(async () => {
    reads.count++;
  });
  return reads;
}

beforeEach(() => {
  FakeSource.all = [];
  unmounts.length = 0;
  page.visibilityState = 'visible';
  vi.useFakeTimers();
  stubBrowser();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the shared run stream', () => {
  test('opens again after an error answer, and its subscribers read again once it is open', async () => {
    const reads = await subscribe();
    FakeSource.all[0]!.open();
    FakeSource.all[0]!.refuse();
    expect(FakeSource.all[0]!.closed).toBe(true);

    vi.advanceTimersByTime(2_000);
    expect(FakeSource.all).toHaveLength(2);
    expect(reads.count).toBe(0);
    FakeSource.all[1]!.open();
    expect(reads.count).toBe(1);
  });

  test('waits longer after each refusal, and as little again once a stream opens', async () => {
    await subscribe();
    FakeSource.all[0]!.refuse();
    vi.advanceTimersByTime(2_000);
    FakeSource.all[1]!.refuse();
    vi.advanceTimersByTime(2_000);
    expect(FakeSource.all).toHaveLength(2);
    vi.advanceTimersByTime(2_000);
    expect(FakeSource.all).toHaveLength(3);

    FakeSource.all[2]!.open();
    FakeSource.all[2]!.refuse();
    vi.advanceTimersByTime(2_000);
    expect(FakeSource.all).toHaveLength(4);
  });

  test('leaves a dropped connection to the browser, which reconnects by itself', async () => {
    await subscribe();
    FakeSource.all[0]!.open();
    FakeSource.all[0]!.drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.all).toHaveLength(1);
    expect(FakeSource.all[0]!.closed).toBe(false);
  });

  test('opens no stream for a page that left, nor for a hidden tab', async () => {
    await subscribe();
    FakeSource.all[0]!.refuse();
    for (const unmount of unmounts) unmount();
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.all).toHaveLength(1);

    await subscribe();
    FakeSource.all[1]!.refuse();
    page.visibilityState = 'hidden';
    documentListeners.visibilitychange!();
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.all).toHaveLength(2);
    page.visibilityState = 'visible';
    documentListeners.visibilitychange!();
    expect(FakeSource.all).toHaveLength(3);
  });
});
