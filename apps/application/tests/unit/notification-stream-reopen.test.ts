import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The browser notifications' stream opens again after an error answer closed it (a proxy's 502 while the instance
 * restarts, an expired session), waiting longer each time.
 */

vi.mock('../../app/composables/useDiagnosisNotification', () => ({
  useDiagnosisNotification: () => ({ enabled: { value: true } }),
}));
vi.mock('../../app/composables/useBrowserNotificationCookie', () => ({
  useBrowserNotificationCookie: () => ({ isEventSubscribed: () => true }),
}));
vi.mock('~/demo/run-events', () => ({ subscribeDemoEvents: () => () => {} }));

/** The lease of the notification stream, as the test hands it to the tab or takes it back. */
const lease = vi.hoisted(() => ({ held: () => {}, lost: () => {} }));
vi.mock('~/utils/tab-lease', () => ({
  holdInOneTab: (options: { held: () => void; lost: () => void }) => {
    lease.held = options.held;
    lease.lost = options.lost;
    options.held();
    return () => {};
  },
}));

/** The browser's EventSource, played by the test. */
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
  close() {
    this.closed = true;
    this.readyState = FakeSource.CLOSED;
  }
}

beforeEach(() => {
  FakeSource.all = [];
  vi.useFakeTimers();
  vi.stubGlobal('__IMPORT_META_CLIENT__', true);
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('window', { addEventListener: () => {} });
  vi.stubGlobal('document', { hasFocus: () => true, visibilityState: 'visible' });
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: false, authEnabled: false }, app: { baseURL: '/' } }));
  vi.stubGlobal('useRouter', () => ({ push: () => {} }));
  vi.stubGlobal('useIsDesktop', () => false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function start() {
  vi.resetModules();
  const { useNotificationStream } = await import('../../app/composables/useNotificationStream');
  useNotificationStream();
  await vi.waitFor(() => expect(FakeSource.all).toHaveLength(1));
}

describe('the notification stream', () => {
  test('closes in a tab that lost the lease, and opens again in one that holds it', async () => {
    await start();
    FakeSource.all[0]!.open();
    lease.lost();
    expect(FakeSource.all[0]!.closed).toBe(true);
    lease.held();
    expect(FakeSource.all).toHaveLength(2);
    expect(FakeSource.all[1]!.closed).toBe(false);
  });

  test('opens again after an error answer, waiting longer each time until one opens', async () => {
    await start();
    expect(FakeSource.all[0]!.url).toBe('/api/notifications/stream');
    FakeSource.all[0]!.refuse();
    expect(FakeSource.all[0]!.closed).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(FakeSource.all).toHaveLength(2);

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
});
