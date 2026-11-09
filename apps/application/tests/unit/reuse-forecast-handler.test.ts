import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/**
 * The pass reuse forecast against a migrated SQLite database, with executions
 * ingested through `persistRunCases` like a reporter's: runs of a cart test
 * and a login test on `main` and on a feature branch, the cart's code changing
 * once and the login test failing once with its code unchanged.
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
const { getReuseForecast } = await import('../../shared/handlers/reuse-forecast');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

const HOUR = 3_600_000;
const CART = 'src/cart.ts';
const AUTH = 'src/auth.ts';
const blob = (c: string) => c.repeat(40);

let db: TempDb;
let close: () => Promise<void>;

const file = (path: string, version: string) => ({
  path,
  runtime: 'browser',
  blob: blob(version),
  functions: [[1, 9]],
});

function execution(
  title: string,
  opts: { status?: 'passed' | 'failed'; start: number; files?: unknown[]; retries?: number },
) {
  return {
    title,
    filePath: 'tests/shop.spec.ts',
    status: opts.status ?? 'passed',
    ...(opts.status === 'failed' ? { error: 'Error: expect(received).toBe(expected)' } : {}),
    duration: 2_000,
    line: 1,
    column: 1,
    startedAt: opts.start,
    workerIndex: 0,
    retries: opts.retries ?? 0,
    browser: { projectName: 'chromium', browserName: 'chromium' },
    ...(opts.files ? { coverage: { v: 1, files: opts.files } } : {}),
  };
}

async function addRun(id: number, branch: string, cases: ReturnType<typeof execution>[], origin = 'ci'): Promise<void> {
  const start = Date.now() + id * HOUR;
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: 'passed',
    startTime: new Date(start),
    branch,
    origin,
    metadata: { scm: { commit: String(id).repeat(40), branch }, piwiOrigin: { kind: origin } },
    totalTests: cases.length,
  });
  await persistRunCases(db as never, 1, id, cases);
}

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values([{ id: 1, name: 'shop', defaultBranch: 'main' }]);
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);

  const cart = (version: string, start: number) => execution('adds to cart', { start, files: [file(CART, version)] });
  // Run 1: both pass. Run 2: same code. Run 3: the cart changed; login fails with its code unchanged.
  await addRun(1, 'main', [cart('a', 1), execution('logs in', { start: 2, files: [file(AUTH, 'c')] })]);
  await addRun(2, 'main', [cart('a', 3), execution('logs in', { start: 4, files: [file(AUTH, 'c')] })]);
  await addRun(3, 'main', [
    cart('b', 5),
    execution('logs in', { start: 6, status: 'failed', files: [file(AUTH, 'c')] }),
  ]);
  // Run 4 on a branch: the cart at its latest version, login with no coverage.
  await addRun(4, 'feature/coupons', [cart('b', 7), execution('logs in', { start: 8 })]);
  // Run 5, a `piwi bug` run, is read by no forecast.
  await addRun(5, 'main', [cart('b', 9)], 'bug');
});

afterAll(async () => {
  await close();
});

describe('getReuseForecast', () => {
  test('counts the results that ran a pass’s code, per branch scope', async () => {
    const forecast = await getReuseForecast(db as never, 1);
    expect(forecast.defaultBranch).toBe('main');
    expect(forecast.truncated).toBe(false);
    // Reusable: cart in run 2 and run 4, login in run 2 and run 3 (failed).
    expect(forecast.total).toMatchObject({ results: 8, comparable: 7, reusable: 4, failed: 1, flaky: 0 });
    expect(forecast.total.durationMs).toBe(16_000);
    expect(forecast.total.reusableDurationMs).toBe(8_000);
    const [main, others] = forecast.scopes;
    expect(main).toMatchObject({ scope: 'default-branch', results: 6, reusable: 3, failed: 1 });
    expect(others).toMatchObject({ scope: 'other-branches', results: 2, comparable: 1, reusable: 1, failed: 0 });
  });

  test('lists the test that failed with its code unchanged, with the pass it ran the code of', async () => {
    const forecast = await getReuseForecast(db as never, 1);
    const [login] = await db
      .select({ id: schema.testCases.id })
      .from(schema.testCases)
      .where(eq(schema.testCases.title, 'logs in'));
    expect(forecast.tests).toHaveLength(1);
    expect(forecast.tests[0]).toMatchObject({
      testCaseId: login!.id,
      title: 'logs in',
      filePath: 'tests/shop.spec.ts',
      browserName: 'chromium',
      failed: 1,
      flaky: 0,
    });
    const [source] = await db
      .select({ runId: schema.testRunsCases.testRunId })
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.id, forecast.tests[0]!.sourceExecutionId));
    expect(source!.runId).toBe(2);
    expect(forecast.moreTests).toBe(0);
  });

  test('a project that stopped running keeps the 30 days before its latest result', async () => {
    const forecast = await getReuseForecast(db as never, 1, { now: new Date(Date.now() + 60 * 24 * HOUR) });
    expect(forecast.total).toMatchObject({ results: 8, reusable: 4 });
    expect(Date.parse(forecast.to)).toBeLessThan(Date.now() + 10 * HOUR);
  });

  test('a window that ended before the runs counts nothing', async () => {
    const forecast = await getReuseForecast(db as never, 1, { now: new Date(Date.now() - 60 * 24 * HOUR) });
    expect(forecast.total.results).toBe(0);
  });
});
