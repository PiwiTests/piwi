import { afterEach, describe, test, expect, vi } from 'vitest';
import { nextTick, ref, watch } from 'vue';
import {
  aggregateRunProgress,
  finishedRunFlash,
  isUnattendedLiveRun,
  runsOfStoppedLocalRun,
  FAIL_FLASH_MS,
  NO_RUN_PROGRESS,
  PASS_FLASH_MS,
  type LiveRun,
  type RunCounts,
  type StoppedLocalRun,
} from '../../app/utils/desktop-run-progress';

function run(status: string, done: number, total: number, failed = 0): RunCounts {
  return { status, done, total, failed };
}

describe('aggregateRunProgress', () => {
  test('no runs, or only finished runs, clears the bar', () => {
    expect(aggregateRunProgress([])).toEqual(NO_RUN_PROGRESS);
    expect(aggregateRunProgress([run('passed', 12, 12), run('failed', 3, 10)])).toEqual(NO_RUN_PROGRESS);
  });

  test('a single counted run is a determinate fraction with a count label', () => {
    const result = aggregateRunProgress([run('running', 3, 12)]);
    expect(result.state).toBe('normal');
    expect(result.fraction).toBeCloseTo(3 / 12);
    expect(result.label).toBe('Running 3/12…');
  });

  test('a run with no total yet is indeterminate', () => {
    expect(aggregateRunProgress([run('initializing', 0, 0)])).toEqual({
      state: 'indeterminate',
      fraction: null,
      label: 'Running…',
      failing: false,
    });
  });

  test('initializing and finalizing runs count as in-flight', () => {
    expect(aggregateRunProgress([run('finalizing', 8, 8)]).state).toBe('normal');
    expect(aggregateRunProgress([run('initializing', 2, 10)]).fraction).toBeCloseTo(2 / 10);
  });

  test('concurrent counted runs sum into one fraction', () => {
    const result = aggregateRunProgress([run('running', 4, 10), run('running', 6, 20)]);
    expect(result.state).toBe('normal');
    expect(result.fraction).toBeCloseTo(10 / 30);
    expect(result.label).toBe('Running 10/30 · 2 runs');
  });

  test('one run with no total makes the whole bar indeterminate', () => {
    const result = aggregateRunProgress([run('running', 4, 10), run('running', 0, 0)]);
    expect(result).toEqual({ state: 'indeterminate', fraction: null, label: 'Running 2 runs…', failing: false });
  });

  test('retried tests never push the fraction past 100%', () => {
    expect(aggregateRunProgress([run('running', 8, 5)]).fraction).toBe(1);
  });

  test('finished runs are ignored while another is still active', () => {
    const result = aggregateRunProgress([run('passed', 100, 100), run('running', 2, 10)]);
    expect(result.fraction).toBeCloseTo(2 / 10);
    expect(result.label).toBe('Running 2/10…');
  });

  test('a run with a failed test is failing, with a red bar and the count in the label', () => {
    const result = aggregateRunProgress([run('running', 5, 12, 2)]);
    expect(result).toMatchObject({ state: 'error', failing: true, label: 'Running 5/12 · 2 failed' });
    expect(result.fraction).toBeCloseTo(5 / 12);
    expect(aggregateRunProgress([run('running', 5, 12)]).failing).toBe(false);
  });

  test('failures sum across concurrent runs', () => {
    const result = aggregateRunProgress([run('running', 4, 10, 1), run('running', 6, 20, 2)]);
    expect(result).toMatchObject({ state: 'error', failing: true, label: 'Running 10/30 · 2 runs · 3 failed' });
  });

  test('an indeterminate bar stays indeterminate when failing — only the dot shows it', () => {
    expect(aggregateRunProgress([run('running', 4, 10, 1), run('running', 0, 0)])).toEqual({
      state: 'indeterminate',
      fraction: null,
      label: 'Running 2 runs · 1 failed',
      failing: true,
    });
  });

  test('a finished run with failures does not make the active ones failing', () => {
    expect(aggregateRunProgress([run('failed', 10, 10, 4), run('running', 2, 10)]).failing).toBe(false);
  });
});

describe('finishedRunFlash', () => {
  test('a pass flashes green and a failure red', () => {
    expect(finishedRunFlash('passed')).toEqual({
      progress: { state: 'normal', fraction: 1, label: 'Run passed', failing: false },
      durationMs: PASS_FLASH_MS,
    });
    for (const status of ['failed', 'timedout']) {
      expect(finishedRunFlash(status)).toEqual({
        progress: { state: 'error', fraction: 1, label: 'Run failed', failing: false },
        durationMs: FAIL_FLASH_MS,
      });
    }
  });

  test('an interrupted run flashes amber, not as a failure', () => {
    expect(finishedRunFlash('interrupted')?.progress).toEqual({
      state: 'paused',
      fraction: 1,
      label: 'Run interrupted',
      failing: false,
    });
  });

  test('a cancelled run clears without a flash', () => {
    expect(finishedRunFlash('cancelled')).toBeNull();
  });
});

describe('isUnattendedLiveRun', () => {
  test('a bisect step and a lab run are attended by nobody', () => {
    for (const origin of ['bisect', 'flake-lab', 'probe']) {
      expect(isUnattendedLiveRun({ origin, runName: null })).toBe(true);
    }
  });

  test('a run the shell names unattended is attended by nobody, whatever launched it', () => {
    expect(isUnattendedLiveRun({ origin: 'desktop', runName: 'desktop-7-unattended' })).toBe(true);
  });

  test('a run of the app, a reproduction, an editor or CI run is attended', () => {
    for (const origin of ['desktop', 'reproduce', 'editor', 'ci', 'local', null]) {
      expect(isUnattendedLiveRun({ origin, runName: origin === 'desktop' ? 'desktop-7' : null })).toBe(false);
    }
  });
});

const live = (projectId: number | null, origin: Partial<LiveRun> = {}): LiveRun => ({
  status: 'running',
  done: 1,
  total: 10,
  failed: 0,
  projectId,
  origin: null,
  originRef: null,
  runName: null,
  ...origin,
});

const stopped = (run: Partial<StoppedLocalRun> = {}): StoppedLocalRun => ({
  kind: 'tests',
  projectId: '1',
  originRef: 'desktop:abc',
  hubRefs: ['desktop-3'],
  piwiRunId: null,
  piwiRunBaseline: 4,
  ...run,
});

describe('runsOfStoppedLocalRun', () => {
  test('picks the runs its steps named, and none of another run of the same project', () => {
    const active = new Map<number, LiveRun>([
      [4, live(1, { origin: 'desktop', originRef: 'desktop:abc', runName: 'desktop-3' })], // before the spawn
      [7, live(1, { origin: 'desktop', originRef: 'desktop:abc', runName: 'desktop-3' })],
      [8, live(1, { origin: 'desktop', originRef: 'desktop:def', runName: 'desktop-5' })], // another local run
      [9, live(1, { origin: 'editor' })], // an editor's run
      [10, live(1, { origin: 'ci' })],
      [11, live(2, { origin: 'desktop', originRef: 'desktop:abc', runName: 'desktop-3' })], // another project
    ]);
    expect(runsOfStoppedLocalRun(active, stopped(), false)).toEqual([7]);
  });

  test('picks the run it is linked to', () => {
    const active = new Map<number, LiveRun>([
      [6, live(1)],
      [7, live(1, { origin: 'desktop', originRef: 'desktop:xyz' })],
    ]);
    expect(runsOfStoppedLocalRun(active, stopped({ piwiRunId: 6 }), false)).toEqual([6]);
  });

  test("picks a Flake Lab session's runs by the name of its step, with no baseline nor link", () => {
    // As `startFlakeLab` leaves it: no origin, so no baseline, no reference and no Piwi run linked.
    const session = stopped({ kind: 'flake', originRef: null, piwiRunId: null, piwiRunBaseline: null });
    const active = new Map<number, LiveRun>([
      [7, live(1, { origin: 'flake-lab', runName: 'desktop-3-unattended' })],
      [8, live(1, { origin: 'flake-lab', runName: 'desktop-4-unattended' })], // another session's
      [9, live(1, { origin: 'flake-lab' })], // a reporter that recorded no name
    ]);
    expect(runsOfStoppedLocalRun(active, session, false)).toEqual([7]);
  });

  test('picks a run with no name by its origin and reference, unless another local run shares the reference', () => {
    const active = new Map<number, LiveRun>([
      [7, live(1, { origin: 'bisect', originRef: '12' })],
      [8, live(1, { origin: 'reproduce', originRef: '12' })],
    ]);
    const bisect = stopped({ kind: 'bisect', originRef: '12' });
    expect(runsOfStoppedLocalRun(active, bisect, false)).toEqual([7]);
    expect(runsOfStoppedLocalRun(active, bisect, true)).toEqual([]);
  });

  test('picks no run older than its baseline, and no run without a name when it has no baseline', () => {
    const named = live(1, { origin: 'desktop', originRef: 'desktop:abc', runName: 'desktop-3' });
    expect(runsOfStoppedLocalRun(new Map([[3, named]]), stopped({ piwiRunBaseline: 3 }), false)).toEqual([]);
    const nameless = live(1, { origin: 'desktop', originRef: 'desktop:abc' });
    expect(runsOfStoppedLocalRun(new Map([[9, nameless]]), stopped({ piwiRunBaseline: null }), false)).toEqual([]);
  });
});

/** What the plugin asked the shell to show, in order. */
interface Shown {
  state: string;
  fraction: number | null;
  label: string | null;
  failing: boolean;
}

/**
 * The OS progress plugin with its Nuxt auto-imports and the desktop bridge stubbed: `emit` plays the desktop event
 * stream, `shown` holds what the plugin asked the shell to show, `invoked` every other command it sent the shell,
 * `shellEvent` plays an event of the shell's, `localRuns` is the window's local runs store and `stopped` the runs its
 * `stopRun` was called with.
 */
async function progressPlugin() {
  const shown: Shown[] = [];
  const invoked: Array<{ cmd: string; args: unknown }> = [];
  const stopped: unknown[] = [];
  let emit: (message: Record<string, unknown>) => void = () => {};
  const shellListeners = new Map<string, (event: { payload: unknown }) => void>();
  const localRuns = ref<Array<Record<string, unknown>>>([]);
  vi.stubGlobal('defineNuxtPlugin', (setup: () => void) => setup);
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('tauriCore', () => ({
    invoke: async (cmd: string, args: Shown) => {
      if (cmd === 'desktop_set_run_progress') shown.push(args);
      else invoked.push({ cmd, args });
    },
  }));
  vi.stubGlobal('tauriEvent', () => ({
    listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
      shellListeners.set(name, handler);
      return () => {};
    },
  }));
  vi.stubGlobal('subscribeDesktopEvents', (listener: typeof emit) => {
    emit = listener;
    return () => {};
  });
  vi.stubGlobal('useDesktopLocalRuns', () => ({ runs: localRuns, stopRun: (run: unknown) => stopped.push(run) }));
  const { default: setup } = await import('../../app/plugins/desktop-run-progress.client');
  (setup as unknown as () => void)();
  return {
    shown,
    invoked,
    stopped,
    emit: (message: Record<string, unknown>) => emit(message),
    shellEvent: (name: string, payload: unknown) => shellListeners.get(name)?.({ payload }),
    localRuns,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the OS progress of the runs in flight', () => {
  const counts = { totalTests: 1, passedTests: 0, failedTests: 1, skippedTests: 0, didNotRunTests: 0 };

  test("a bisect's failed step ends without a flash, so the shell neither shows nor calls for a failure", async () => {
    const { shown, emit } = await progressPlugin();
    emit({ type: 'snapshot', runs: [] });
    const origin = { origin: 'bisect', originRef: '12', runName: 'desktop-3-unattended' };
    emit({ type: 'run-started', runId: 5, projectId: 1, ...origin });
    emit({ type: 'run-progress', runId: 5, projectId: 1, ...counts });
    emit({ type: 'run-finished', runId: 5, projectId: 1, status: 'failed', ...origin });
    expect(shown.map((s) => s.label)).not.toContain('Run failed');
    expect(shown.at(-1)).toEqual({ state: 'none', fraction: null, label: null, failing: false });
  });

  test('a run nobody attends is known by its start when its end names no origin', async () => {
    const { shown, emit } = await progressPlugin();
    emit({ type: 'snapshot', runs: [{ id: 5, projectId: 1, status: 'running', origin: 'flake-lab' }] });
    emit({ type: 'run-finished', runId: 5, projectId: 1, status: 'failed' });
    expect(shown.at(-1)?.state).toBe('none');
  });

  test('a failed run someone attends flashes its failure', async () => {
    const { shown, emit } = await progressPlugin();
    emit({ type: 'snapshot', runs: [] });
    const origin = { origin: 'desktop', originRef: 'desktop:abc', runName: 'desktop-4' };
    emit({ type: 'run-started', runId: 6, projectId: 1, ...origin });
    emit({ type: 'run-finished', runId: 6, projectId: 1, status: 'failed', ...origin });
    expect(shown.at(-1)).toEqual({ state: 'error', fraction: 1, label: 'Run failed', failing: false });
  });

  test('a stopped local run takes its own run off the bar, and leaves the other run of its project', async () => {
    const { shown, emit, localRuns } = await progressPlugin();
    emit({
      type: 'snapshot',
      runs: [
        {
          id: 7,
          projectId: 1,
          status: 'running',
          totalTests: 10,
          passedTests: 2,
          origin: 'desktop',
          originRef: 'desktop:abc',
          runName: 'desktop-3',
        },
        { id: 8, projectId: 1, status: 'running', totalTests: 20, passedTests: 5, origin: 'editor' },
      ],
    });
    expect(shown.at(-1)?.label).toBe('Running 7/30 · 2 runs');
    const run = { key: 1, ...stopped(), status: 'running', startedAt: 0, finishedAt: null };
    localRuns.value = [run];
    await nextTick();
    localRuns.value = [{ ...run, status: 'stopped', finishedAt: 1 }];
    await nextTick();
    expect(shown.at(-1)?.label).toBe('Running 5/20…');
  });

  test("the taskbar's Stop stops the window's runs, and the shell's processes none of them owns", async () => {
    const { invoked, stopped: stoppedRuns, shellEvent, localRuns } = await progressPlugin();
    const own = { key: 1, ...stopped(), shellId: 3, status: 'running' };
    localRuns.value = [own];
    // Shell run 9 is a process a reload left: no window run owns it.
    shellEvent('piwi:taskbar-stop', [3, 9]);
    expect(stoppedRuns).toEqual([own]);
    expect(invoked).toEqual([{ cmd: 'desktop_stop_local_tests', args: { runId: 9 } }]);
  });
});
