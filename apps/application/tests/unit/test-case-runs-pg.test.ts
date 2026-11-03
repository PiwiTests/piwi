import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';

/**
 * A test's runs counted on PostgreSQL: one result per run, Playwright project
 * and `--repeat-each` repetition, read from its final attempt, in the test
 * page header, the catalog and selections, with the pass rate over the runs
 * that passed or failed. Runs against `PIWI_POSTGRES_TEST_URL`, in a database
 * of its own.
 */

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;
const databaseName = `piwi_test_case_runs_${process.pid}`;
// The schema barrel picks the PostgreSQL schema at import time.
if (postgresUrl) {
  const url = new URL(postgresUrl);
  url.pathname = `/${databaseName}`;
  process.env.PIWI_DATABASE_URL = url.toString();
}

describe.skipIf(!postgresUrl)("a test's runs on PostgreSQL", async () => {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const schema = await import('../../server/database/schema.pg');
  const { getTestCase } = await import('#shared/handlers/test-cases');
  const { getProjectTestCases } = await import('#shared/handlers/projects');
  const { loadSelectionCatalog } = await import('#shared/handlers/selections');

  const admin = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let projectId: number;
  let checksOut: number;
  let pays: number;

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    client = postgres(process.env.PIWI_DATABASE_URL!, { onnotice: () => {}, max: 4 });
    db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations-pg', import.meta.url)),
    });
    const [project] = await db.insert(schema.projects).values({ name: 'test-case-runs' }).returning();
    projectId = project!.id;
    const cases = await db
      .insert(schema.testCases)
      .values([
        { projectId, filePath: 'tests/checkout/flow.spec.ts', title: 'checks out' },
        { projectId, filePath: 'tests/checkout/pay.spec.ts', title: 'pays' },
      ])
      .returning();
    checksOut = cases[0]!.id;
    pays = cases[1]!.id;
    const runs = await db
      .insert(schema.testRuns)
      .values([1, 2, 3, 4].map((i) => ({ projectId, status: 'failed', startTime: new Date(Date.now() - i * 60_000) })))
      .returning();
    const [first, second, third, fourth] = runs.map((r) => r.id) as [number, number, number, number];
    /**
     * One test's attempts in one run, project and repetition, each with its history as the reporter sends it; the
     * last is the final attempt.
     */
    const attempts = (
      testCaseId: number,
      testRunId: number,
      browserName: string,
      outcomes: Array<[status: string, duration: number]>,
      repeatEachIndex = 0,
    ) =>
      outcomes.map(([status, duration], retries) => ({
        testRunId,
        testCaseId,
        browserName,
        repeatEachIndex,
        retries,
        status,
        duration,
        finalAttempt: retries === outcomes.length - 1,
        attempts: outcomes.slice(0, retries + 1).map(([s], retry) => ({ retry, status: s })),
        createdAt: new Date(Date.now() - 3_600_000 + testRunId * 60_000 + retries * 1000),
      }));
    // A non-final attempt lasts 10 s, so an average that read one would show it.
    await db.insert(schema.testRunsCases).values([
      ...attempts(checksOut, first, 'chromium', [
        ['failed', 10_000],
        ['passed', 200],
      ]),
      ...attempts(checksOut, first, 'firefox', [['timedout', 300]]),
      ...attempts(checksOut, second, 'chromium', [['passed', 400]], 0),
      ...attempts(
        checksOut,
        second,
        'chromium',
        [
          ['failed', 10_000],
          ['passed', 500],
        ],
        1,
      ),
      ...attempts(checksOut, second, 'chromium', [['skipped', 0]], 2),
      // Retried with its serial group after a pass: not flaky.
      ...attempts(checksOut, third, 'chromium', [
        ['passed', 10_000],
        ['passed', 600],
      ]),
      ...attempts(checksOut, third, 'firefox', [['interrupted', 700]]),
      ...attempts(pays, fourth, 'chromium', [
        ['failed', 10_000],
        ['passed', 100],
      ]),
    ]);
  });

  afterAll(async () => {
    await client?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  test('counts the test page header over its final attempts', async () => {
    expect(await getTestCase(db as never, checksOut)).toMatchObject({
      totalRuns: 7,
      passedRuns: 4,
      failedRuns: 1,
      skippedRuns: 1,
      timedOutRuns: 1,
      flakyRuns: 2,
      recentFlakyRuns: 2,
      passRate: 80,
      avgDuration: 450,
    });
  });

  test('counts the catalog the same, whichever way it is sorted', async () => {
    const expected = { totalRuns: 7, passedRuns: 4, failedRuns: 1, flakyRuns: 2, passRate: 0.8, avgDuration: 450 };
    for (const sort of ['lastRun', 'title', 'passRate', 'totalRuns'] as const) {
      const { items } = await getProjectTestCases(db as never, projectId, { sort });
      expect(
        items.find((t: any) => t.id === checksOut),
        sort,
      ).toMatchObject({ status: 'flaky', ...expected });
    }
  });

  test('counts selections the same, a pass on a retry never a failure', async () => {
    const catalog = await loadSelectionCatalog(db as never, projectId, { withFailRanks: true });
    expect(catalog.find((t) => t.id === checksOut)).toMatchObject({ totalRuns: 7, passRate: 0.8, flaky: true });
    expect(catalog.find((t) => t.id === pays)).toMatchObject({ totalRuns: 1, flaky: true, firstFailRank: null });
  });
});
