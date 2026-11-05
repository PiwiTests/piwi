import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { nextTick, reactive, ref, watch } from 'vue';
import { HUB_ATTACH_MS, HUB_SETTLE_MS, holdsDesktopRunHub } from '../../app/utils/desktop-run-view';

/**
 * The plugin that holds the stream of the desktop runs' hub, with its Nuxt auto-imports and the desktop bridge
 * stubbed: `hub` is what the window heard on the stream, `wanted` each `want` the plugin said, `activeCount` the
 * window's local runs that run.
 */
async function hubPlugin(windowLabel = 'main') {
  const hub = reactive({ connected: false, sessions: {} as Record<string, unknown> });
  const wanted: boolean[] = [];
  const activeCount = ref(0);
  vi.stubGlobal('defineNuxtPlugin', (setup: () => void) => setup);
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('onNuxtReady', (callback: () => void) => callback());
  vi.stubGlobal('tauriCore', () => ({ invoke: async () => null }));
  vi.stubGlobal('tauriWindowLabel', () => windowLabel);
  vi.stubGlobal('useDesktopRunHub', () => ({ state: hub, want: (on: boolean) => wanted.push(on) }));
  vi.stubGlobal('useDesktopLocalRuns', () => ({ activeCount }));
  const { default: setup } = await import('../../app/plugins/desktop-run-hub.client');
  (setup as unknown as () => void)();
  return { hub, wanted, activeCount };
}

/** Lets the time pass, then the watchers run. */
async function after(ms: number) {
  vi.advanceTimersByTime(ms);
  await nextTick();
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
  test('holds the stream as the window starts, while a local run runs, and while the hub has a live run', () => {
    expect(holdsDesktopRunHub({ attaching: true, activeRuns: 0, liveRuns: 0 })).toBe(true);
    expect(holdsDesktopRunHub({ attaching: false, activeRuns: 1, liveRuns: 0 })).toBe(true);
    expect(holdsDesktopRunHub({ attaching: false, activeRuns: 0, liveRuns: 2 })).toBe(true);
    expect(holdsDesktopRunHub({ attaching: false, activeRuns: 0, liveRuns: 0 })).toBe(false);
  });
});

describe('the window holding the stream of its runs’ hub', () => {
  test('opens it as the window starts, and keeps it while the hub has runs a reload left going', async () => {
    const { hub, wanted } = await hubPlugin();
    expect(wanted).toEqual([true]);

    hub.connected = true;
    hub.sessions = { 'desktop-3': {} };
    await nextTick();
    await after(HUB_SETTLE_MS + HUB_ATTACH_MS);
    expect(wanted).toEqual([true]);

    hub.sessions = {};
    await nextTick();
    expect(wanted).toEqual([true, false]);
  });

  test('lets it go once the hub told it has no run, and holds it again while a local run runs', async () => {
    const { hub, wanted, activeCount } = await hubPlugin();
    hub.connected = true;
    await nextTick();
    await after(HUB_SETTLE_MS - 1);
    expect(wanted).toEqual([true]);
    await after(1);
    expect(wanted).toEqual([true, false]);

    activeCount.value = 1;
    await nextTick();
    expect(wanted).toEqual([true, false, true]);
    activeCount.value = 0;
    await nextTick();
    expect(wanted).toEqual([true, false, true, false]);
  });

  test('gives up on a stream that does not open', async () => {
    const { wanted } = await hubPlugin();
    await after(HUB_ATTACH_MS);
    expect(wanted).toEqual([true, false]);
  });

  test('is held by the main window alone', async () => {
    const { wanted, activeCount } = await hubPlugin('output-run-1_1');
    activeCount.value = 1;
    await after(HUB_ATTACH_MS);
    expect(wanted).toEqual([]);
  });
});
