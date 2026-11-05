import { describe, test, expect } from 'vitest';
import {
  aggregateRunProgress,
  finishedJobFlash,
  finishedRunFlash,
  liveRunFacts,
  runsOfLocalRun,
  FAIL_FLASH_MS,
  NO_LIVE_RUN_FACTS,
  NO_RUN_PROGRESS,
  PASS_FLASH_MS,
  type FinishedJob,
  type LiveRun,
  type LocalRunOwner,
  type RunCounts,
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

  test('a step of a job counts its tests, never its failures, which its verdict judges', () => {
    const step = { ...run('running', 3, 4, 2), job: true };
    expect(aggregateRunProgress([step])).toEqual({
      state: 'normal',
      fraction: 0.75,
      label: 'Running 3/4…',
      failing: false,
    });
    // Another run's failure still shows beside it.
    expect(aggregateRunProgress([step, run('running', 1, 4, 1)])).toMatchObject({
      state: 'error',
      failing: true,
      label: 'Running 4/8 · 2 runs · 1 failed',
    });
  });
});

describe('liveRunFacts', () => {
  test('reads what launched a run from a message of the desktop event stream, none before it began', () => {
    expect(liveRunFacts({ origin: 'bisect', originRef: '37', name: 'desktop-8-unattended', job: true })).toEqual({
      origin: 'bisect',
      originRef: '37',
      name: 'desktop-8-unattended',
      job: true,
    });
    expect(liveRunFacts({ origin: 'ci', originRef: null, name: null, job: false })).toEqual({
      ...NO_LIVE_RUN_FACTS,
      origin: 'ci',
    });
    expect(liveRunFacts({})).toBeNull();
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

describe('finishedJobFlash', () => {
  const job = (over: Partial<FinishedJob>): FinishedJob => ({
    kind: 'bisect',
    status: 'passed',
    exitCode: 0,
    phase: null,
    bisect: null,
    repro: null,
    ...over,
  });
  const flash = (over: Partial<FinishedJob>) => {
    const shown = finishedJobFlash(job(over));
    return shown && { state: shown.progress.state, label: shown.progress.label, failing: shown.progress.failing };
  };

  test('a bisect flashes the commit it found, or that it did not finish', () => {
    expect(finishedJobFlash(job({ bisect: { firstBad: { sha: 'abcdef1234567' } } }))).toEqual({
      progress: { state: 'normal', fraction: 1, label: 'Bisect found abcdef1', failing: false },
      durationMs: PASS_FLASH_MS,
    });
    expect(finishedJobFlash(job({ status: 'failed', exitCode: 1, bisect: { firstBad: null } }))).toEqual({
      progress: { state: 'error', fraction: 1, label: 'Bisect did not finish', failing: false },
      durationMs: FAIL_FLASH_MS,
    });
  });

  test('a reproduction flashes red when it reproduced, green when it did not', () => {
    expect(flash({ kind: 'reproduce', status: 'failed', exitCode: 1, phase: 'test' })).toEqual({
      state: 'error',
      label: 'Reproduced',
      failing: false,
    });
    expect(flash({ kind: 'reproduce', phase: 'test' })).toMatchObject({ state: 'normal', label: 'Not reproduced' });
    expect(flash({ kind: 'reproduce', status: 'failed', exitCode: 1, phase: 'install' })).toMatchObject({
      state: 'error',
      label: 'Reproduction could not run',
    });
  });

  test('a bug report’s steps flash their verdict', () => {
    const verdict = { kind: 'reproduced', step: 1, found: null } as const;
    expect(flash({ kind: 'repro', status: 'failed', exitCode: 1, repro: { verdict } })).toMatchObject({
      state: 'error',
      label: 'Bug reproduced',
    });
    expect(flash({ kind: 'repro', repro: { verdict: { kind: 'not-reproduced' } } })).toMatchObject({
      state: 'normal',
      label: 'Not reproduced',
    });
  });

  test('a Flake Lab session flashes whether it reproduced the flake, red when it could not run', () => {
    expect(flash({ kind: 'flake' })).toMatchObject({ state: 'normal', label: 'Flake reproduced' });
    expect(flash({ kind: 'flake', exitCode: 1 })).toMatchObject({ state: 'normal', label: 'Flake not reproduced' });
    expect(flash({ kind: 'flake', status: 'failed', exitCode: 2 })).toMatchObject({
      state: 'error',
      label: 'Flake Lab could not run',
    });
  });

  test('a job that could not start flashes red, one stopped or still running flashes nothing', () => {
    expect(flash({ status: 'error', exitCode: null })).toMatchObject({ state: 'error', label: 'Bisect could not run' });
    expect(flash({ status: 'stopped' })).toBeNull();
    expect(flash({ status: 'running' })).toBeNull();
  });
});

describe('runsOfLocalRun', () => {
  const live = (over: Partial<LiveRun> = {}): LiveRun => ({
    status: 'running',
    done: 1,
    total: 10,
    failed: 0,
    projectId: 1,
    origin: 'desktop',
    originRef: 'desktop:a1',
    name: 'desktop-7',
    job: false,
    ...over,
  });
  const owner = (over: Partial<LocalRunOwner> = {}): LocalRunOwner => ({
    key: 1,
    kind: 'tests',
    projectId: '1',
    originRef: 'desktop:a1',
    hubRefs: ['desktop-7', 'desktop-8'],
    piwiRunBaseline: 4,
    flakeTestCaseId: null,
    startedAt: 1000,
    finishedAt: 5000,
    ...over,
  });

  test('picks the runs its own steps reported, leaving every other run of the project that began', () => {
    const active = new Map<number, LiveRun>([
      [4, live()], // before the local process was spawned
      [7, live()],
      [8, live({ name: 'desktop-8' })],
      [9, live({ origin: 'editor', originRef: 'editor:x', name: null })], // an editor's run
      [10, live({ origin: 'ci', originRef: null, name: null })], // a CI run
      [11, live({ originRef: 'desktop:b2', name: 'desktop-9' })], // another local run of the window
      [12, live({ projectId: 2 })], // another project
    ]);
    expect(runsOfLocalRun(active, owner(), [])).toEqual([7, 8]);
  });

  test('also takes a run of its project that never began, stopped in its global setup, whose origin nothing names', () => {
    const active = new Map<number, LiveRun>([
      [3, live({ ...NO_LIVE_RUN_FACTS })], // before the baseline
      [7, live({ ...NO_LIVE_RUN_FACTS, status: 'initializing', total: 0, done: 0 })],
      [8, live({ ...NO_LIVE_RUN_FACTS, projectId: 2 })], // another project
      [9, live({ origin: 'ci', originRef: null, name: null })],
    ]);
    expect(runsOfLocalRun(active, owner(), [])).toEqual([7]);
    // A bisect's step whose setup failed leaves its job too.
    expect(runsOfLocalRun(active, owner({ kind: 'bisect', originRef: '42', hubRefs: ['desktop-6'] }), [])).toEqual([7]);
  });

  test('tells two runs of one reference apart by the names their steps gave them', () => {
    const active = new Map<number, LiveRun>([
      [7, live({ origin: 'reproduce', originRef: '42', name: 'desktop-7' })],
      [8, live({ origin: 'reproduce', originRef: '42', name: 'desktop-9' })],
      // A reporter that recorded no name: its origin and reference alone, while no other run shares them.
      [9, live({ origin: 'reproduce', originRef: '42', name: null })],
      // A step nobody attends carries the mark the shell gives it.
      [10, live({ origin: 'bisect', originRef: '42', name: 'desktop-6-unattended', job: true })],
    ]);
    const reproduction = owner({ kind: 'reproduce', originRef: '42', hubRefs: ['desktop-7'] });
    expect(runsOfLocalRun(active, reproduction, [reproduction])).toEqual([7, 9]);
    const bisect = owner({ kind: 'bisect', originRef: '42', hubRefs: ['desktop-6'] });
    expect(runsOfLocalRun(active, bisect, [reproduction, bisect])).toEqual([10]);
  });

  test('leaves a run with no name when another run of the tray goes on under the same reference', () => {
    const active = new Map<number, LiveRun>([
      [7, live({ origin: 'reproduce', originRef: '42', name: null })],
      [8, live({ origin: 'reproduce', originRef: '42', name: null })],
    ]);
    const first = owner({ key: 1, kind: 'reproduce', originRef: '42', hubRefs: ['desktop-7'] });
    const second = owner({ key: 2, kind: 'reproduce', originRef: '42', hubRefs: ['desktop-9'], finishedAt: null });
    expect(runsOfLocalRun(active, first, [first, second])).toEqual([]);
    // One that ended before the other started shares nothing with it.
    const earlier = owner({ key: 3, kind: 'reproduce', originRef: '42', startedAt: 0, finishedAt: 900 });
    expect(runsOfLocalRun(active, first, [first, earlier])).toEqual([7, 8]);
  });

  test('takes the lab runs of a bisect that runs a Flake Lab arm at each step', () => {
    const lab = { origin: 'flake-lab', originRef: 'local-4242', name: null, job: true };
    const active = new Map<number, LiveRun>([
      [7, live(lab)],
      [8, live({ ...lab, projectId: 2 })],
      [9, live({ origin: 'bisect', originRef: '42', name: 'desktop-6-unattended', job: true })],
    ]);
    const bisect = owner({ kind: 'bisect', originRef: '42', hubRefs: ['desktop-6'], flakeTestCaseId: 12 });
    expect(runsOfLocalRun(active, bisect, [bisect])).toEqual([7]);
    // A Flake Lab session of the tray going on at once in the project could have started them.
    const session = owner({ key: 2, kind: 'flake', originRef: 'flake:x', piwiRunBaseline: null, finishedAt: null });
    expect(runsOfLocalRun(active, bisect, [bisect, session])).toEqual([]);
  });

  test('picks nothing without a baseline, nor a run that began under another origin', () => {
    const active = new Map<number, LiveRun>([[7, live()]]);
    expect(runsOfLocalRun(active, owner({ piwiRunBaseline: null }), [])).toEqual([]);
    expect(runsOfLocalRun(active, owner({ kind: 'flake' }), [])).toEqual([]);
    expect(runsOfLocalRun(active, owner({ piwiRunBaseline: 7 }), [])).toEqual([]);
  });
});
