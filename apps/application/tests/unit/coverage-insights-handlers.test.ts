import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/**
 * The coverage insights against a migrated SQLite database, with executions
 * ingested through `persistRunCases` like a reporter's: eight runs of a
 * checkout test whose coverage takes a coupon branch in the runs where a
 * coupon test finished before it, and fails in three of them.
 */

vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async readFile() {
      throw new Error('no file');
    },
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { storeRunCoverage } = await import('../../server/utils/coverage');
const {
  CoverageInsightInputError,
  getCoverageDivergence,
  getCoverageLoss,
  getCoverageReach,
  getNearestTest,
  getPathVariation,
  projectRecordsCoverage,
  resolveTestByTitle,
} = await import('../../shared/handlers/coverage-insights');
const { classifyAndPersistFlakyRootCause } = await import('../../shared/handlers/flaky-classify');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);
const BLOB = 'a'.repeat(40);
const BASKET = 'src/Services/BasketService.cs';
const LAYOUT = 'src/Web/Views/_Layout.cshtml';
const ORDERS = 'src/Services/OrderService.cs';
const COUPONS = 'src/Services/CouponService.cs';
const FAILURE = 'Error: expect(received).toBe(expected)\n\nExpected: 90\nReceived: 100';

let db: TempDb;
let close: () => Promise<void>;

const file = (path: string, lines: Array<[number, number]>, functions?: Array<[number, number]>) => ({
  path,
  runtime: 'server',
  blob: BLOB,
  lines,
  ...(functions ? { functions } : {}),
});

function execution(
  title: string,
  opts: {
    status?: 'passed' | 'failed';
    start: number;
    worker: number;
    files?: unknown[];
    project?: string;
    incomplete?: boolean;
  },
) {
  const project = opts.project ?? 'chromium';
  return {
    title,
    filePath: 'tests/shop.spec.ts',
    status: opts.status ?? 'passed',
    ...(opts.status === 'failed' ? { error: FAILURE } : {}),
    duration: 1_000,
    line: 1,
    column: 1,
    startedAt: opts.start,
    workerIndex: opts.worker,
    browser: { projectName: project, browserName: project },
    ...(opts.files ? { coverage: { v: 1, files: opts.files, ...(opts.incomplete ? { incomplete: true } : {}) } } : {}),
  };
}

async function idOf(title: string): Promise<number> {
  const [row] = await db
    .select({ id: schema.testCases.id })
    .from(schema.testCases)
    .where(eq(schema.testCases.title, title));
  return row!.id;
}

async function executionOf(runId: number, title: string, project = 'chromium'): Promise<number> {
  const [row] = await db
    .select({ id: schema.testRunsCases.id })
    .from(schema.testRunsCases)
    .innerJoin(schema.testCases, eq(schema.testRunsCases.testCaseId, schema.testCases.id))
    .where(
      and(
        eq(schema.testRunsCases.testRunId, runId),
        eq(schema.testCases.title, title),
        eq(schema.testRunsCases.browserName, project),
      ),
    );
  return row!.id;
}

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop', defaultBranch: 'main' },
    { id: 2, name: 'docs', defaultBranch: 'main' },
  ]);
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);

  for (let run = 1; run <= 8; run++) {
    const start = T0 + run * HOUR;
    const couponFirst = run % 2 === 0;
    const failed = couponFirst && run < 8;
    await db.insert(schema.testRuns).values({
      id: run,
      projectId: 1,
      status: failed ? 'failed' : 'passed',
      startTime: new Date(start),
      branch: 'main',
      metadata: { scm: { commit: String(run).repeat(40), branch: 'main' } },
      totalTests: 5,
    });
    await persistRunCases(db as never, 1, run, [
      execution('browses', { start, worker: 0, files: [file(LAYOUT, [[1, 9]])] }),
      execution('seeds a coupon', {
        start: couponFirst ? start + 1_000 : start + 5_000,
        worker: 0,
        files: [file(BASKET, [[10, 20]]), file(COUPONS, [[1, 9]])],
      }),
      execution('checks out', {
        status: failed ? 'failed' : 'passed',
        start: start + 3_000,
        worker: 1,
        files: [
          file(LAYOUT, [[1, 9]]),
          file(
            BASKET,
            couponFirst
              ? [
                  [10, 20],
                  [50, 60],
                ]
              : [[10, 20]],
          ),
          ...(failed ? [file(ORDERS, [[1, 5]])] : []),
        ],
      }),
      execution('pays', { start: start + 7_000, worker: 0, files: [file(BASKET, [[55, 60]], [[45, 75]])] }),
      execution('refunds', { start: start + 9_000, worker: 1, files: [file(BASKET, [[50, 52]])] }),
      // A later passing execution in another Playwright project.
      ...(run === 5
        ? [
            execution('checks out', {
              start: start + 4_000,
              worker: 2,
              project: 'firefox',
              files: [file(LAYOUT, [[1, 9]])],
            }),
          ]
        : []),
    ]);
  }
  await db.update(schema.testCases).set({ flakyRootCause: 'timing' }).where(eq(schema.testCases.title, 'pays'));
  await db.insert(schema.quarantinedTests).values({ projectId: 1, testCaseId: await idOf('refunds') });
  await storeRunCoverage(db as never, 8, 1, [
    {
      path: BASKET,
      runtime: 'server',
      blob: BLOB,
      executable: [
        [1, 52],
        [54, 80],
      ],
    },
  ]);
  await db
    .insert(schema.testCases)
    .values({ id: 99, projectId: 1, filePath: 'tests/shop.spec.ts', title: 'no coverage' });
});

afterAll(async () => {
  await close();
});

describe('getCoverageDivergence', () => {
  test('compares a failure with the latest earlier passing execution of the same project and branch', async () => {
    const answer = await getCoverageDivergence(db as never, await executionOf(6, 'checks out'));
    expect(answer).toMatchObject({
      available: true,
      baseline: {
        executionId: await executionOf(5, 'checks out'),
        runId: 5,
        branch: 'main',
        commit: '5'.repeat(40),
        project: 'chromium',
        sameProject: true,
        sameBranch: true,
      },
      summary: { filesOnlyHere: 1, filesDiverged: 1, linesOnlyHere: 16, filesCompared: 2 },
    });
    expect(answer!.files).toEqual([
      { path: ORDERS, runtime: 'server', status: 'only-here', blob: BLOB, linesOnlyHere: [[1, 5]] },
      { path: BASKET, runtime: 'server', status: 'diverged', blob: BLOB, linesOnlyHere: [[50, 60]] },
    ]);
  });

  test('not-failing, no-baseline, and null for an unknown execution', async () => {
    expect(await getCoverageDivergence(db as never, await executionOf(5, 'checks out'))).toMatchObject({
      available: false,
      reason: 'not-failing',
    });
    expect(await getCoverageDivergence(db as never, 999_999)).toBeNull();
    // The failure of run 2 has run 1 before it; nothing passed before run 1.
    expect((await getCoverageDivergence(db as never, await executionOf(2, 'checks out')))?.baseline?.runId).toBe(1);
  });
});

describe('getPathVariation', () => {
  test('finds the code that ran in half the runs and the earlier test that predicts it', async () => {
    const answer = await getPathVariation(db as never, await idOf('checks out'));
    expect(answer).toMatchObject({
      available: true,
      project: 'chromium',
      executions: { compared: 8, incomplete: 0, failed: 3 },
      files: { compared: 3, changedVersion: 0 },
      orderDependent: true,
      explanation: {
        varying: 0,
        testCaseId: await idOf('seeds a coupon'),
        title: 'seeds a coupon',
        relation: 'earlier-in-run',
        effect: 'runs-code',
        agreement: 1,
        before: { executions: 4, ranCode: 4 },
        notBefore: { executions: 4, ranCode: 0 },
      },
      failuresFollow: { side: 'ran', failed: 3, onSide: 3 },
    });
    const varying = answer!.varying[answer!.explanation!.varying]!;
    expect(varying).toMatchObject({ ranIn: 4, failedIn: 3, files: [{ path: BASKET, lines: [[50, 60]] }] });
  });

  test('a test with one execution per run order and no variation has nothing to explain', async () => {
    const answer = await getPathVariation(db as never, await idOf('browses'));
    expect(answer).toMatchObject({ available: true, varying: [], orderDependent: false });
    expect(answer!.explanation).toBeUndefined();
    expect(await getPathVariation(db as never, 99)).toMatchObject({ available: false, reason: 'no-coverage' });
  });

  test('flaky classification reads the order dependency', async () => {
    const result = await classifyAndPersistFlakyRootCause(db as never, 1, await idOf('checks out'));
    expect(result.rootCause).toBe('order');
  });
});

describe('getCoverageLoss', () => {
  test('the code only the given tests run, ignoring quarantined tests and naming what only flaky tests run', async () => {
    const answer = await getCoverageLoss(db as never, 1, [await idOf('checks out'), 12345]);
    expect(answer).toMatchObject({
      available: true,
      branch: 'main',
      tests: [{ title: 'checks out', quarantined: false, hasCoverage: true }],
      unknownTestIds: [12345],
      summary: { files: 2, filesCovered: 1, filesPartial: 1, lines: 5, onlyFlakyLines: 6 },
    });
    expect(answer!.files).toEqual([
      {
        path: BASKET,
        runtime: 'server',
        blob: BLOB,
        status: 'partial',
        // Lines 50-52 are run by a quarantined test too, which does not count.
        lines: [[50, 54]],
        onlyFlakyLines: [[55, 60]],
        otherTests: { steady: 1, flaky: 1 },
      },
    ]);
  });

  test('a quarantined test is read like any other, and no coverage says so', async () => {
    // Its lines are run by the checkout test, which the order dependency above classified flaky.
    expect(await getCoverageLoss(db as never, 1, [await idOf('refunds')])).toMatchObject({
      available: true,
      tests: [{ title: 'refunds', quarantined: true }],
      files: [{ path: BASKET, status: 'partial', onlyFlakyLines: [[50, 52]], otherTests: { steady: 1, flaky: 2 } }],
      summary: { filesCovered: 0, lines: 0, onlyFlakyLines: 3 },
    });
    expect(await getCoverageLoss(db as never, 1, [99])).toMatchObject({ available: false, reason: 'no-coverage' });
    expect(await getCoverageLoss(db as never, 2, [99])).toBeNull();
  });
});

describe('getCoverageReach', () => {
  test('which target lines the latest execution ran, the lines that cannot run, and the test to copy', async () => {
    const checkout = await idOf('checks out');
    const answer = await getCoverageReach(db as never, checkout, {
      file: 'Services/BasketService.cs',
      lines: [
        [50, 53],
        [70, 70],
      ],
    });
    expect(answer).toMatchObject({
      available: true,
      executionId: await executionOf(8, 'checks out'),
      runId: 8,
      reachedFile: true,
      path: BASKET,
      runtime: 'server',
      blob: BLOB,
      granularity: 'lines',
      complete: true,
      ran: [[50, 52]],
      notRan: [[70, 70]],
      unknown: [],
      notExecutable: [[53, 53]],
      allRan: false,
      nearest: { testCaseId: await idOf('pays'), function: [45, 75], executedLines: 6, sameVersion: true },
    });
  });

  test('an execution of another test is refused, and a test without coverage says so', async () => {
    await expect(
      getCoverageReach(db as never, await idOf('checks out'), {
        file: BASKET,
        lines: [[1, 2]],
        executionId: await executionOf(8, 'pays'),
      }),
    ).rejects.toBeInstanceOf(CoverageInsightInputError);
    expect(await getCoverageReach(db as never, 99, { file: BASKET, lines: [[1, 2]] })).toMatchObject({
      available: false,
      reason: 'no-coverage',
    });
    expect(await getCoverageReach(db as never, 123_456, { file: BASKET, lines: [[1, 2]] })).toBeNull();
  });

  test('the nearest test of a file without a test, and a test named by its file and title', async () => {
    expect(await getNearestTest(db as never, 1, BASKET, [[50, 51]])).toMatchObject({
      testCaseId: await idOf('checks out'),
      function: [45, 75],
      executedLines: 11,
    });
    expect(await resolveTestByTitle(db as never, 1, 'shop.spec.ts', 'pays')).toBe(await idOf('pays'));
    expect(await resolveTestByTitle(db as never, 1, 'other.spec.ts', 'pays')).toBeNull();
    expect(await projectRecordsCoverage(db as never, 1)).toBe(true);
    expect(await projectRecordsCoverage(db as never, 2)).toBe(false);
  });
});
