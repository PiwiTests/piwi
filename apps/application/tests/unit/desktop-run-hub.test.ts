import { afterEach, describe, expect, test, vi } from 'vitest';
import { reactive } from 'vue';

const REF = 'desktop-41';
const TEST = {
  id: 't1',
  title: ['checkout', 'pays'],
  uri: 'file:///home/dev/acme/tests/checkout.spec.ts',
  line: 2,
  project: 'chromium',
  retry: 0,
  cannotPause: null,
};
const RUNNING = { worker: 0, parallelIndex: 0, state: 'running', test: TEST, stop: null, pausing: false, intents: [] };

function stopped(since: string) {
  return {
    ...RUNNING,
    state: 'stopped',
    stop: {
      reason: 'page-pause',
      title: "Click getByRole('button', { name: 'Pay' })",
      uri: TEST.uri,
      line: 4,
      character: 2,
      locator: "getByRole('button', { name: 'Pay' })",
      bar: false,
      since,
      intents: ['view'],
    },
  };
}

function session(worker: Record<string, unknown>, ended = false) {
  return {
    type: 'session',
    session: {
      ref: REF,
      root: '/home/dev/acme',
      label: 'acme',
      command: null,
      project: 'Acme',
      workers: [worker],
      ended,
    },
  };
}

/**
 * The window's side of the desktop runs' hub with its Nuxt auto-imports stubbed, its stream an EventSource the test
 * speaks on (`send`).
 */
async function runHub() {
  const streams: Array<{ onmessage: ((event: { data: string }) => void) | null; close(): void }> = [];
  class FakeEventSource {
    static CLOSED = 2;
    readyState = 1;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      streams.push(this);
    }
    close() {
      this.readyState = 2;
    }
  }
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('reactive', reactive);
  vi.stubGlobal('useToast', () => ({ add: () => {} }));
  vi.stubGlobal('$fetch', async () => ({ type: 'answer', id: 1, ok: true, message: '' }));
  const { useDesktopRunHub } = await import('../../app/composables/useDesktopRunHub');
  const hub = useDesktopRunHub();
  hub.want(true);
  return {
    hub,
    send: (message: unknown) => streams.at(-1)?.onmessage?.({ data: JSON.stringify(message) }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the stops the window hears', () => {
  test('a stop heard while no tray listens goes to the next one to listen, once', async () => {
    const { hub, send } = await runHub();
    send({ type: 'hello', viewer: 'f'.repeat(32) });
    send(session(stopped('s1')));

    const first = vi.fn();
    hub.onStop(first);
    expect(first).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]![1]).toMatchObject({ worker: 0, stop: { since: 's1' } });

    const second = vi.fn();
    hub.onStop(second);
    expect(second).not.toHaveBeenCalled();
  });

  test('a stop the worker left before anyone listened is not given', async () => {
    const { hub, send } = await runHub();
    send({ type: 'hello', viewer: 'f'.repeat(32) });
    send(session(stopped('s1')));
    send(session(RUNNING));

    const listener = vi.fn();
    hub.onStop(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  test('a stop heard while a tray listens is not given again to the next one', async () => {
    const { hub, send } = await runHub();
    const mounted = vi.fn();
    const unsubscribe = hub.onStop(mounted);
    send({ type: 'hello', viewer: 'f'.repeat(32) });
    send(session(stopped('s1')));
    expect(mounted).toHaveBeenCalledTimes(1);
    unsubscribe();

    const next = vi.fn();
    hub.onStop(next);
    expect(next).not.toHaveBeenCalled();
  });
});
