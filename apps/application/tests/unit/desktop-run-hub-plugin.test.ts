import { afterEach, describe, expect, test, vi } from 'vitest';
import { computed, nextTick, reactive, ref, watch } from 'vue';
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';

/**
 * The desktop window's hold on the stream of its runs' hub (`plugins/desktop-run-hub.client.ts`), whatever page and
 * layout show: what it asks of the hub (`want`, `show`) as the Local runs tray's runs, the hub's own count of its live
 * runs (`hub-runs` on the desktop event stream) and the stream's runs change, and what a stop it hears opens.
 */

interface TrayRun {
  key: number;
  kind: 'tests' | 'reproduce' | 'bisect';
  status: string;
  steps: Array<{ args: string[] }>;
  hubRefs: string[];
}

async function plugin(label: string | null = 'main') {
  const wants: boolean[] = [];
  const shows: string[][] = [];
  const notes: string[] = [];
  let stopListener: ((session: HubSession, worker: HubWorker) => void) | null = null;
  let emit: (message: Record<string, unknown>) => void = () => {};
  const runs = ref<TrayRun[]>([]);
  const holds = ref<Record<number, boolean>>({});
  const trayOpen = ref(false);
  const state = reactive<{ sessions: Record<string, HubSession> }>({ sessions: {} });
  vi.stubGlobal('defineNuxtPlugin', (setup: unknown) => setup);
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('tauriCore', () => ({ invoke: async () => null }));
  vi.stubGlobal('tauriWindowLabel', () => label);
  vi.stubGlobal('subscribeDesktopEvents', (listener: typeof emit) => {
    emit = listener;
    return () => {};
  });
  vi.stubGlobal('useDesktopLocalRuns', () => ({
    runs,
    holds,
    trayOpen,
    activeCount: computed(() => runs.value.filter((run) => run.status === 'running').length),
  }));
  const hub = {
    state,
    want: (on: boolean) => wants.push(on),
    show: (refs: Iterable<string>) => shows.push([...refs]),
    onStop: (listener: typeof stopListener) => {
      stopListener = listener;
      return () => {};
    },
  };
  const useHub = vi.fn(() => hub);
  vi.stubGlobal('useDesktopRunHub', useHub);
  vi.stubGlobal('document', { hidden: true, hasFocus: () => false });
  vi.stubGlobal(
    'Notification',
    class {
      static permission = 'granted';
      constructor(title: string, init: { body: string }) {
        notes.push(`${title} | ${init.body}`);
      }
    },
  );
  const setup = (await import('../../app/plugins/desktop-run-hub.client')).default as unknown as () => void;
  setup();
  return {
    wants,
    shows,
    notes,
    runs,
    holds,
    trayOpen,
    state,
    useHub,
    emit: (message: Record<string, unknown>) => emit(message),
    stop: (session: HubSession, worker: HubWorker) => stopListener?.(session, worker),
  };
}

function session(ref: string, workers: HubWorker[] = []): HubSession {
  return { ref, root: '/home/dev/shop', label: 'shop', command: null, project: 'Shop', workers, ended: false };
}

function stopped(reason: 'failure' | 'page-pause' | 'step'): HubWorker {
  return {
    worker: 0,
    parallelIndex: 0,
    state: 'stopped',
    test: {
      id: 't',
      title: ['checkout', 'pays'],
      uri: 'file:///home/dev/shop/tests/checkout.spec.ts',
      line: 2,
      project: 'chromium',
      retry: 0,
      cannotPause: null,
    },
    stop: {
      reason,
      title: 'Click',
      uri: 'file:///home/dev/shop/tests/checkout.spec.ts',
      line: 4,
      character: 2,
      locator: null,
      bar: false,
      since: 's1',
      intents: [],
    },
    pausing: false,
    intents: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the window’s hold on its runs’ hub', () => {
  test('re-attaches after a reload while the hub still has runs going, and lets go once it has none', async () => {
    const { wants, emit } = await plugin();
    // A reload: the tray has no run, and the stream is not open.
    expect(wants).toEqual([false]);
    emit({ type: 'hub-runs', live: 2 });
    await nextTick();
    expect(wants.at(-1)).toBe(true);
    emit({ type: 'hub-runs', live: 0 });
    await nextTick();
    expect(wants.at(-1)).toBe(false);
  });

  test('holds nothing after a reload when the hub has no run going', async () => {
    const { wants, emit } = await plugin();
    emit({ type: 'hub-runs', live: 0 });
    emit({ type: 'snapshot', runs: [] });
    await nextTick();
    expect(wants).toEqual([false]);
  });

  test('holds while a run of the tray runs or the stream still has a live one, whatever the hub said last', async () => {
    const { wants, runs, state } = await plugin();
    runs.value = [{ key: 1, kind: 'tests', status: 'running', steps: [{ args: [] }], hubRefs: ['desktop-3'] }];
    await nextTick();
    expect(wants.at(-1)).toBe(true);
    state.sessions = { 'desktop-3': session('desktop-3') };
    runs.value[0]!.status = 'passed';
    await nextTick();
    expect(wants.at(-1)).toBe(true);
    state.sessions = {};
    await nextTick();
    expect(wants.at(-1)).toBe(false);
  });

  test('says show for the running runs whose Hold failures is on, and only for them', async () => {
    const { shows, runs, holds, trayOpen } = await plugin();
    expect(shows).toEqual([[]]);
    runs.value = [
      { key: 1, kind: 'reproduce', status: 'running', steps: [{ args: [] }], hubRefs: ['desktop-5'] },
      { key: 2, kind: 'tests', status: 'running', steps: [{ args: [] }], hubRefs: ['desktop-6'] },
      { key: 3, kind: 'bisect', status: 'running', steps: [], hubRefs: ['desktop-7'] },
    ];
    await nextTick();
    expect(shows.at(-1)).toEqual(['desktop-5']);
    holds.value = { 1: false, 2: true, 3: true };
    await nextTick();
    expect(shows.at(-1)).toEqual(['desktop-6']);
    const said = shows.length;
    // The tray opening or closing says nothing again.
    trayOpen.value = true;
    await nextTick();
    trayOpen.value = false;
    await nextTick();
    expect(shows).toHaveLength(said);
  });

  test('opens the tray on each stop it hears, telling the system of a failure or a page.pause() alone', async () => {
    const { trayOpen, notes, stop } = await plugin();
    stop(session('desktop-3'), stopped('step'));
    expect(trayOpen.value).toBe(true);
    expect(notes).toEqual([]);
    trayOpen.value = false;
    stop(session('desktop-3'), stopped('failure'));
    expect(trayOpen.value).toBe(true);
    expect(notes).toEqual(['A test failed and waits | checkout › pays failed at tests/checkout.spec.ts:5.']);
  });

  test('in another window, holds for that window’s own runs alone; in a run’s output window, nothing', async () => {
    const other = await plugin('aux-1');
    other.emit({ type: 'hub-runs', live: 1 });
    await nextTick();
    expect(other.wants).toEqual([false]);
    vi.unstubAllGlobals();
    vi.resetModules();
    const output = await plugin('output-run_1');
    expect(output.useHub).not.toHaveBeenCalled();
    expect(output.wants).toEqual([]);
  });
});
