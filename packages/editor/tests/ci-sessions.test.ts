import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CiSessions,
  MAX_CI_RUNS,
  ciBaseOf,
  ciRelative,
  ciSummary,
  listedTests,
  parseLocation,
  positionText,
  workspaceFile,
} from '../src/ci-sessions';
import type { PiwiContext } from '../src/context';
import { MAX_CI_TESTS, type CiSession } from '../src/protocol';
import type { RunEvent } from '../src/run-stream';

const ROOT = path.resolve('/work/shop');
const uri = (file: string) => pathToFileURL(path.join(ROOT, file)).href;
/** The files the workspace holds, relative to the config's folder. */
const FILES = new Set(['tests/checkout.spec.ts', 'tests/pages/checkout.page.ts'].map((f) => path.join(ROOT, f)));
const exists = (file: string) => FILES.has(file);

describe('where a CI run’s steps are in the workspace', () => {
  test('reads a location from its end, on any machine', () => {
    expect(parseLocation('/home/runner/work/shop/tests/a.spec.ts:12:5')).toEqual({
      file: '/home/runner/work/shop/tests/a.spec.ts',
      line: 12,
      column: 5,
    });
    expect(parseLocation('D:\\a\\shop\\tests\\a.spec.ts:3:1')).toEqual({
      file: 'D:/a/shop/tests/a.spec.ts',
      line: 3,
      column: 1,
    });
    expect(parseLocation('unknown')).toBeNull();
    expect(parseLocation(42)).toBeNull();
  });

  test('finds the config’s folder on the CI machine from a step in the test’s own spec', () => {
    expect(ciBaseOf('/ci/work/shop/tests/checkout.spec.ts', 'tests/checkout.spec.ts')).toBe('/ci/work/shop/');
    expect(ciBaseOf('/ci/work/shop/tests/checkout.spec.ts', './tests/checkout.spec.ts')).toBe('/ci/work/shop/');
    // A step in another file, or a spec that climbs out of the folder, says nothing.
    expect(ciBaseOf('/ci/work/shop/tests/pages/checkout.page.ts', 'tests/checkout.spec.ts')).toBeNull();
    expect(ciBaseOf('/ci/work/shop/my-tests/checkout.spec.ts', 'tests/checkout.spec.ts')).toBeNull();
    expect(ciBaseOf('/ci/work/shop/../x.spec.ts', '../x.spec.ts')).toBeNull();
  });

  test('maps a file under that folder to the workspace’s, and nothing outside it or missing', () => {
    const base = '/ci/work/shop/';
    const at = (file: string) => workspaceFile(ROOT, ciRelative(base, file), exists);
    expect(at('/ci/work/shop/tests/pages/checkout.page.ts')).toBe(path.join(ROOT, 'tests/pages/checkout.page.ts'));
    expect(at('/ci/work/other/tests/checkout.spec.ts')).toBeNull();
    expect(at('/ci/work/shop/node_modules/@playwright/test/lib/index.js')).toBeNull();
    expect(at('/ci/work/shop/tests/../../etc/passwd')).toBeNull();
    expect(at('/ci/work/shop/tests/gone.spec.ts')).toBeNull();
    expect(workspaceFile(ROOT, ciRelative(null, '/ci/work/shop/tests/checkout.spec.ts'), exists)).toBeNull();
  });
});

describe('what a CI session says', () => {
  test('names its progress and each position in words', () => {
    expect(ciSummary({ total: 40, done: 12, failed: 1, flaky: 2, skipped: 0, status: 'running' })).toBe(
      '12 of 40 tests · 1 failed · 2 flaky',
    );
    expect(ciSummary({ total: 1, done: 1, failed: 0, flaky: 0, skipped: 0, status: 'finalizing' })).toBe(
      '1 of 1 test · finishing',
    );
    expect(positionText(78, { lane: 2, shard: null }, 'Click')).toBe('CI run #78 · worker 2: Click');
    expect(positionText(78, { lane: 2, shard: 3 }, 'Click')).toBe('CI run #78 · shard 3, worker 2: Click');
    expect(positionText(78, { lane: null, shard: null }, 'Click')).toBe('CI run #78: Click');
  });

  test('lists the running tests first, then the latest that ended, a failure before a pass', () => {
    const test = (status: 'running' | 'passed' | 'failed', seq: number, lane: number | null = null) => ({
      status,
      seq,
      lane,
      shard: null,
    });
    const listed = listedTests([test('passed', 1), test('running', 2, 2), test('failed', 3), test('running', 4, 1)]);
    expect(listed.map((t) => t.seq)).toEqual([4, 2, 3, 1]);
    const many = [test('failed', 0), ...Array.from({ length: 200 }, (_, i) => test('passed', i + 1))];
    const kept = listedTests(many);
    expect(kept).toHaveLength(MAX_CI_TESTS);
    expect(kept.some((t) => t.status === 'failed')).toBe(true);
    expect(kept[0]!.seq).toBe(200);
  });
});

describe('the CI sessions', () => {
  /** The run streams followed, each with its listener, and whether it was let go. */
  const followed = new Map<number, { listener: (event: RunEvent) => void; stopped: boolean }>();
  const streams = {
    follow: (_client: unknown, runId: number, listener: (event: RunEvent) => void) => {
      const entry = { listener, stopped: false };
      followed.set(runId, entry);
      return () => {
        entry.stopped = true;
      };
    },
  };
  const send = (runId: number, type: string, data: Record<string, unknown>) =>
    followed.get(runId)!.listener({ type, data });
  let sessions: CiSessions | null = null;

  afterEach(() => {
    sessions?.dispose();
    followed.clear();
  });

  function context(branch = 'feature/pay'): PiwiContext {
    return {
      root: ROOT,
      client: {
        connection: { serverUrl: 'https://piwi.example', apiKey: 'pd_key' },
        runUrl: (id: number) => `https://piwi.example/test-runs/${id}`,
      },
      project: { id: 7, name: 'Shop' },
      runBranch: branch,
      checkedOutBranch: branch,
      failures: null,
      live: null,
    } as unknown as PiwiContext;
  }

  const ciRun = (id: number, startTime = '2026-11-12T10:00:00.000Z', branch = 'feature/pay') => ({
    id,
    status: 'running',
    branch,
    startTime,
    metadata: { piwiOrigin: { kind: 'ci' } },
    totalTests: 4,
    passedTests: 0,
    failedTests: 0,
    skippedTests: 0,
  });

  function start(contexts: PiwiContext[]) {
    const heard: CiSession[] = [];
    sessions = new CiSessions({ contexts: () => contexts, streams, changed: (s) => heard.push(s), exists, pushMs: 0 });
    return heard;
  }

  const settle = () => new Promise((r) => setTimeout(r, 10));

  test('follow a CI run of the branch, its tests and the line each running test is at, read-only', async () => {
    const c = context();
    const heard = start([c]);
    sessions!.offer(c, ciRun(78));
    await settle();
    expect(heard[0]).toMatchObject({
      runId: 78,
      root: ROOT,
      url: 'https://piwi.example/test-runs/78',
      name: 'CI run #78',
      branch: 'feature/pay',
      progress: { total: 4, done: 0, status: 'running' },
      summary: '0 of 4 tests',
      tests: [],
      watchable: false,
      ended: false,
    });

    const begin = {
      title: 'pays',
      filePath: 'tests/checkout.spec.ts',
      suitePath: ['checkout'],
      location: 'tests/checkout.spec.ts:3:1',
      workerIndex: 4,
      parallelIndex: 1,
      shardIndex: null,
      retries: 0,
      browser: { projectName: 'chromium' },
    };
    send(78, 'live-view', { enabled: true, keyed: true });
    send(78, 'test-begin', begin);
    // A step in the spec teaches where the config sits on CI; one in a page object is then a file of the workspace.
    send(78, 'step-begin', {
      title: 'Navigate to "/cart"',
      location: '/ci/work/shop/tests/checkout.spec.ts:4:14',
      workerIndex: 4,
      shardIndex: null,
      stepCategory: 'pw:api',
    });
    send(78, 'step-begin', {
      title: 'Click',
      subtitle: "getByRole('button', { name: 'Pay' })",
      location: '/ci/work/shop/tests/pages/checkout.page.ts:9:22',
      workerIndex: 4,
      shardIndex: null,
      stepCategory: 'pw:api',
    });
    // A fixture's step is no place in the test's code.
    send(78, 'step-begin', {
      title: 'Fixture "page"',
      location: '/ci/work/shop/tests/fixtures.ts:1:1',
      workerIndex: 4,
      shardIndex: null,
      stepCategory: 'fixture',
    });
    await settle();
    const running = heard.at(-1)!;
    expect(running.watchable).toBe(true);
    expect(running.tests).toEqual([
      {
        title: ['checkout', 'pays'],
        uri: uri('tests/checkout.spec.ts'),
        line: 2,
        project: 'chromium',
        status: 'running',
        retry: 0,
        lane: 2,
        shard: null,
        at: {
          title: "Click getByRole('button', { name: 'Pay' })",
          uri: uri('tests/pages/checkout.page.ts'),
          line: 8,
          character: 21,
          text: "CI run #78 · worker 2: Click getByRole('button', { name: 'Pay' })",
        },
        watch: 'https://piwi.example/test-runs/78?watch=2',
      },
    ]);

    // The step's end goes back to the step it ran in.
    send(78, 'step-end', {
      title: 'Click',
      location: '/ci/work/shop/tests/pages/checkout.page.ts:9:22',
      workerIndex: 4,
      shardIndex: null,
      stepCategory: 'pw:api',
    });
    await settle();
    expect(heard.at(-1)!.tests[0]!.at).toMatchObject({ uri: uri('tests/checkout.spec.ts'), line: 3 });

    // It ends timed out, as the instance stores it, and the tally comes from the instance's stream.
    send(78, 'test-completed', { ...begin, status: 'timedout' });
    sessions!.instanceEvent(c, {
      type: 'run-progress',
      runId: 78,
      projectId: 7,
      totalTests: 4,
      passedTests: 0,
      failedTests: 1,
      skippedTests: 0,
      didNotRunTests: 0,
    });
    await settle();
    const ended = heard.at(-1)!;
    expect(ended.tests[0]).toMatchObject({ status: 'failed', at: null, watch: null });
    expect(ended.summary).toBe('1 of 4 tests · 1 failed');

    // The run ends: the session's last word, and the stream let go.
    send(78, 'run-finished', { status: 'failed', totalTests: 4, passedTests: 3, failedTests: 1, skippedTests: 0 });
    expect(heard.at(-1)).toMatchObject({ runId: 78, ended: true, watchable: false, progress: { status: 'failed' } });
    expect(followed.get(78)!.stopped).toBe(true);
    expect(sessions!.sessions()).toEqual([]);
    // A read of the run from before its end follows it no more.
    sessions!.offer(c, ciRun(78));
    expect(sessions!.sessions()).toEqual([]);
  });

  test('follow only a CI run of the branch read or checked out, while it runs', async () => {
    const c = context();
    const heard = start([c]);
    sessions!.offer(c, { ...ciRun(80), metadata: { piwiOrigin: { kind: 'local' } } });
    sessions!.offer(c, ciRun(81, undefined, 'main'));
    sessions!.offer(c, { ...ciRun(82), status: 'passed' });
    // A run that names no origin is a CI run's when it names its CI; the latest run read carries its origin.
    sessions!.offer(c, { ...ciRun(83), metadata: { ci: { provider: 'github' } } });
    sessions!.offer(c, { ...ciRun(84), metadata: undefined, origin: 'ci-rerun' });
    await settle();
    expect([...new Set(heard.map((s) => s.runId))].sort()).toEqual([83, 84]);
  });

  test('follow the newest runs of one branch, and end those its context reads no more', async () => {
    const c = context();
    const heard = start([c]);
    sessions!.offer(c, ciRun(90, '2026-11-12T10:00:00.000Z'));
    sessions!.offer(c, ciRun(91, '2026-11-12T10:05:00.000Z'));
    // An older run than those followed is left; a newer one takes the oldest's place.
    sessions!.offer(c, ciRun(89, '2026-11-12T09:00:00.000Z'));
    sessions!.offer(c, ciRun(92, '2026-11-12T10:10:00.000Z'));
    await settle();
    expect(MAX_CI_RUNS).toBe(2);
    expect(
      sessions!
        .sessions()
        .map((s) => s.runId)
        .sort(),
    ).toEqual([91, 92]);
    expect(heard.find((s) => s.runId === 90 && s.ended)).toBeTruthy();
    expect(heard.some((s) => s.runId === 89)).toBe(false);

    // The workspace checks out another branch.
    (c as { runBranch: string | null }).runBranch = 'main';
    (c as { checkedOutBranch: string | null }).checkedOutBranch = 'main';
    sessions!.sync();
    expect(sessions!.sessions()).toEqual([]);
    expect(heard.filter((s) => s.ended).map((s) => s.runId)).toEqual([90, 91, 92]);
    expect([...followed.values()].every((f) => f.stopped)).toBe(true);
  });

  test('find a CI run the context reads in progress, and follow it once whatever reads it', async () => {
    const c = context();
    const other = context();
    (c as { failures: unknown }).failures = {
      run: { ...ciRun(95), origin: 'ci', flakyTests: 0, metadata: undefined },
      failures: [],
    };
    (other as { live: unknown }).live = {
      runId: 95,
      status: 'running',
      done: 0,
      total: 4,
      failed: 0,
      startedAt: '2026-11-12T10:00:00.000Z',
      own: false,
      ci: true,
      branch: 'feature/pay',
    };
    const heard = start([c, other]);
    sessions!.sync();
    await settle();
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ runId: 95, root: ROOT, ended: false });
  });
});
