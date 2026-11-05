import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { nextTick, reactive, ref, watch } from 'vue';
import { HUB_ATTACH_MS, HUB_SETTLE_MS, holdsDesktopRunHub } from '../../app/utils/desktop-run-hub-hold';

/**
 * The window's hold on the stream of the desktop runs' hub, with its Nuxt auto-imports and the desktop bridge stubbed:
 * `hub` is what the window heard on the stream and `hello` plays the stream opening as `useDesktopRunHub` hears it,
 * `wanted` each `want` said, `activeCount` the window's local runs that run, `shellRuns` the shell's answer to
 * `desktop_local_runs` and `shellEvent` its `piwi:local-runs` event.
 */
async function hubHold(shellRuns: number[] = []) {
  const hub = reactive({ connected: false, sessions: {} as Record<string, unknown> });
  const wanted: boolean[] = [];
  const activeCount = ref(0);
  let localRunsListener: (event: { payload: unknown }) => void = () => {};
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('tauriCore', () => ({
    invoke: async (cmd: string) => (cmd === 'desktop_local_runs' ? shellRuns : null),
  }));
  vi.stubGlobal('tauriEvent', () => ({
    listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
      if (name === 'piwi:local-runs') localRunsListener = handler;
      return () => {};
    },
  }));
  vi.stubGlobal('useDesktopRunHub', () => ({ state: hub, want: (on: boolean) => wanted.push(on) }));
  vi.stubGlobal('useDesktopLocalRuns', () => ({ activeCount }));
  const { holdDesktopRunHub } = await import('../../app/utils/desktop-run-hub-hold');
  holdDesktopRunHub();
  await flush();
  return {
    hub,
    wanted,
    activeCount,
    /** The stream opens, as `useDesktopRunHub` hears its `hello`: connected, the runs it held emptied. */
    hello() {
      hub.connected = true;
      hub.sessions = {};
    },
    shellEvent: (ids: number[]) => localRunsListener({ payload: ids }),
  };
}

/** The promises in flight settle, then the watchers run. */
async function flush() {
  await Promise.resolve();
  await nextTick();
}

/** Lets the time pass, then the watchers run. */
async function after(ms: number) {
  vi.advanceTimersByTime(ms);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('holdsDesktopRunHub', () => {
  test('holds the stream while it opens, while a local run runs in the window or the shell, and while the hub has one', () => {
    const none = { attaching: false, activeRuns: 0, shellRuns: 0, liveRuns: 0 };
    expect(holdsDesktopRunHub({ ...none, attaching: true })).toBe(true);
    expect(holdsDesktopRunHub({ ...none, activeRuns: 1 })).toBe(true);
    expect(holdsDesktopRunHub({ ...none, shellRuns: 1 })).toBe(true);
    expect(holdsDesktopRunHub({ ...none, liveRuns: 2 })).toBe(true);
    expect(holdsDesktopRunHub(none)).toBe(false);
  });
});

describe('the window holding the stream of its runs’ hub', () => {
  test('opens it as the window starts, and keeps it while the hub has runs a reload left going', async () => {
    const { hub, wanted, hello } = await hubHold();
    expect(wanted).toEqual([true]);

    hello();
    hub.sessions = { 'desktop-3': {} };
    await after(HUB_SETTLE_MS + HUB_ATTACH_MS);
    expect(wanted).toEqual([true]);

    hub.sessions = {};
    await flush();
    expect(wanted).toEqual([true, false]);
  });

  test('keeps it while the shell runs a run a reload left, whose workers have not reached the hub', async () => {
    const { wanted, hello, shellEvent } = await hubHold([4]);
    hello();
    await after(HUB_SETTLE_MS + HUB_ATTACH_MS);
    expect(wanted).toEqual([true]);

    shellEvent([]);
    await flush();
    expect(wanted).toEqual([true, false]);
  });

  test('keeps it through a stream that opens again, while the hub tells its runs again', async () => {
    const { hub, wanted, hello } = await hubHold();
    hello();
    hub.sessions = { 'desktop-3': {} };
    await after(HUB_SETTLE_MS);

    // The stream drops and opens again: its hello empties the runs, which the hub tells again a moment later.
    hub.connected = false;
    await flush();
    hello();
    await flush();
    expect(wanted).toEqual([true]);
    await after(HUB_SETTLE_MS - 1);
    hub.sessions = { 'desktop-3': {} };
    await after(HUB_SETTLE_MS);
    expect(wanted).toEqual([true]);
  });

  test('lets it go once the hub told it has no run, and holds it again while a local run runs', async () => {
    const { wanted, activeCount, hello } = await hubHold();
    hello();
    await after(HUB_SETTLE_MS - 1);
    expect(wanted).toEqual([true]);
    await after(1);
    expect(wanted).toEqual([true, false]);

    activeCount.value = 1;
    await flush();
    expect(wanted).toEqual([true, false, true]);
    activeCount.value = 0;
    await flush();
    expect(wanted).toEqual([true, false, true, false]);
  });

  test('gives up on a stream that does not open', async () => {
    const { wanted } = await hubHold();
    await after(HUB_ATTACH_MS);
    expect(wanted).toEqual([true, false]);
  });
});

describe('the plugin that starts the hold', () => {
  async function plugin(windowLabel: string) {
    const ready = vi.fn();
    vi.stubGlobal('defineNuxtPlugin', (setup: unknown) => setup);
    vi.stubGlobal('tauriCore', () => ({ invoke: async () => null }));
    vi.stubGlobal('tauriWindowLabel', () => windowLabel);
    vi.stubGlobal('onNuxtReady', ready);
    const { default: setup } = await import('../../app/plugins/desktop-run-hub.client');
    (setup as unknown as (app: unknown) => void)({ runWithContext: (fn: () => void) => fn() });
    return ready;
  }

  test('starts it in the main window, once the app is ready', async () => {
    expect(await plugin('main')).toHaveBeenCalledTimes(1);
  });

  test('never starts it in another window of the app', async () => {
    expect(await plugin('output-run-1_1')).not.toHaveBeenCalled();
  });
});
