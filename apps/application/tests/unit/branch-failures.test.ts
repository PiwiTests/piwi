import { beforeAll, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { BranchFailuresRunError, errorFrames, errorMessage, getBranchFailures, parseBranchFailuresQuery } =
  await import('../../server/utils/branch-failures');

let db: ReturnType<typeof drizzle<typeof schema>>;

const ERROR = [
  "Error: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Pay now' })",
  '',
  '    at CheckoutPage.pay (/ci/work/tests/pages/checkout.page.ts:12:19)',
  '    at /ci/work/tests/checkout.spec.ts:8:3',
].join('\n');

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([{ id: 1, name: 'shop' }]);
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'adds' },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 1, projectId: 1, status: 'failed', branch: 'main', startTime: new Date(1000_000), totalTests: 2 },
    { id: 2, projectId: 1, status: 'failed', branch: 'feature/pay', startTime: new Date(2000_000), totalTests: 2 },
    { id: 3, projectId: 1, status: 'passed', branch: 'main', startTime: new Date(3000_000), totalTests: 2 },
    { id: 4, projectId: 1, status: 'failed', branch: 'feature/retry', startTime: new Date(500_000), totalTests: 2 },
  ]);
  await db.insert(schema.testRunsCases).values([
    { id: 10, testRunId: 2, testCaseId: 1, status: 'failed', error: ERROR, line: 7 },
    { id: 11, testRunId: 2, testCaseId: 2, status: 'passed', line: 3 },
    { id: 12, testRunId: 1, testCaseId: 2, status: 'timedOut', error: 'Test timeout of 30000ms exceeded.', line: 3 },
    // Run 4: test 1 fails every retry on chromium and passes on firefox; test 2 passes on its retry.
    ...[0, 1, 2].map((retries) => ({
      id: 20 + retries,
      testRunId: 4,
      testCaseId: 1,
      retries,
      browserName: 'chromium',
      status: 'failed',
      error: ERROR,
      line: 7,
    })),
    { id: 23, testRunId: 4, testCaseId: 1, retries: 0, browserName: 'firefox', status: 'passed', line: 7 },
    {
      id: 24,
      testRunId: 4,
      testCaseId: 2,
      retries: 0,
      browserName: 'chromium',
      status: 'failed',
      error: ERROR,
      line: 3,
    },
    { id: 25, testRunId: 4, testCaseId: 2, retries: 1, browserName: 'chromium', status: 'passed', line: 3 },
  ]);
  await db.insert(schema.files).values([
    { testRunsCaseId: 10, type: 'trace', path: 'traces/10-a.zip' },
    { testRunsCaseId: 10, type: 'screenshot', path: 'shots/10-early.png' },
    { testRunsCaseId: 10, type: 'screenshot', path: 'shots/10-failure.png' },
  ]);
});

describe('getBranchFailures', () => {
  test("lists the branch's newest run and its failures at their failing call", async () => {
    const result = await getBranchFailures(db as never, 1, 'feature/pay');
    expect(result.run).toMatchObject({ id: 2, status: 'failed', branch: 'feature/pay', totalTests: 2 });
    expect(result.failures).toEqual([
      {
        executionId: 10,
        testCaseId: 1,
        clusterId: null,
        title: 'pays',
        file: 'tests/checkout.spec.ts',
        line: 7,
        status: 'failed',
        headline: expect.stringContaining('Pay now'),
        location: '/ci/work/tests/pages/checkout.page.ts:12:19',
        message:
          "Error: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Pay now' })",
        frames: ['/ci/work/tests/pages/checkout.page.ts:12:19', '/ci/work/tests/checkout.spec.ts:8:3'],
        traces: ['traces/10-a.zip'],
        screenshot: 'shots/10-failure.png',
        source: 'baseline',
        runId: 2,
        browserName: null,
        duration: null,
        isNew: false,
        clusterTitle: null,
        owner: null,
      },
    ]);
    expect(result.overlays).toEqual([]);
    expect(result.resolved).toEqual([]);
  });

  test('reads the newest run on the branch, which may have no failure', async () => {
    const result = await getBranchFailures(db as never, 1, 'main');
    expect(result.run?.id).toBe(3);
    expect(result.failures).toEqual([]);
  });

  test('without a branch, reads the newest run of any branch', async () => {
    expect((await getBranchFailures(db as never, 1, null)).run?.id).toBe(3);
  });

  test('lists each test once per project, at its last attempt, and leaves out a pass on a retry', async () => {
    const result = await getBranchFailures(db as never, 1, 'feature/retry');
    expect(result.failures.map((f) => [f.executionId, f.testCaseId])).toEqual([[22, 1]]);
  });

  test('a branch without a run has no run', async () => {
    expect(await getBranchFailures(db as never, 1, 'nope')).toEqual({
      run: null,
      overlays: [],
      failures: [],
      resolved: [],
    });
  });
});

describe('getBranchFailures with the runs laid over the latest complete run', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 6, 10, minutes));
  const origin = (kind: string, commit = 'a1b2c3d') => ({
    piwiOrigin: { kind },
    scm: { branch: 'feature/fix', commit },
  });
  const run = (id: number, minutes: number, kind: string, over: Record<string, unknown> = {}) => ({
    id,
    projectId: 2,
    status: 'failed',
    branch: 'feature/fix',
    startTime: at(minutes),
    metadata: origin(kind),
    origin: kind,
    isFullRun: 0,
    totalTests: 3,
    ...over,
  });
  const execution = (id: number, testRunId: number, testCaseId: number, status: string, over = {}) => ({
    id,
    testRunId,
    testCaseId,
    status,
    retries: 0,
    browserName: 'chromium',
    line: testCaseId - 100 + 3,
    ...(status === 'passed' || status === 'skipped' ? {} : { error: ERROR }),
    ...over,
  });

  beforeAll(async () => {
    await db.insert(schema.projects).values([{ id: 2, name: 'shop-fix' }]);
    await db.insert(schema.testCases).values([
      { id: 101, projectId: 2, filePath: 'tests/rows.spec.ts', title: 'removes a row' },
      { id: 102, projectId: 2, filePath: 'tests/checkout.spec.ts', title: 'pays' },
      { id: 103, projectId: 2, filePath: 'tests/cart.spec.ts', title: 'adds', owner: '@team-cart' },
      { id: 104, projectId: 2, filePath: 'tests/login.spec.ts', title: 'logs in' },
      { id: 105, projectId: 2, filePath: 'tests/search.spec.ts', title: 'searches' },
      { id: 106, projectId: 2, filePath: 'tests/filter.spec.ts', title: 'filters' },
    ]);
    await db.insert(schema.testRuns).values([
      // The latest complete run: the CI run the overlays are laid over.
      run(20, 0, 'ci', { isFullRun: 1, totalTests: 7 }),
      run(21, 10, 'editor'),
      run(22, 20, 'flake-lab', { status: 'passed', metadata: { piwiFlakeLab: { experimentId: 'e', armId: 'a' } } }),
      // Older than the CI run, still running, and on another branch: none is laid over it.
      run(23, -10, 'editor', { status: 'passed' }),
      run(24, 30, 'editor', { status: 'running' }),
      run(25, 25, 'editor', { branch: 'main' }),
      run(26, 15, 'editor', { metadata: origin('editor', 'e4f5a6b') }),
      // A full run on a developer's machine, older than the CI run.
      run(27, -20, 'local', { isFullRun: 1, totalTests: 7 }),
    ]);
    await db.insert(schema.failureClusters).values([
      {
        id: 7,
        projectId: 2,
        fingerprint: 'fp-login',
        signature: 'getByRole button Sign in',
        title: 'Sign-in button gone',
        firstSeenRunId: 20,
        lastSeenRunId: 20,
      },
    ]);
    await db.insert(schema.testRunsCases).values([
      execution(200, 20, 101, 'failed'),
      execution(201, 20, 102, 'passed'),
      execution(202, 20, 103, 'failed', { isNewRegression: 1, duration: 4120 }),
      execution(203, 20, 104, 'failed', { browserName: 'firefox', failureClusterId: 7 }),
      execution(207, 20, 104, 'passed'),
      execution(204, 20, 105, 'failed'),
      execution(205, 20, 106, 'failed'),
      // An editor run: one test still failing, a passing test failing, and a pass on another project.
      execution(210, 21, 101, 'failed'),
      execution(211, 21, 102, 'failed', {
        error: 'Error: expect(received).toBe(expected)\n\nExpected: 2\nReceived: 3',
      }),
      execution(212, 21, 104, 'passed'),
      // A Flake Lab run passes a failing test: it replays the test under injected conditions.
      execution(220, 22, 105, 'passed'),
      execution(230, 23, 103, 'passed'),
      execution(240, 24, 102, 'passed'),
      execution(250, 25, 101, 'passed'),
      // The newest editor run: the fixed test passes, another fails with another error, one is skipped.
      execution(260, 26, 101, 'passed', { line: 9 }),
      execution(261, 26, 103, 'failed', { error: 'Error: cart badge says 0\n    at /w/tests/cart.spec.ts:12:7' }),
      execution(262, 26, 106, 'skipped'),
      execution(270, 27, 101, 'failed'),
      execution(271, 27, 102, 'passed'),
      execution(272, 27, 104, 'failed'),
      execution(251, 25, 102, 'failed'),
    ]);
    await db.insert(schema.files).values([{ testRunsCaseId: 261, type: 'trace', path: 'traces/261.zip' }]);
  });

  test('lists the runs laid over it, newest first, with their commits', async () => {
    const result = await getBranchFailures(db as never, 2, 'feature/fix', { overlays: true });
    expect(result.run).toMatchObject({ id: 20, branch: 'feature/fix', origin: 'ci', commit: 'a1b2c3d' });
    expect(result.overlays).toEqual([
      {
        id: 26,
        status: 'failed',
        origin: 'editor',
        isFullRun: false,
        startTime: at(15).toISOString(),
        commit: 'e4f5a6b',
        totalTests: 3,
        passedTests: 0,
        failedTests: 0,
        flakyTests: 0,
        skippedTests: 0,
      },
      expect.objectContaining({ id: 21, origin: 'editor', commit: 'a1b2c3d' }),
    ]);
  });

  test('a test a newer editor run passed is resolved, and leaves the failures', async () => {
    const result = await getBranchFailures(db as never, 2, 'feature/fix', { overlays: true });
    expect(result.resolved).toEqual([
      {
        testCaseId: 101,
        title: 'removes a row',
        file: 'tests/rows.spec.ts',
        line: 9,
        browserName: 'chromium',
        runId: 26,
        executionId: 260,
        baselineExecutionId: 200,
      },
    ]);
    expect(result.failures.map((f) => f.testCaseId)).not.toContain(101);
  });

  test('lists the failures in file order, each from the newest run that ran it on its project', async () => {
    const result = await getBranchFailures(db as never, 2, 'feature/fix', { overlays: true });
    expect(result.failures.map((f) => [f.file, f.executionId, f.runId, f.source, f.isNew, f.note ?? null])).toEqual([
      ['tests/cart.spec.ts', 261, 26, 'overlay', false, null],
      ['tests/checkout.spec.ts', 211, 21, 'overlay', true, null],
      ['tests/filter.spec.ts', 205, 20, 'baseline', false, null],
      ['tests/login.spec.ts', 203, 20, 'baseline', false, 'passed on chromium in run #21'],
      ['tests/search.spec.ts', 204, 20, 'baseline', false, null],
    ]);
  });

  test('a test that failed again is listed from the later execution, with its error and evidence', async () => {
    const result = await getBranchFailures(db as never, 2, 'feature/fix', { overlays: true });
    expect(result.failures[0]).toMatchObject({
      executionId: 261,
      testCaseId: 103,
      title: 'adds',
      owner: '@team-cart',
      browserName: 'chromium',
      headline: expect.stringContaining('cart badge says 0'),
      location: '/w/tests/cart.spec.ts:12:7',
      traces: ['traces/261.zip'],
      source: 'overlay',
      isNew: false,
    });
  });

  test('a test that passed in the latest complete run and fails in an overlay is new', async () => {
    const result = await getBranchFailures(db as never, 2, 'feature/fix', { overlays: true });
    expect(result.failures.find((f) => f.testCaseId === 102)).toMatchObject({
      executionId: 211,
      source: 'overlay',
      runId: 21,
      isNew: true,
      message: 'Error: expect(received).toBe(expected)\n\nExpected: 2\nReceived: 3',
    });
  });

  test('a pass on another project resolves nothing, and is noted on the failure', async () => {
    const result = await getBranchFailures(db as never, 2, 'feature/fix', { overlays: true });
    expect(result.failures.find((f) => f.testCaseId === 104)).toMatchObject({
      executionId: 203,
      browserName: 'firefox',
      clusterId: 7,
      clusterTitle: 'Sign-in button gone',
      note: 'passed on chromium in run #21',
    });
    expect(result.resolved.map((r) => r.testCaseId)).not.toContain(104);
  });

  test('a Flake Lab run, a run still running, an older run and another branch’s run lay nothing over it', async () => {
    const result = await getBranchFailures(db as never, 2, 'feature/fix', { overlays: true });
    expect(result.overlays.map((o) => o.id)).toEqual([26, 21]);
    expect(result.failures.find((f) => f.testCaseId === 105)).toMatchObject({ executionId: 204, source: 'baseline' });
  });

  test('a skipped test resolves nothing', async () => {
    const result = await getBranchFailures(db as never, 2, 'feature/fix', { overlays: true });
    expect(result.failures.find((f) => f.testCaseId === 106)).toMatchObject({ executionId: 205, source: 'baseline' });
  });

  test('without overlays, lists the latest complete run’s failures alone', async () => {
    const result = await getBranchFailures(db as never, 2, 'feature/fix');
    expect(result.overlays).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.failures.map((f) => [f.executionId, f.source, f.runId, f.isNew, f.note ?? null])).toEqual([
      [202, 'baseline', 20, true, null],
      [205, 'baseline', 20, false, null],
      [203, 'baseline', 20, false, null],
      [200, 'baseline', 20, false, null],
      [204, 'baseline', 20, false, null],
    ]);
    expect(result.failures[0]).toMatchObject({ owner: '@team-cart', duration: 4120, browserName: 'chromium' });
  });
});

describe('getBranchFailures with a chosen baseline', () => {
  test('a run chosen by its id is the baseline, with the runs of its branch started after it laid over it', async () => {
    const result = await getBranchFailures(db as never, 2, 'main', { overlays: true, run: 21 });
    expect(result.run).toMatchObject({ id: 21, branch: 'feature/fix', origin: 'editor' });
    expect(result.overlays.map((o) => o.id)).toEqual([26]);
    expect(result.resolved.map((r) => [r.testCaseId, r.runId, r.baselineExecutionId])).toEqual([[101, 26, 210]]);
    expect(result.failures.map((f) => [f.executionId, f.source, f.isNew])).toEqual([
      [261, 'overlay', true],
      [211, 'baseline', false],
    ]);
  });

  test('a run of another project is refused, and a missing run is not found', async () => {
    const other = getBranchFailures(db as never, 2, null, { run: 1 });
    await expect(other).rejects.toBeInstanceOf(BranchFailuresRunError);
    await expect(other).rejects.toMatchObject({ statusCode: 400 });
    await expect(getBranchFailures(db as never, 2, null, { run: 999 })).rejects.toMatchObject({ statusCode: 404 });
  });

  test("a developer's own runs: the newest complete local run, with only local runs laid over it", async () => {
    const result = await getBranchFailures(db as never, 2, 'feature/fix', { overlays: true, origin: 'local' });
    expect(result.run).toMatchObject({ id: 27, origin: 'local' });
    expect(result.overlays.map((o) => o.id)).toEqual([26, 21, 23]);
    expect(result.resolved.map((r) => [r.testCaseId, r.runId]).sort()).toEqual([
      [101, 26],
      [104, 21],
    ]);
    expect(result.failures.map((f) => [f.executionId, f.source, f.isNew])).toEqual([
      [261, 'overlay', true],
      [211, 'overlay', true],
    ]);
  });

  test("without a complete local run, a developer's runs of the branch are the overlays alone", async () => {
    const result = await getBranchFailures(db as never, 2, 'main', { overlays: true, origin: 'local' });
    expect(result.run).toBeNull();
    expect(result.overlays.map((o) => o.id)).toEqual([25]);
    expect(result.failures.map((f) => [f.executionId, f.runId, f.source, f.isNew])).toEqual([
      [251, 25, 'overlay', true],
    ]);
    expect(result.resolved).toEqual([]);
    expect(await getBranchFailures(db as never, 2, 'main', { origin: 'local' })).toEqual({
      run: null,
      overlays: [],
      failures: [],
      resolved: [],
    });
  });
});

describe('parseBranchFailuresQuery', () => {
  test('reads the branch, the overlays, a run and the local origin', () => {
    expect(parseBranchFailuresQuery({ branch: ' main ', overlays: '1' })).toEqual({
      ok: true,
      branch: 'main',
      options: { overlays: true },
    });
    expect(parseBranchFailuresQuery({ run: '118', overlays: 'true' })).toEqual({
      ok: true,
      branch: null,
      options: { overlays: true, run: 118 },
    });
    expect(parseBranchFailuresQuery({ origin: 'local' })).toEqual({
      ok: true,
      branch: null,
      options: { overlays: false, origin: 'local' },
    });
  });

  test('refuses a run that is not an id, another origin, and a run with an origin', () => {
    for (const query of [{ run: 'abc' }, { run: '0' }, { origin: 'ci' }, { run: '3', origin: 'local' }]) {
      expect(parseBranchFailuresQuery(query)).toMatchObject({ ok: false });
    }
    expect(parseBranchFailuresQuery({ branch: 'x'.repeat(256) })).toMatchObject({ ok: false });
  });
});

describe('getBranchFailures with overlays that ran many other tests', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 7, 9, minutes));
  const run = (id: number, projectId: number, minutes: number, kind: string, over: Record<string, unknown> = {}) => ({
    id,
    projectId,
    status: 'passed',
    branch: 'main',
    startTime: at(minutes),
    metadata: { piwiOrigin: { kind }, scm: { branch: 'main' } },
    origin: kind,
    isFullRun: 1,
    ...over,
  });
  const execution = (id: number, testRunId: number, testCaseId: number, status: string) => ({
    id,
    testRunId,
    testCaseId,
    status,
    retries: 0,
    browserName: 'chromium',
    line: 1,
    ...(status === 'failed' ? { error: ERROR } : {}),
  });
  /** A full local run's passing executions of tests that never failed. */
  async function addPassingTests(projectId: number, testRunId: number, firstId: number) {
    const ids = Array.from({ length: 250 }, (_, i) => firstId + i);
    await db
      .insert(schema.testCases)
      .values(ids.map((id) => ({ id, projectId, filePath: `tests/many-${id}.spec.ts`, title: `passes ${id}` })));
    await db.insert(schema.testRunsCases).values(ids.map((id) => execution(id * 10, testRunId, id, 'passed')));
  }

  beforeAll(async () => {
    await db.insert(schema.projects).values([
      { id: 3, name: 'shop-full-local' },
      { id: 4, name: 'shop-green' },
    ]);
    await db.insert(schema.testCases).values([
      { id: 301, projectId: 3, filePath: 'tests/a.spec.ts', title: 'fixed locally' },
      { id: 302, projectId: 3, filePath: 'tests/b.spec.ts', title: 'broken locally' },
      { id: 401, projectId: 4, filePath: 'tests/c.spec.ts', title: 'broken on a green branch' },
    ]);
    await db
      .insert(schema.testRuns)
      .values([
        run(30, 3, 0, 'ci', { status: 'failed' }),
        run(31, 3, 10, 'local', { status: 'failed' }),
        run(40, 4, 0, 'ci'),
        run(41, 4, 10, 'local', { status: 'failed', isFullRun: 0 }),
      ]);
    await db
      .insert(schema.testRunsCases)
      .values([
        execution(3001, 30, 301, 'failed'),
        execution(3002, 30, 302, 'passed'),
        execution(3101, 31, 301, 'passed'),
        execution(3102, 31, 302, 'failed'),
        execution(4001, 40, 401, 'passed'),
        execution(4101, 41, 401, 'failed'),
      ]);
  });

  test('passing tests unrelated to the latest complete run change nothing', async () => {
    const before = await getBranchFailures(db as never, 3, 'main', { overlays: true });
    expect(before.resolved.map((r) => [r.testCaseId, r.executionId])).toEqual([[301, 3101]]);
    expect(before.failures.map((f) => [f.testCaseId, f.executionId, f.isNew])).toEqual([[302, 3102, true]]);
    await addPassingTests(3, 31, 1000);
    expect(await getBranchFailures(db as never, 3, 'main', { overlays: true })).toEqual(before);
  });

  test('with no failure in the latest complete run, an overlay’s failures are new', async () => {
    const before = await getBranchFailures(db as never, 4, 'main', { overlays: true });
    expect(before.failures.map((f) => [f.testCaseId, f.source, f.isNew])).toEqual([[401, 'overlay', true]]);
    expect(before.resolved).toEqual([]);
    await addPassingTests(4, 41, 2000);
    expect(await getBranchFailures(db as never, 4, 'main', { overlays: true })).toEqual(before);
  });
});

describe('errorMessage', () => {
  test('drops ANSI codes and the stack, and marks a message it shortens', () => {
    expect(errorMessage('\u001b[31mError: boom\u001b[39m\n\n\n\nExpected: 1\n    at /a.ts:1:1')).toBe(
      'Error: boom\n\nExpected: 1',
    );
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    expect(errorMessage(long)?.split('\n')).toHaveLength(13);
    expect(errorMessage(long)?.endsWith('\n…')).toBe(true);
    expect(errorMessage('x'.repeat(5000))).toHaveLength(1002);
    expect(errorMessage(null)).toBeNull();
    expect(errorMessage('    at /a.ts:1:1')).toBeNull();
  });
});

describe('errorFrames', () => {
  test('lists each frame outside node_modules once, innermost first', () => {
    const error = [
      'Error: boom',
      '    at f (/a.ts:1:2)',
      '    at /node_modules/x.js:1:1',
      '    at f (/a.ts:1:2)',
      '    at /b.ts:3:4',
    ];
    expect(errorFrames(error.join('\n'))).toEqual(['/a.ts:1:2', '/b.ts:3:4']);
    expect(errorFrames(null)).toEqual([]);
  });
});
