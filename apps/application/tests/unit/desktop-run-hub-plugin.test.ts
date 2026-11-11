import { afterEach, describe, expect, test, vi } from 'vitest';
import { computed, nextTick, reactive, ref, watch } from 'vue';
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';

/**
 * The desktop window's hold on the stream of its runs' hub (`plugins/desktop-run-hub.client.ts`), whatever page and
 * layout show: what it asks of the hub (`want`, `show`) as the Local runs tray's runs, the hub's own count of its live
 * runs (`hub-runs` on the desktop event stream), the stream's runs and the trays mounted change, what a stop it hears
 * opens, and which window tells the system of it.
 */

/** The app's windows' `BroadcastChannel`, in memory: a message reaches every other channel of its name. */
class FakeChannel {
  static open: FakeChannel[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  /** Its window closed: it sends nothing more. */
  gone = false;
  constructor(readonly name: string) {
    FakeChannel.open.push(this);
  }
  postMessage(data: unknown) {
    if (this.gone) return;
    const copy = JSON.parse(JSON.stringify(data)) as unknown;
    for (const other of FakeChannel.open) {
      if (other !== this && other.name === this.name) queueMicrotask(() => other.onmessage?.({ data: copy }));
    }
  }
}

/** The system notifications shown, each with the window that showed it. */
const notes: string[] = [];
/** The window whose plugin hears a stop now. */
let hearing = '';

/** Lets the windows' messages and watchers run. */
async function settle() {
  for (let i = 0; i < 3; i++) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface TrayRun {
  key: number;
  kind: 'tests' | 'reproduce' | 'bisect';
  status: string;
  steps: Array<{ args: string[] }>;
  hubRefs: string[];
  shellId: number;
  stopRequested: boolean;
}

async function plugin(label: string | null = 'main', trays = 1) {
  const wants: boolean[] = [];
  const shows: string[][] = [];
  const presents: boolean[] = [];
  const visibility = ref<'visible' | 'hidden'>('visible');
  let stopListener: ((session: HubSession, worker: HubWorker) => void) | null = null;
  let stopRunListener: ((ref: string) => void) | null = null;
  const stoppedRuns: TrayRun[] = [];
  const invoked: Array<[string, unknown]> = [];
  let emit: (message: Record<string, unknown>) => void = () => {};
  const runs = ref<TrayRun[]>([]);
  const holds = ref<Record<number, boolean>>({});
  const trayOpen = ref(false);
  const trayMounts = ref(trays);
  const state = reactive<{ sessions: Record<string, HubSession> }>({ sessions: {} });
  // The windows' claims are said again on an interval, which only a test that needs it moves on.
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('defineNuxtPlugin', (setup: unknown) => setup);
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('tauriCore', () => ({
    invoke: async (command: string, args: unknown) => {
      invoked.push([command, args]);
      return null;
    },
  }));
  vi.stubGlobal('tauriWindowLabel', () => label);
  vi.stubGlobal('subscribeDesktopEvents', (listener: typeof emit) => {
    emit = listener;
    return () => {};
  });
  vi.stubGlobal('useDesktopLocalRuns', () => ({
    runs,
    holds,
    trayOpen,
    trayMounts,
    activeCount: computed(() => runs.value.filter((run) => run.status === 'running').length),
    stopRun: async (run: TrayRun) => {
      run.stopRequested = true;
      stoppedRuns.push(run);
    },
  }));
  const hub = {
    state,
    want: (on: boolean) => wants.push(on),
    show: (refs: Iterable<string>) => shows.push([...refs]),
    present: (on: boolean) => presents.push(on),
    onStop: (listener: typeof stopListener) => {
      stopListener = listener;
      return () => {};
    },
    onStopRun: (listener: typeof stopRunListener) => {
      stopRunListener = listener;
      return () => {};
    },
  };
  const useHub = vi.fn(() => hub);
  vi.stubGlobal('useDesktopRunHub', useHub);
  vi.stubGlobal('useDocumentVisibility', () => visibility);
  vi.stubGlobal('document', { hidden: true, hasFocus: () => false });
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  vi.stubGlobal(
    'Notification',
    class {
      static permission = 'granted';
      constructor(title: string, init: { body: string }) {
        notes.push(`${hearing}: ${title} | ${init.body}`);
      }
    },
  );
  const setup = (await import('../../app/plugins/desktop-run-hub.client')).default as unknown as () => void;
  setup();
  return {
    wants,
    shows,
    presents,
    visibility,
    runs,
    holds,
    trayOpen,
    trayMounts,
    state,
    useHub,
    emit: (message: Record<string, unknown>) => emit(message),
    stop: (session: HubSession, worker: HubWorker) => {
      hearing = label ?? 'main';
      stopListener?.(session, worker);
    },
    /** Another tool asked through the hub to stop the run `ref`: the runs this window stopped, the shell's calls. */
    stopRun: (ref: string) => stopRunListener?.(ref),
    stoppedRuns,
    invoked,
  };
}

function session(ref: string, workers: HubWorker[] = []): HubSession {
  return { ref, root: '/home/dev/shop', label: 'shop', command: null, project: 'Shop', workers, ended: false };
}

function stopped(reason: 'failure' | 'page-pause' | 'step', since = 's1'): HubWorker {
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
      since,
      intents: [],
    },
    pausing: false,
    intents: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  FakeChannel.open = [];
  notes.length = 0;
});

function running(key: number, kind: TrayRun['kind'], hubRef: string): TrayRun {
  const shellId = Number(/^desktop-(\d+)/.exec(hubRef)?.[1]);
  return { key, kind, status: 'running', steps: [{ args: [] }], hubRefs: [hubRef], shellId, stopRequested: false };
}

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
    const { trayOpen, stop } = await plugin();
    stop(session('desktop-3'), stopped('step'));
    expect(trayOpen.value).toBe(true);
    expect(notes).toEqual([]);
    trayOpen.value = false;
    stop(session('desktop-3'), stopped('failure'));
    expect(trayOpen.value).toBe(true);
    expect(notes).toEqual(['main: A test failed and waits | checkout › pays failed at tests/checkout.spec.ts:5.']);
  });

  test('with no tray on the page, shows no run live and tells the system of every stop, whatever the focus', async () => {
    // An analytics dashboard in TV mode, or an error page: no layout mounts the tray.
    const { shows, presents, visibility, runs, trayMounts, trayOpen, stop } = await plugin('main', 0);
    runs.value = [running(1, 'reproduce', 'desktop-5')];
    await settle();
    expect(shows).toEqual([[]]);
    // With no tray, the window is present on no run.
    expect(presents).toEqual([false]);
    vi.stubGlobal('document', { hidden: false, hasFocus: () => true });
    stop(session('desktop-5'), stopped('step'));
    stop(session('desktop-5'), stopped('failure'));
    expect(notes).toEqual([
      'main: A test stopped and waits | checkout › pays stopped at tests/checkout.spec.ts:5.',
      'main: A test failed and waits | checkout › pays failed at tests/checkout.spec.ts:5.',
    ]);
    expect(trayOpen.value).toBe(true);
    // Back on a page with the tray: its run is shown live again, and a stop is said in the window alone.
    trayMounts.value = 1;
    await settle();
    expect(shows.at(-1)).toEqual(['desktop-5']);
    stop(session('desktop-5'), stopped('failure'));
    expect(notes).toHaveLength(2);
    // Present while the tray shows the runs and the window is not hidden.
    expect(presents).toEqual([false, true]);
    visibility.value = 'hidden';
    await settle();
    expect(presents).toEqual([false, true, false]);
  });

  test('in another window, holds for that window’s own runs alone; in a run’s output window, nothing', async () => {
    const other = await plugin('aux-1');
    other.emit({ type: 'hub-runs', live: 1 });
    await settle();
    expect(other.wants).toEqual([false]);
    other.runs.value = [running(1, 'tests', 'desktop-9')];
    await settle();
    expect(other.wants.at(-1)).toBe(true);
    vi.unstubAllGlobals();
    vi.resetModules();
    const output = await plugin('output-run_1');
    expect(output.useHub).not.toHaveBeenCalled();
    expect(output.wants).toEqual([]);
  });

  test('tells the system of a stop once: from the window whose tray owns its run, else the dashboard window', async () => {
    const aux = await plugin('aux-1');
    aux.runs.value = [running(1, 'tests', 'desktop-9')];
    await settle();
    // The dashboard window opens after it, as after a reload: it asks the others what their trays own.
    const main = await plugin('main');
    main.runs.value = [running(1, 'tests', 'desktop-4')];
    await settle();
    for (const ref of ['desktop-9-unattended', 'desktop-4', 'desktop-3']) {
      for (const window of [aux, main]) window.stop(session(ref), stopped('failure'));
    }
    expect(notes.map((note) => note.split(' | ')[0])).toEqual([
      'aux-1: A test failed and waits',
      'main: A test failed and waits',
      'main: A test failed and waits',
    ]);
  });

  test('stops a run another tool asks to stop once: in the window whose tray owns it, else through the shell', async () => {
    const aux = await plugin('aux-1');
    aux.runs.value = [running(1, 'tests', 'desktop-9')];
    await settle();
    const main = await plugin('main');
    main.runs.value = [running(2, 'tests', 'desktop-4')];
    await settle();
    for (const ref of ['desktop-9-unattended', 'desktop-4', 'desktop-3']) {
      for (const window of [aux, main]) window.stopRun(ref);
    }
    // Each window stopped its own run as its Stop does; the run no tray owns, the dashboard window had the shell stop.
    expect(aux.stoppedRuns.map((run) => run.key)).toEqual([1]);
    expect(main.stoppedRuns.map((run) => run.key)).toEqual([2]);
    expect(aux.invoked).toEqual([]);
    expect(main.invoked).toEqual([['desktop_stop_local_tests', { runId: 3 }]]);
    // Asked again while they stop: neither is stopped twice, which the shell would take as a force stop.
    for (const ref of ['desktop-4', 'desktop-3']) main.stopRun(ref);
    expect(main.stoppedRuns).toHaveLength(1);
    expect(main.invoked).toHaveLength(1);
  });

  test('stops a run of several steps only through the step it runs now, never an earlier one that ended', async () => {
    const main = await plugin('main');
    // Its first step, `desktop-5`, ended; its second, `desktop-6`, runs now.
    main.runs.value = [{ ...running(1, 'tests', 'desktop-6'), hubRefs: ['desktop-5', 'desktop-6'] }];
    await settle();
    main.stopRun('desktop-5');
    expect(main.stoppedRuns).toEqual([]);
    expect(main.invoked).toEqual([]);
    main.stopRun('desktop-6');
    expect(main.stoppedRuns.map((run) => run.key)).toEqual([1]);
  });

  test('lets a window’s claim on its runs lapse once it stops saying it, as a window that closed unheard', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const aux = await plugin('aux-1');
    aux.runs.value = [running(1, 'tests', 'desktop-9')];
    const main = await plugin('main');
    await settle();
    // Said again every few seconds, the claim holds.
    vi.advanceTimersByTime(30_000);
    await settle();
    main.stop(session('desktop-9'), stopped('failure'));
    expect(notes).toEqual([]);
    // The window closes without a word: its claim lapses, and the dashboard window tells of the run's stops.
    FakeChannel.open[0]!.gone = true;
    vi.advanceTimersByTime(20_000);
    await settle();
    main.stop(session('desktop-9'), stopped('failure'));
    expect(notes.map((note) => note.split(' | ')[0])).toEqual(['main: A test failed and waits']);
  });

  test('after a reload, opens the tray on a stop from before it but does not tell the system again', async () => {
    const { trayOpen, stop } = await plugin();
    stop(session('desktop-3'), stopped('page-pause', new Date(Date.now() - 60_000).toISOString()));
    expect(trayOpen.value).toBe(true);
    expect(notes).toEqual([]);
    stop(session('desktop-3'), stopped('failure', new Date(Date.now() + 1000).toISOString()));
    expect(notes.map((note) => note.split(' | ')[0])).toEqual(['main: A test failed and waits']);
  });
});
