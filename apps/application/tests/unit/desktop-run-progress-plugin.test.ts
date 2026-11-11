import { afterEach, describe, expect, test, vi } from 'vitest';
import { nextTick, reactive, ref, watch } from 'vue';

/**
 * The desktop shell's OS progress (`plugins/desktop-run-progress.client.ts`), driven as the window drives it: the
 * messages of the desktop event stream, and the Local runs tray's runs as the store says each one ends
 * (`onRunEnded`). What it asks the shell to show is each `desktop_set_run_progress` it sends; a red `error` without
 * `failing` is the failed end the shell asks for the user's attention on.
 */

interface Shown {
  state: string;
  fraction: number | null;
  label: string | null;
  failing: boolean;
}

/** A run of the Local runs tray, as far as the plugin reads it. */
interface TrayRun {
  key: number;
  kind: 'tests' | 'reproduce' | 'repro' | 'bisect' | 'flake';
  status: 'running' | 'passed' | 'failed' | 'stopped' | 'error';
  projectId: string;
  originRef: string | null;
  hubRefs: string[];
  piwiRunBaseline: number | null;
  flakeTestCaseId: number | null;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  phase: string | null;
  bisect: { firstBad: { sha: string } | null } | null;
  repro: null;
}

async function plugin() {
  const shown: Shown[] = [];
  let emit: (message: Record<string, unknown>) => void = () => {};
  const ended = new Set<(run: TrayRun) => void>();
  const runs = ref<TrayRun[]>([]);
  const hub = { state: reactive<{ sessions: Record<string, unknown> }>({ sessions: {} }) };
  vi.stubGlobal('defineNuxtPlugin', (setup: unknown) => setup);
  vi.stubGlobal('useDesktopRunHub', () => hub);
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('tauriCore', () => ({
    invoke: async (cmd: string, args: Shown) => {
      if (cmd === 'desktop_set_run_progress') shown.push(args);
    },
  }));
  vi.stubGlobal('tauriEvent', () => ({ listen: async () => () => {} }));
  vi.stubGlobal('subscribeDesktopEvents', (listener: typeof emit) => {
    emit = listener;
    return () => {};
  });
  vi.stubGlobal('useDesktopLocalRuns', () => ({
    runs,
    stopRun: async () => {},
    onRunEnded: (listener: (run: TrayRun) => void) => {
      ended.add(listener);
      return () => ended.delete(listener);
    },
  }));
  const setup = (await import('../../app/plugins/desktop-run-progress.client')).default as unknown as () => void;
  setup();
  return {
    shown,
    runs,
    hub,
    emit: (message: Record<string, unknown>) => emit(message),
    /** The store says the run ended, with these fields set. */
    end: (run: TrayRun, over: Partial<TrayRun>) => {
      Object.assign(run, { finishedAt: Date.now(), ...over });
      for (const listener of ended) listener(run);
    },
  };
}

/** What the messages of a run say of what launched it, once it began. */
const BISECT_STEP = { projectId: 1, origin: 'bisect', originRef: '37', name: 'desktop-6-unattended', job: true };

function trayRun(over: Partial<TrayRun>): TrayRun {
  return {
    key: 1,
    kind: 'tests',
    status: 'running',
    projectId: '1',
    originRef: 'desktop:a1',
    hubRefs: ['desktop-7'],
    piwiRunBaseline: 4,
    flakeTestCaseId: null,
    startedAt: Date.now() - 1000,
    finishedAt: null,
    exitCode: null,
    phase: null,
    bisect: null,
    repro: null,
    ...over,
  };
}

/** A failed end the shell asks for attention on. */
const failedEnds = (shown: Shown[]) => shown.filter((s) => s.state === 'error' && !s.failing);

/** An outcome shown once nothing runs. */
const flashes = (shown: Shown[]) => shown.filter((s) => s.state !== 'none' && !s.label?.startsWith('Running'));

const NOTHING = { state: 'none', fraction: null, label: null, failing: false };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the OS progress of a job of the Local runs tray', () => {
  test('shows a bisect’s steps as progress, each bad one with no flash, and flashes its verdict once', async () => {
    const { shown, runs, emit, end } = await plugin();
    emit({ type: 'snapshot', runs: [] });
    runs.value = [trayRun({ kind: 'bisect', originRef: '37', hubRefs: ['desktop-6'] })];

    for (const [index, runId] of [5, 6, 7].entries()) {
      emit({ type: 'run-initializing', runId, projectId: 1 });
      emit({ type: 'run-started', runId, ...BISECT_STEP });
      const counts = { totalTests: 2, passedTests: 1, failedTests: 1, skippedTests: 0, didNotRunTests: 0 };
      emit({ type: 'run-progress', runId, ...counts, ...BISECT_STEP });
      // A bad step: its failure turns nothing red.
      expect(shown.at(-1)).toEqual({ state: 'normal', fraction: 1, label: 'Running 2/2…', failing: false });
      emit({ type: 'run-finished', runId, status: 'failed', ...BISECT_STEP });
      expect(shown.at(-1), `step ${index + 1}`).toEqual(NOTHING);
    }
    expect(failedEnds(shown)).toEqual([]);

    // The bisect names its first bad commit and its process ends: one flash.
    end(runs.value[0]!, { status: 'passed', exitCode: 0, bisect: { firstBad: { sha: 'abcdef1234567' } } });
    expect(flashes(shown)).toEqual([{ state: 'normal', fraction: 1, label: 'Bisect found abcdef1', failing: false }]);
  });

  test('flashes a reproduction that reproduced once, red, when its process ends, never at its run’s end', async () => {
    const { shown, runs, emit, end } = await plugin();
    const step = { projectId: 1, origin: 'reproduce', originRef: '42', name: 'desktop-3', job: true };
    runs.value = [trayRun({ kind: 'reproduce', originRef: '42', hubRefs: ['desktop-3'] })];
    emit({ type: 'run-started', runId: 9, ...step });
    emit({ type: 'run-finished', runId: 9, status: 'failed', ...step });
    expect(failedEnds(shown)).toEqual([]);
    end(runs.value[0]!, { status: 'failed', exitCode: 1, phase: 'test' });
    expect(failedEnds(shown)).toEqual([{ state: 'error', fraction: 1, label: 'Reproduced', failing: false }]);
  });

  test('flashes its verdict even while its own step is still finalizing on the server', async () => {
    const { shown, runs, emit, end } = await plugin();
    runs.value = [trayRun({ kind: 'bisect', originRef: '37', hubRefs: ['desktop-6'] })];
    emit({ type: 'run-started', runId: 5, ...BISECT_STEP });
    emit({ type: 'run-finalizing', runId: 5, status: 'failed', ...BISECT_STEP });
    end(runs.value[0]!, { status: 'failed', exitCode: 1, bisect: { firstBad: null } });
    expect(shown.at(-1)).toEqual({ state: 'error', fraction: 1, label: 'Bisect did not finish', failing: false });
    // Its step's end, heard later, changes nothing.
    emit({ type: 'run-finished', runId: 5, status: 'failed', ...BISECT_STEP });
    expect(shown.at(-1)?.label).toBe('Bisect did not finish');
  });

  test('flashes its verdict when a step whose global setup failed never began', async () => {
    const { shown, runs, emit, end } = await plugin();
    runs.value = [trayRun({ kind: 'bisect', originRef: '37', hubRefs: ['desktop-6'] })];
    emit({ type: 'run-initializing', runId: 5, projectId: 1 });
    end(runs.value[0]!, { status: 'failed', exitCode: 1, bisect: { firstBad: null } });
    expect(shown.at(-1)).toEqual({ state: 'error', fraction: 1, label: 'Bisect did not finish', failing: false });
  });

  test('flashes the verdict of a job the tray has already dropped, as the store says it ended', async () => {
    const { shown, runs, end } = await plugin();
    const bisect = trayRun({ kind: 'bisect', originRef: '37', hubRefs: ['desktop-6'] });
    // Fifteen newer runs ended first: the tray keeps no more, and drops the bisect as it ends.
    runs.value = [];
    end(bisect, { status: 'passed', exitCode: 0, bisect: { firstBad: { sha: 'abcdef1234567' } } });
    expect(flashes(shown)).toEqual([{ state: 'normal', fraction: 1, label: 'Bisect found abcdef1', failing: false }]);
  });

  test('flashes a run of the tray as its outcome, never an editor’s or CI’s, which it shows running alone', async () => {
    const { shown, runs, emit } = await plugin();
    const ci = { projectId: 1, origin: 'ci', originRef: null, name: null, job: false };
    emit({ type: 'run-started', runId: 11, ...ci });
    expect(shown.at(-1)?.label).toBe('Running…');
    emit({ type: 'run-finished', runId: 11, status: 'failed', ...ci });
    expect(failedEnds(shown)).toEqual([]);
    expect(shown.at(-1)).toEqual(NOTHING);
    const own = { projectId: 1, origin: 'desktop', originRef: 'desktop:a1', name: 'desktop-7', job: false };
    runs.value = [trayRun({ key: 1, hubRefs: ['desktop-7'] })];
    emit({ type: 'run-started', runId: 12, ...own });
    emit({ type: 'run-finished', runId: 12, status: 'failed', ...own });
    expect(failedEnds(shown)).toEqual([{ state: 'error', fraction: 1, label: 'Run failed', failing: false }]);
  });

  test('says first that a test of the app’s runs waits for the person, amber, as the hub tells it', async () => {
    const { shown, hub, emit } = await plugin();
    emit({
      type: 'run-progress',
      runId: 13,
      projectId: 1,
      totalTests: 10,
      passedTests: 3,
      failedTests: 0,
      skippedTests: 0,
      didNotRunTests: 0,
    });
    expect(shown.at(-1)?.label).toBe('Running 3/10…');
    const stopped = { state: 'stopped', stop: { reason: 'pause' } };
    hub.state.sessions = { 'desktop-7': { ended: false, workers: [stopped] } };
    await nextTick();
    expect(shown.at(-1)).toEqual({
      state: 'paused',
      fraction: 0.3,
      label: '1 test waits for you · Running 3/10',
      failing: false,
    });
    // Answered: the run runs on, as it did.
    hub.state.sessions = { 'desktop-7': { ended: false, workers: [{ state: 'running', stop: null }] } };
    await nextTick();
    expect(shown.at(-1)?.label).toBe('Running 3/10…');
  });

  test('flashes nothing for a run nothing names, one that never began, when the server ends it', async () => {
    const { shown, emit } = await plugin();
    emit({ type: 'run-initializing', runId: 12, projectId: 1 });
    emit({ type: 'run-finished', runId: 12, projectId: 1, status: 'interrupted' });
    expect(flashes(shown)).toEqual([]);
    expect(shown.at(-1)).toEqual(NOTHING);
  });
});

describe('a local run stopped from the app', () => {
  const counts = { totalTests: 10, passedTests: 1, failedTests: 0, skippedTests: 0, didNotRunTests: 0 };

  test('takes its own runs off the bar, and leaves an editor’s, CI’s and another local run’s', async () => {
    const { shown, runs, emit, end } = await plugin();
    const own = { projectId: 1, origin: 'desktop', originRef: 'desktop:a1', name: 'desktop-7', job: false };
    const editor = { projectId: 1, origin: 'editor', originRef: 'editor:x', name: null, job: false };
    const other = { projectId: 1, origin: 'desktop', originRef: 'desktop:b2', name: 'desktop-8', job: false };
    const ci = { projectId: 1, origin: 'ci', originRef: null, name: null, job: false };
    runs.value = [
      trayRun({ key: 1, hubRefs: ['desktop-7'] }),
      trayRun({ key: 2, originRef: 'desktop:b2', hubRefs: ['desktop-8'] }),
    ];
    for (const [runId, facts] of [
      [5, own],
      [6, editor],
      [7, other],
      [8, ci],
    ] as const) {
      emit({ type: 'run-progress', runId, ...counts, ...facts });
    }
    expect(shown.at(-1)?.label).toBe('Running 4/40 · 4 runs');

    // Its process had to be killed: its run never reports its end.
    end(runs.value[0]!, { status: 'stopped' });
    expect(shown.at(-1)?.label).toBe('Running 3/30 · 3 runs');
  });

  test('takes off its run stopped in its global setup, which never began', async () => {
    const { shown, runs, emit, end } = await plugin();
    const ci = { projectId: 1, origin: 'ci', originRef: null, name: null, job: false };
    runs.value = [trayRun({})];
    emit({ type: 'run-initializing', runId: 5, projectId: 1 });
    emit({ type: 'run-progress', runId: 6, ...counts, ...ci });
    end(runs.value[0]!, { status: 'stopped' });
    expect(shown.at(-1)?.label).toBe('Running 1/10…');
  });

  test('takes off the lab runs of a stopped Flake Lab session, its `piwi flake` killed', async () => {
    const { shown, runs, emit, end } = await plugin();
    const lab = { projectId: 1, origin: 'flake-lab', originRef: 'local-4242', name: null, job: true };
    const ci = { projectId: 1, origin: 'ci', originRef: null, name: null, job: false };
    runs.value = [trayRun({ kind: 'flake', originRef: 'flake:x', hubRefs: ['desktop-6'] })];
    emit({ type: 'run-progress', runId: 5, ...counts, ...lab });
    emit({ type: 'run-progress', runId: 6, ...counts, ...ci });
    end(runs.value[0]!, { status: 'stopped' });
    expect(shown.at(-1)?.label).toBe('Running 1/10…');
  });

  test('keeps a run it took off off for a minute, whatever late progress of it comes', async () => {
    const { shown, runs, emit, end } = await plugin();
    const own = { projectId: 1, origin: 'desktop', originRef: 'desktop:a1', name: 'desktop-7', job: false };
    runs.value = [trayRun({})];
    emit({ type: 'run-progress', runId: 5, ...counts, ...own });
    end(runs.value[0]!, { status: 'stopped' });
    expect(shown.at(-1)).toEqual(NOTHING);
    // Its last progress, read late, and its end the server's sweep sends: nothing shows.
    emit({ type: 'run-progress', runId: 5, ...counts, passedTests: 2, ...own });
    emit({ type: 'run-started', runId: 5, ...own });
    emit({ type: 'snapshot', runs: [{ id: 5, status: 'running', totalTests: 10, ...own }] });
    emit({ type: 'run-finished', runId: 5, status: 'interrupted', ...own });
    expect(shown.at(-1)).toEqual(NOTHING);
    expect(flashes(shown)).toEqual([]);
  });

  test('takes off the lab runs of a stopped bisect that runs a Flake Lab arm at each step', async () => {
    const { shown, runs, emit, end } = await plugin();
    const lab = { projectId: 1, origin: 'flake-lab', originRef: 'local-4242', name: null, job: true };
    const editor = { projectId: 1, origin: 'editor', originRef: 'editor:x', name: null, job: false };
    runs.value = [trayRun({ kind: 'bisect', originRef: '37', hubRefs: ['desktop-6'], flakeTestCaseId: 12 })];
    emit({ type: 'run-progress', runId: 5, ...counts, ...lab });
    emit({ type: 'run-progress', runId: 6, ...counts, ...editor });
    end(runs.value[0]!, { status: 'stopped' });
    expect(shown.at(-1)?.label).toBe('Running 1/10…');
  });
});

describe('a local run that ended on its own', () => {
  test('takes off the runs of its project that never began, as its own whose global setup failed', async () => {
    const { shown, runs, emit, end } = await plugin();
    const own = { projectId: 1, origin: 'desktop', originRef: 'desktop:a1', name: 'desktop-7', job: false };
    const counts = { totalTests: 10, passedTests: 1, failedTests: 0, skippedTests: 0, didNotRunTests: 0 };
    runs.value = [trayRun({})];
    emit({ type: 'run-initializing', runId: 5, projectId: 1 });
    emit({ type: 'run-progress', runId: 6, ...counts, ...own });
    end(runs.value[0]!, { status: 'failed', exitCode: 1 });
    // Its run that began stays until its own end, which flashes.
    expect(shown.at(-1)?.label).toBe('Running 1/10…');
    emit({ type: 'run-finished', runId: 6, status: 'failed', ...own });
    expect(failedEnds(shown)).toEqual([{ state: 'error', fraction: 1, label: 'Run failed', failing: false }]);
  });
});
