import { describe, expect, test, vi } from 'vitest';
import {
  RUNNER_MAX_FINISHED,
  RUNNER_MAX_LINES,
  applyRunEvent,
  createRunnerRuns,
  finishedStatus,
  isRunnerRunRef,
  noteRunPages,
  runnerFinishedRuns,
  runnerRunDuration,
  runnerUnlistedSessions,
  runnerShellIdOf,
  runnerShownRefs,
  type RunnerRun,
  type RunnerRunBackend,
} from '../app/utils/runner-runs';

function setup(invoke: RunnerRunBackend['invoke'] = async () => 7 as never) {
  const runs: RunnerRun[] = [];
  const spy = vi.fn(invoke);
  const clock = { now: 1_000 };
  const book = createRunnerRuns(runs, { invoke: spy as RunnerRunBackend['invoke'] }, () => clock.now);
  return { runs, book, spy, clock };
}

const TEST = { title: 'checkout › pays', filePath: 'tests/checkout.spec.ts', line: 3, projectName: 'chromium' };
const input = {
  requestId: 'req-1',
  instance: 'https://team.example.com',
  projectId: 3,
  projectName: 'Acme Checkout',
  tests: [TEST],
  title: 'Checkout flow',
};

describe('finishedStatus', () => {
  test.each([
    [{ stopRequested: false }, 0, 'passed'],
    [{ stopRequested: false }, 1, 'failed'],
    [{ stopRequested: false }, null, 'error'],
    [{ stopRequested: true }, 0, 'stopped'],
    [{ stopRequested: true }, null, 'stopped'],
  ] as const)('%j with code %s is %s', (run, code, status) => {
    expect(finishedStatus(run, code)).toBe(status);
  });
});

describe('a run', () => {
  test('starts the shell with only the request id and shows it running', async () => {
    const { runs, book, spy } = setup();
    const run = await book.start(input);
    expect(spy).toHaveBeenCalledWith('desktop_run_requested_tests', { requestId: 'req-1' });
    expect(run).toMatchObject({ shellId: 7, status: 'running', title: 'Checkout flow', lines: [] });
    expect(runs).toHaveLength(1);
  });

  test('keeps its project, its tests, when it started and when it ended', async () => {
    const { book, clock } = setup();
    const run = await book.start(input);
    expect(run).toMatchObject({ projectName: 'Acme Checkout', tests: [TEST], startedAt: 1_000, endedAt: null });
    clock.now = 4_500;
    expect(runnerRunDuration(run, clock.now)).toBe(3_500);
    book.handle({ id: 7, kind: 'stdout', line: 'Running 1 test' });
    expect(run.endedAt).toBeNull();
    book.handle({ id: 7, kind: 'exit', code: 0 });
    expect(run.endedAt).toBe(4_500);
    expect(runnerRunDuration(run, 60_000)).toBe(3_500);
  });

  test('a run that cannot start ends when the shell refuses it', async () => {
    const { book } = setup(async () => {
      throw new Error('No folder is linked to this project');
    });
    const run = await book.start(input);
    expect(run).toMatchObject({ status: 'error', endedAt: 1_000 });
  });

  test('collects output and ends with the exit code', async () => {
    const { book } = setup();
    const run = await book.start(input);
    book.handle({ id: 7, kind: 'stdout', line: 'Running 2 tests' });
    book.handle({ id: 7, kind: 'stderr', line: 'warn' });
    book.handle({ id: 7, kind: 'exit', code: 0 });
    expect(run.lines).toEqual([
      { id: 1, text: 'Running 2 tests', error: false },
      { id: 2, text: 'warn', error: true },
    ]);
    expect(run.linesTotal).toBe(2);
    expect(run).toMatchObject({ status: 'passed', exitCode: 0 });
  });

  test('a non-zero exit is failed, and a run that cannot start is an error with the reason', async () => {
    const failing = setup();
    const run = await failing.book.start(input);
    failing.book.handle({ id: 7, kind: 'exit', code: 1 });
    expect(run.status).toBe('failed');

    const broken = setup(async () => {
      throw new Error('No folder is linked to this project');
    });
    const bad = await broken.book.start(input);
    expect(bad.status).toBe('error');
    expect(bad.lines).toEqual([{ id: 1, text: 'No folder is linked to this project', error: true }]);
  });

  test('events that arrive before the start resolves are applied once its id is known', async () => {
    let resolve!: (id: number) => void;
    const { runs, book } = setup(() => new Promise<never>((r) => (resolve = r as unknown as (id: number) => void)));
    const starting = book.start(input);
    book.handle({ id: 9, kind: 'stdout', line: 'early' });
    book.handle({ id: 4, kind: 'stdout', line: 'someone else' });
    resolve(9);
    const run = await starting;
    expect(run.lines.map((line) => line.text)).toEqual(['early']);
    expect(runs[0]).toBe(run);
  });

  test('stop asks the shell once the id is known and labels the end as stopped', async () => {
    const { book, spy, clock } = setup();
    const run = await book.start(input);
    clock.now = 4_000;
    await book.stop(run);
    expect(spy).toHaveBeenLastCalledWith('desktop_stop_local_tests', { runId: 7 });
    expect(run).toMatchObject({ stopRequested: true, stopRequestedAt: 4_000 });
    // Force stop asks again, and the stop keeps the time it was first asked.
    clock.now = 6_000;
    await book.stop(run);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(run.stopRequestedAt).toBe(4_000);
    book.handle({ id: 7, kind: 'exit', code: 130 });
    expect(run.status).toBe('stopped');
  });

  test('stop does nothing for a run that has ended or has no id yet', async () => {
    const { book, spy } = setup();
    const run = await book.start(input);
    book.handle({ id: 7, kind: 'exit', code: 0 });
    spy.mockClear();
    await book.stop(run);
    expect(spy).not.toHaveBeenCalled();

    const pending = setup(() => new Promise<never>(() => {}));
    void pending.book.start(input);
    await pending.book.stop(pending.runs[0]!);
    expect(pending.spy).toHaveBeenCalledTimes(1);
  });

  test('a stop for a process that already exited is not an error', async () => {
    const { book, spy } = setup();
    const run = await book.start(input);
    spy.mockImplementationOnce(async () => {
      throw new Error('gone');
    });
    await expect(book.stop(run)).resolves.toBeUndefined();
  });

  test('events after the exit change nothing', () => {
    const run = { status: 'passed', lines: [], linesTotal: 0 } as unknown as RunnerRun;
    applyRunEvent(run, { id: 1, kind: 'stdout', line: 'late' });
    expect(run.lines).toEqual([]);
  });

  test('keeps the last lines of a long output', async () => {
    const { book } = setup();
    const run = await book.start(input);
    for (let i = 0; i < RUNNER_MAX_LINES + 5; i++) book.handle({ id: 7, kind: 'stdout', line: `line ${i}` });
    expect(run.lines).toHaveLength(RUNNER_MAX_LINES);
    expect(run.lines[0]).toEqual({ id: 6, text: 'line 5', error: false });
    expect(run.linesTotal).toBe(RUNNER_MAX_LINES + 5);
  });

  test('keeps a bounded number of finished runs and never drops a running one', async () => {
    let id = 0;
    const { runs, book } = setup(async () => ++id as never);
    const first = await book.start(input);
    for (let i = 0; i < RUNNER_MAX_FINISHED + 3; i++) {
      await book.start(input);
      book.handle({ id: id, kind: 'exit', code: 0 });
    }
    expect(runs.filter((r) => r.status !== 'running')).toHaveLength(RUNNER_MAX_FINISHED);
    expect(runs).toContain(first);
  });

  test('a run that ends after many shorter ones keeps its place, and the one that ended longest ago goes', async () => {
    let id = 0;
    const { runs, book, clock } = setup(async () => ++id as never);
    const long = await book.start(input);
    for (let i = 0; i < RUNNER_MAX_FINISHED; i++) {
      clock.now += 1_000;
      await book.start(input);
      book.handle({ id: id, kind: 'exit', code: 0 });
    }
    const finishedBefore = runnerFinishedRuns(runs);
    const endedFirst = finishedBefore[finishedBefore.length - 1];
    clock.now += 1_000;
    book.handle({ id: long.shellId!, kind: 'exit', code: 1 });
    expect(runs).toContain(long);
    expect(runs).not.toContain(endedFirst);
    expect(runnerFinishedRuns(runs)).toHaveLength(RUNNER_MAX_FINISHED);
    expect(runnerFinishedRuns(runs)[0]).toBe(long);
  });

  test('the runs that ended are listed the last to end first', async () => {
    let id = 0;
    const { runs, book, clock } = setup(async () => ++id as never);
    const first = await book.start(input);
    const second = await book.start(input);
    clock.now = 2_000;
    book.handle({ id: 2, kind: 'exit', code: 0 });
    clock.now = 3_000;
    book.handle({ id: 1, kind: 'exit', code: 1 });
    expect(runs).toEqual([second, first]);
    expect(runnerFinishedRuns(runs)).toEqual([first, second]);
  });

  test('Clear finished removes the runs that ended and keeps the running ones', async () => {
    let id = 0;
    const { runs, book } = setup(async () => ++id as never);
    const passed = await book.start(input);
    const running = await book.start(input);
    const failed = await book.start(input);
    book.handle({ id: 1, kind: 'exit', code: 0 });
    book.handle({ id: 3, kind: 'exit', code: 1 });
    expect(runs).toEqual([failed, running, passed]);
    book.clearFinished();
    expect(runs).toEqual([running]);
    expect(running.status).toBe('running');
  });
});

describe('the hub’s name of a run', () => {
  test('is the shell’s run id, as the shell names it on the run channel', () => {
    expect(isRunnerRunRef('desktop-7', 7)).toBe(true);
    expect(isRunnerRunRef('desktop-7-unattended', 7)).toBe(true);
    expect(isRunnerRunRef('desktop-70', 7)).toBe(false);
    expect(isRunnerRunRef('terminal-7', 7)).toBe(false);
    expect(isRunnerRunRef('desktop-7', null)).toBe(false);
    expect(runnerShellIdOf('desktop-12')).toBe(12);
    expect(runnerShellIdOf('desktop-12-unattended')).toBe(12);
    expect(runnerShellIdOf('terminal-12')).toBeNull();
    expect(runnerShellIdOf('desktop-12x')).toBeNull();
  });

  test('is shown to the hub for a running run whose Hold failures is on, and no other', async () => {
    const { runs, book } = setup();
    await book.start(input);
    expect(runs[0]!.holdFailures).toBe(false);
    expect(runnerShownRefs(runs)).toEqual([]);
    runs[0]!.holdFailures = true;
    expect(runnerShownRefs(runs)).toEqual(['desktop-7']);
    book.handle({ id: 7, kind: 'exit', code: 0 });
    expect(runnerShownRefs(runs)).toEqual([]);
  });
});

describe('the hub’s runs this window holds no entry for', () => {
  test('are its live runs that no run of the window is', async () => {
    const { runs, book } = setup();
    await book.start(input);
    const sessions = [
      { ref: 'desktop-7', ended: false },
      { ref: 'desktop-8', ended: false },
      { ref: 'desktop-9', ended: true },
    ];
    expect(runnerUnlistedSessions(sessions, runs)).toEqual([{ ref: 'desktop-8', ended: false }]);
  });
});

describe('the run’s page', () => {
  test('is kept once the hub names it, after the run ended too, for the run of the same shell id alone', async () => {
    const { runs, book } = setup();
    const run = await book.start(input);
    expect(run.page).toBeNull();
    const page = { id: 78, url: 'https://team.example.com/test-runs/78' };
    noteRunPages(runs, [
      { ref: 'desktop-9', page: { id: 1, url: 'https://team.example.com/test-runs/1' } },
      { ref: 'desktop-7' },
    ]);
    expect(run.page).toBeNull();
    noteRunPages(runs, [{ ref: 'desktop-7', page }]);
    expect(run.page).toEqual(page);
    book.handle({ id: 7, kind: 'exit', code: 1 });
    noteRunPages(runs, []);
    expect(run).toMatchObject({ status: 'failed', page });
  });
});
