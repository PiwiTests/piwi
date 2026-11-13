import { describe, expect, test, vi } from 'vitest';
import {
  RUNNER_MAX_FINISHED,
  RUNNER_MAX_LINES,
  applyRunEvent,
  createRunnerRuns,
  finishedStatus,
  isRunnerRunRef,
  noteRunPages,
  runnerShellIdOf,
  runnerShownRefs,
  type RunnerRun,
  type RunnerRunBackend,
} from '../app/utils/runner-runs';

function setup(invoke: RunnerRunBackend['invoke'] = async () => 7 as never) {
  const runs: RunnerRun[] = [];
  const spy = vi.fn(invoke);
  const book = createRunnerRuns(runs, { invoke: spy as RunnerRunBackend['invoke'] });
  return { runs, book, spy };
}

const input = { requestId: 'req-1', instance: 'https://team.example.com', projectId: 3, title: 'Checkout flow' };

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

  test('collects output and ends with the exit code', async () => {
    const { book } = setup();
    const run = await book.start(input);
    book.handle({ id: 7, kind: 'stdout', line: 'Running 2 tests' });
    book.handle({ id: 7, kind: 'stderr', line: 'warn' });
    book.handle({ id: 7, kind: 'exit', code: 0 });
    expect(run.lines).toEqual(['Running 2 tests', 'warn']);
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
    expect(bad.lines).toEqual(['No folder is linked to this project']);
  });

  test('events that arrive before the start resolves are applied once its id is known', async () => {
    let resolve!: (id: number) => void;
    const { runs, book } = setup(() => new Promise<never>((r) => (resolve = r as unknown as (id: number) => void)));
    const starting = book.start(input);
    book.handle({ id: 9, kind: 'stdout', line: 'early' });
    book.handle({ id: 4, kind: 'stdout', line: 'someone else' });
    resolve(9);
    const run = await starting;
    expect(run.lines).toEqual(['early']);
    expect(runs[0]).toBe(run);
  });

  test('stop asks the shell once the id is known and labels the end as stopped', async () => {
    const { book, spy } = setup();
    const run = await book.start(input);
    await book.stop(run);
    expect(spy).toHaveBeenLastCalledWith('desktop_stop_local_tests', { runId: 7 });
    expect(run.stopRequested).toBe(true);
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
    const run = { status: 'passed', lines: [] as string[] } as unknown as RunnerRun;
    applyRunEvent(run, { id: 1, kind: 'stdout', line: 'late' });
    expect(run.lines).toEqual([]);
  });

  test('keeps the last lines of a long output', async () => {
    const { book } = setup();
    const run = await book.start(input);
    for (let i = 0; i < RUNNER_MAX_LINES + 5; i++) book.handle({ id: 7, kind: 'stdout', line: `line ${i}` });
    expect(run.lines).toHaveLength(RUNNER_MAX_LINES);
    expect(run.lines[0]).toBe('line 5');
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
