import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DemoEventMessage } from '../../app/demo/run-events';

/**
 * A run page opened while its run initializes refetches the run once it starts, so the page goes live without a
 * reload: on the run's lifecycle events, and each time the shared stream opens, for an event sent while it was closed.
 */

const { unmounts, demo } = vi.hoisted(() => ({
  unmounts: [] as Array<() => void>,
  demo: { handler: null as ((message: DemoEventMessage) => void) | null },
}));

vi.mock('vue', () => ({ onUnmounted: (fn: () => void) => unmounts.push(fn) }));

vi.mock('~/demo/run-events', () => ({
  subscribeDemoEvents: (handler: (message: DemoEventMessage) => void) => {
    demo.handler = handler;
    return () => (demo.handler = null);
  },
}));

/** The browser's EventSource on `/api/stream`, played by the test. */
class FakeSource {
  static OPEN = 1;
  static all: FakeSource[] = [];
  readyState = 0;
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
  send(event: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

const documentListeners: Record<string, () => void> = {};
const page = { visibilityState: 'visible' as DocumentVisibilityState };

function stubBrowser(demoMode = false) {
  vi.stubGlobal('__IMPORT_META_CLIENT__', true);
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode } }));
  vi.stubGlobal('window', { addEventListener: () => {} });
  vi.stubGlobal('document', {
    get visibilityState() {
      return page.visibilityState;
    },
    addEventListener: (type: string, fn: () => void) => (documentListeners[type] = fn),
  });
}

/** The run page's run, as it last fetched it, and its refetches. */
function runPage(status: string) {
  const run = { status, refetches: 0 };
  return {
    run,
    status: () => run.status,
    refresh: async () => {
      run.refetches++;
    },
  };
}

async function composables() {
  vi.resetModules();
  return import('../../app/composables/useRunStream');
}

beforeEach(() => {
  FakeSource.all = [];
  unmounts.length = 0;
  demo.handler = null;
  page.visibilityState = 'visible';
});

afterEach(() => vi.unstubAllGlobals());

describe('useRunStart', () => {
  test('refetches an initializing run once the stream opens, and on its run-started', async () => {
    stubBrowser();
    const { useRunStart } = await composables();
    const { run, status, refresh } = runPage('initializing');
    useRunStart(7, status, refresh);

    const source = FakeSource.all[0]!;
    expect(source.url).toBe('/api/stream');
    // The page's own fetch is fresh until the stream listens.
    expect(run.refetches).toBe(0);
    // From then on no event is missed: one sent before it opened is read with the run.
    source.open();
    expect(run.refetches).toBe(1);

    source.send({ type: 'run-started', runId: 8, projectId: 1 });
    expect(run.refetches).toBe(1);
    source.send({ type: 'run-started', runId: 7, projectId: 1 });
    expect(run.refetches).toBe(2);
  });

  test('refetches on a cancel or an end before the run began, and on nothing once it is live', async () => {
    stubBrowser();
    const { useRunStart } = await composables();
    const { run, status, refresh } = runPage('initializing');
    useRunStart(7, status, refresh);
    const source = FakeSource.all[0]!;

    source.send({ type: 'run-finished', runId: 7, projectId: 1, status: 'interrupted' });
    expect(run.refetches).toBe(1);

    run.status = 'running';
    source.open();
    source.send({ type: 'run-finalizing', runId: 7, projectId: 1 });
    source.send({ type: 'run-finished', runId: 7, projectId: 1, status: 'passed' });
    expect(run.refetches).toBe(1);
  });

  test('catches a start while the tab was hidden as the stream opens again', async () => {
    stubBrowser();
    const { useRunStart } = await composables();
    const { run, status, refresh } = runPage('initializing');
    useRunStart(7, status, refresh);
    FakeSource.all[0]!.open();
    expect(run.refetches).toBe(1);

    page.visibilityState = 'hidden';
    documentListeners.visibilitychange!();
    expect(FakeSource.all[0]!.closed).toBe(true);
    // The run starts now: the closed stream never hears it.

    page.visibilityState = 'visible';
    documentListeners.visibilitychange!();
    const reopened = FakeSource.all[1]!;
    expect(run.refetches).toBe(1);
    reopened.open();
    expect(run.refetches).toBe(2);
  });

  test('refetches at once on a stream another component holds open', async () => {
    stubBrowser();
    const { useRunEvents, useRunStart } = await composables();
    useRunEvents(() => {});
    FakeSource.all[0]!.open();

    const { run, status, refresh } = runPage('initializing');
    useRunStart(7, status, refresh);
    expect(FakeSource.all).toHaveLength(1);
    expect(run.refetches).toBe(1);

    const live = runPage('running');
    useRunStart(9, live.status, live.refresh);
    expect(live.run.refetches).toBe(0);
  });

  test('stops refetching when the page leaves, and closes the stream when nothing listens', async () => {
    stubBrowser();
    const { useRunStart } = await composables();
    const { run, status, refresh } = runPage('initializing');
    useRunStart(7, status, refresh);
    const source = FakeSource.all[0]!;

    for (const unmount of unmounts) unmount();
    expect(source.closed).toBe(true);
    source.open();
    source.send({ type: 'run-started', runId: 7, projectId: 1 });
    expect(run.refetches).toBe(0);
  });

  test('in the demo, refetches at once and on the run-started the service worker broadcasts', async () => {
    stubBrowser(true);
    const { useRunStart } = await composables();
    const { run, status, refresh } = runPage('initializing');
    useRunStart(7, status, refresh);

    expect(FakeSource.all).toHaveLength(0);
    // The demo's channel listens as soon as it subscribes.
    expect(run.refetches).toBe(1);

    demo.handler!({ scope: 'run', runId: 7, event: { type: 'run-progress', data: {} } });
    demo.handler!({ scope: 'global', event: { type: 'run-started', runId: 8, projectId: 1 } });
    expect(run.refetches).toBe(1);
    demo.handler!({ scope: 'global', event: { type: 'run-started', runId: 7, projectId: 1 } });
    expect(run.refetches).toBe(2);
  });
});
