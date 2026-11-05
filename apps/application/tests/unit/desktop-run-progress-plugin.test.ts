import { afterEach, describe, expect, test, vi } from 'vitest';
import { nextTick, ref, watch } from 'vue';

/**
 * The desktop shell's OS progress (`plugins/desktop-run-progress.client.ts`), driven as the window drives it: the
 * messages of the desktop event stream, and the Local runs tray's runs as their processes end. What it asks the shell
 * to show is each `desktop_set_run_progress` it sends; a red `error` without `failing` is the failed end the shell
 * asks for the user's attention on.
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
  finishedAt: number | null;
  exitCode: number | null;
  phase: string | null;
  bisect: { firstBad: { sha: string } | null } | null;
  repro: null;
}

async function plugin() {
  const shown: Shown[] = [];
  let emit: (message: Record<string, unknown>) => void = () => {};
  const runs = ref<TrayRun[]>([]);
  vi.stubGlobal('defineNuxtPlugin', (setup: unknown) => setup);
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
  vi.stubGlobal('useDesktopLocalRuns', () => ({ runs, stopRun: async () => {} }));
  const setup = (await import('../../app/plugins/desktop-run-progress.client')).default as unknown as () => void;
  setup();
  return { shown, runs, emit: (message: Record<string, unknown>) => emit(message) };
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the OS progress of a job of the Local runs tray', () => {
  test('shows a bisect’s steps as progress, each bad one with no flash, and flashes its verdict once', async () => {
    const { shown, runs, emit } = await plugin();
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
      expect(shown.at(-1), `step ${index + 1}`).toEqual({ state: 'none', fraction: null, label: null, failing: false });
    }
    expect(failedEnds(shown)).toEqual([]);

    // The bisect names its first bad commit and its process ends: one flash.
    Object.assign(runs.value[0]!, {
      status: 'passed',
      exitCode: 0,
      finishedAt: Date.now(),
      bisect: { firstBad: { sha: 'abcdef1234567' } },
    });
    await nextTick();
    expect(flashes(shown)).toEqual([{ state: 'normal', fraction: 1, label: 'Bisect found abcdef1', failing: false }]);
  });

  test('flashes a reproduction that reproduced once, red, when its process ends, never at its run’s end', async () => {
    const { shown, runs, emit } = await plugin();
    const step = { projectId: 1, origin: 'reproduce', originRef: '42', name: 'desktop-3', job: true };
    runs.value = [trayRun({ kind: 'reproduce', originRef: '42', hubRefs: ['desktop-3'] })];
    emit({ type: 'run-started', runId: 9, ...step });
    emit({ type: 'run-finished', runId: 9, status: 'failed', ...step });
    expect(failedEnds(shown)).toEqual([]);
    Object.assign(runs.value[0]!, { status: 'failed', exitCode: 1, phase: 'test', finishedAt: Date.now() });
    await nextTick();
    expect(failedEnds(shown)).toEqual([{ state: 'error', fraction: 1, label: 'Reproduced', failing: false }]);
  });

  test('flashes its verdict even while its own step is still finalizing on the server', async () => {
    const { shown, runs, emit } = await plugin();
    runs.value = [trayRun({ kind: 'bisect', originRef: '37', hubRefs: ['desktop-6'] })];
    emit({ type: 'run-started', runId: 5, ...BISECT_STEP });
    emit({ type: 'run-finalizing', runId: 5, status: 'failed', ...BISECT_STEP });
    Object.assign(runs.value[0]!, {
      status: 'failed',
      exitCode: 1,
      finishedAt: Date.now(),
      bisect: { firstBad: null },
    });
    await nextTick();
    expect(shown.at(-1)).toEqual({ state: 'error', fraction: 1, label: 'Bisect did not finish', failing: false });
    // Its step's end, heard later, changes nothing.
    emit({ type: 'run-finished', runId: 5, status: 'failed', ...BISECT_STEP });
    expect(shown.at(-1)?.label).toBe('Bisect did not finish');
  });

  test('still flashes a run that is no job, an editor’s or CI’s, as its outcome', async () => {
    const { shown, emit } = await plugin();
    const ci = { projectId: 1, origin: 'ci', originRef: null, name: null, job: false };
    emit({ type: 'run-started', runId: 11, ...ci });
    emit({ type: 'run-finished', runId: 11, status: 'failed', ...ci });
    expect(failedEnds(shown)).toEqual([{ state: 'error', fraction: 1, label: 'Run failed', failing: false }]);
  });
});

describe('a local run stopped from the app', () => {
  test('takes its own runs off the bar, and leaves an editor’s, CI’s and another local run’s', async () => {
    const { shown, runs, emit } = await plugin();
    const counts = { totalTests: 10, passedTests: 1, failedTests: 0, skippedTests: 0, didNotRunTests: 0 };
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
    Object.assign(runs.value[0]!, { status: 'stopped', finishedAt: Date.now() });
    await nextTick();
    expect(shown.at(-1)?.label).toBe('Running 3/30 · 3 runs');
  });
});
