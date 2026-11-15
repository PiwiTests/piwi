import { describe, expect, test } from 'vitest';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { OwnRunTests } from '../src/own-run-tests';
import type { RunSession, RunStop, RunTest, RunWorker } from '../src/protocol';

const ROOT = path.resolve('/work/shop');
const SPEC = path.join(ROOT, 'tests/cart.spec.ts');
const PAGE = path.join(ROOT, 'tests/pages/cart.page.ts');

const runTest = (title: string[], project = 'chromium', file = SPEC): RunTest => ({
  id: `${title.join(' ')}-${project}`,
  title,
  uri: pathToFileURL(file).href,
  line: 3,
  project,
  retry: 0,
  cannotPause: null,
});

const stop = (reason: RunStop['reason'], file: string, line: number): RunStop => ({
  reason,
  title: "Click getByRole('button')",
  uri: pathToFileURL(file).href,
  line,
  character: 4,
  locator: null,
  bar: false,
  since: '2026-11-15T10:00:00.000Z',
});

const worker = (index: number, test: RunTest | null, at: RunStop | null = null): RunWorker => ({
  worker: index,
  parallelIndex: index,
  state: test === null ? 'between' : at ? 'stopped' : 'running',
  test,
  stop: at,
  takes: [],
  watchable: false,
  layers: false,
  showsWindow: false,
  pausing: false,
  waiting: null,
});

const session = (ref: string, workers: RunWorker[], more: Partial<RunSession> = {}): RunSession => ({
  ref,
  root: ROOT,
  workers,
  ended: false,
  ...more,
});

const MUG = ['cart', 'adds a mug'];

describe('the tests of the editor’s own runs, as their lines show them', () => {
  test('a test running, paused at a stop, held at its failure, by its spec and titles', () => {
    const own = new OwnRunTests();
    const mug = runTest(MUG);
    expect(own.stateOf(ROOT, SPEC, MUG, [session('ed-1', [worker(0, mug)])])).toEqual({
      status: 'running',
      words: 'running',
      ref: 'ed-1',
      live: true,
    });
    expect(own.stateOf(ROOT, SPEC, MUG, [session('ed-1', [worker(0, mug, stop('pause', SPEC, 13))])])).toEqual({
      status: 'paused',
      words: 'paused, line 14,',
      ref: 'ed-1',
      live: true,
    });
    // A stop in a page object names its file.
    expect(own.stateOf(ROOT, SPEC, MUG, [session('ed-1', [worker(0, mug, stop('breakpoint', PAGE, 6))])])?.words).toBe(
      'stopped at a breakpoint, line 7 of cart.page.ts,',
    );
    expect(own.stateOf(ROOT, SPEC, MUG, [session('ed-1', [worker(0, mug, stop('failure', SPEC, 4))])])).toMatchObject({
      status: 'failed',
      words: 'held at its failure, line 5,',
    });
    // Another test of the spec, another spec, another config, a reproduction in a throwaway checkout: none of its.
    const sessions = (more: Partial<RunSession> = {}) => [session('ed-1', [worker(0, mug)], more)];
    expect(own.stateOf(ROOT, SPEC, ['cart', 'adds a cup'], sessions())).toBeUndefined();
    expect(own.stateOf(ROOT, PAGE, MUG, sessions())).toBeUndefined();
    expect(own.stateOf(path.resolve('/work/admin'), SPEC, MUG, sessions())).toBeUndefined();
    expect(own.stateOf(ROOT, SPEC, MUG, sessions({ checkout: { commit: 'abc1234' } }))).toBeUndefined();
  });

  test('each result of a run no instance reads, until another run of the config begins', () => {
    const own = new OwnRunTests();
    const mug = runTest(MUG);
    own.heard('ed-1', 0, { type: 'test-begin', test: mug }, ROOT);
    own.heard('ed-1', 0, { type: 'test-end', status: 'passed', ok: true }, ROOT);
    // While the run goes on, the test's line says how it ended.
    expect(own.stateOf(ROOT, SPEC, MUG, [session('ed-1', [worker(0, null)])])).toEqual({
      status: 'passed',
      words: 'passed',
      ref: 'ed-1',
      live: false,
    });
    expect(own.testsOf(ROOT, [session('ed-1', [worker(0, null)])])).toEqual([
      { uri: mug.uri, title: MUG, status: 'passed', words: 'passed' },
    ]);
    // Then once it ended.
    own.heard('ed-1', null, { type: 'ended' }, ROOT);
    expect(own.stateOf(ROOT, SPEC, MUG, [])).toMatchObject({ status: 'passed', ref: 'ed-1', live: false });
    // Another run of the config begins: the results kept go.
    own.heard('ed-2', 0, { type: 'test-begin', test: runTest(['cart', 'adds a cup']) }, ROOT);
    expect(own.stateOf(ROOT, SPEC, MUG, [])).toBeUndefined();
  });

  test('a test marked to fail passes by failing, and fails by passing', () => {
    const own = new OwnRunTests();
    own.heard('ed-1', 0, { type: 'test-begin', test: runTest(MUG, 'chromium') }, ROOT);
    own.heard('ed-1', 0, { type: 'test-end', status: 'failed', ok: true }, ROOT);
    expect(own.stateOf(ROOT, SPEC, MUG, [])?.status).toBe('passed');
    // In another Playwright project it passes, unexpectedly: the test failed.
    own.heard('ed-1', 1, { type: 'test-begin', test: runTest(MUG, 'firefox') }, ROOT);
    own.heard('ed-1', 1, { type: 'test-end', status: 'passed', ok: false }, ROOT);
    expect(own.stateOf(ROOT, SPEC, MUG, [])?.status).toBe('failed');
  });

  test('a result over the Playwright projects, the last attempt’s, an interrupted one leaving the one before', () => {
    const own = new OwnRunTests();
    const end = (worker: number, test: RunTest, status: string) => {
      own.heard('ed-1', worker, { type: 'test-begin', test }, ROOT);
      own.heard('ed-1', worker, { type: 'test-end', status, ok: status === 'passed' }, ROOT);
    };
    end(0, runTest(MUG, 'chromium'), 'failed');
    // Its retry passes.
    end(0, { ...runTest(MUG, 'chromium'), retry: 1 }, 'passed');
    expect(own.stateOf(ROOT, SPEC, MUG, [])?.status).toBe('passed');
    // It times out in another project: the test failed.
    end(1, runTest(MUG, 'firefox'), 'timedOut');
    expect(own.stateOf(ROOT, SPEC, MUG, [])?.status).toBe('failed');
    // A worker gone before its test ended leaves the attempt before.
    own.heard('ed-1', 1, { type: 'test-begin', test: { ...runTest(MUG, 'firefox'), retry: 1 } }, ROOT);
    own.heard('ed-1', 1, { type: 'left' }, ROOT);
    expect(own.stateOf(ROOT, SPEC, MUG, [])?.status).toBe('failed');
    // Skipped alone, it is skipped.
    end(2, runTest(['cart', 'adds a cup']), 'skipped');
    expect(own.stateOf(ROOT, SPEC, ['cart', 'adds a cup'], [])?.status).toBe('skipped');
  });

  test('the newest run’s result first, and the kept results gone with a newer latest run', () => {
    const own = new OwnRunTests();
    own.heard('ed-1', 0, { type: 'test-begin', test: runTest(MUG) }, ROOT);
    own.heard('ed-1', 0, { type: 'test-end', status: 'passed', ok: true }, ROOT);
    // A second run of the config, while the first goes on, fails the test.
    own.heard('ed-2', 0, { type: 'test-begin', test: runTest(MUG) }, ROOT);
    own.heard('ed-2', 0, { type: 'test-end', status: 'failed', ok: false }, ROOT);
    expect(own.stateOf(ROOT, SPEC, MUG, [])).toMatchObject({ status: 'failed', ref: 'ed-2' });
    own.heard('ed-1', null, { type: 'ended' }, ROOT);
    own.heard('ed-2', null, { type: 'ended' }, ROOT);
    expect(own.stateOf(ROOT, SPEC, MUG, [])).toMatchObject({ status: 'failed', ref: 'ed-2' });
    // The instance gives a newer latest run of the config.
    expect(own.forget(ROOT)).toBe(true);
    expect(own.stateOf(ROOT, SPEC, MUG, [])).toBeUndefined();
    expect(own.forget(ROOT)).toBe(false);
  });

  test('a stop in a file whose name is spelled apart in its URI names the file', () => {
    const own = new OwnRunTests();
    const page = path.join(ROOT, 'tests/pages/my page.ts');
    const at = stop('breakpoint', page, 2);
    expect(own.stateOf(ROOT, SPEC, MUG, [session('ed-1', [worker(0, runTest(MUG), at)])])?.words).toBe(
      'stopped at a breakpoint, line 3 of my page.ts,',
    );
  });

  test('a run that names its page on an instance leaves its results to the instance', () => {
    const own = new OwnRunTests();
    own.sessionChanged(session('ed-1', [], { page: { id: 42, url: 'https://piwi.example.com/test-runs/42' } }));
    own.heard('ed-1', 0, { type: 'test-begin', test: runTest(MUG) }, ROOT);
    own.heard('ed-1', 0, { type: 'test-end', status: 'failed', ok: false }, ROOT);
    expect(own.stateOf(ROOT, SPEC, MUG, [])).toBeUndefined();
    own.heard('ed-1', null, { type: 'ended' }, ROOT);
    expect(own.stateOf(ROOT, SPEC, MUG, [])).toBeUndefined();
    expect(own.testsOf(ROOT, [])).toEqual([]);
  });
});
