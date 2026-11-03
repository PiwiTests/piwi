import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler modules load.
delete process.env.PIWI_DATABASE_URL;
const { getTestCase } = await import('../../shared/handlers/test-cases');
const { getProjectTestCases } = await import('../../shared/handlers/projects');
const { getTestRun } = await import('../../shared/handlers/test-runs');
const { getAppSetting, setAppSetting } = await import('../../server/utils/app-settings');
const { ATTEMPT_HISTORY_BACKFILL_SETTING, backfillAttemptHistories, backfillAttemptHistoriesOnce } =
  await import('../../server/utils/attempt-history-backfill');

let db: ReturnType<typeof drizzle<typeof schema>>;
const T0 = Date.parse('2026-10-01T12:00:00Z');

/**
 * Each test ran in a run of its own, its attempts stored without an attempt
 * history, as a trace import or an older reporter stored them: "pays" passed,
 * then passed again on a retry (a `describe.serial` group retried for another
 * test); "refunds" failed, then passed on its retry; "lists" passed on a retry
 * stored without its first attempt. "ships" came from a reporter that sent
 * its history.
 */
beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/pay.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'tests/refund.spec.ts', title: 'refunds' },
    { id: 3, projectId: 1, filePath: 'tests/list.spec.ts', title: 'lists' },
    { id: 4, projectId: 1, filePath: 'tests/ship.spec.ts', title: 'ships' },
  ]);
  await db
    .insert(schema.testRuns)
    .values([1, 2, 3, 4].map((id) => ({ id, projectId: 1, status: 'passed', startTime: new Date(T0 + id * 60_000) })));
  const attempt = (
    testRunId: number,
    testCaseId: number,
    retries: number,
    status: string,
    extra: { attempts?: unknown; finalAttempt?: boolean } = {},
  ) => ({
    testRunId,
    testCaseId,
    retries,
    status,
    duration: 100 + retries,
    startedAt: T0 + testRunId * 60_000 + retries * 1000,
    browserName: 'chromium',
    attempts: null,
    createdAt: new Date(T0 + testRunId * 60_000 + retries * 1000),
    ...extra,
  });
  const earlier = { finalAttempt: false };
  const shipped = [{ retry: 0, status: 'passed', duration: 100, startedAt: null }];
  await db
    .insert(schema.testRunsCases)
    .values([
      attempt(1, 1, 0, 'passed', earlier),
      attempt(1, 1, 1, 'passed'),
      attempt(2, 2, 0, 'failed', earlier),
      attempt(2, 2, 1, 'passed'),
      attempt(3, 3, 1, 'passed'),
      attempt(4, 4, 0, 'passed', { attempts: shipped }),
    ]);
});

/** The stored attempt history of each execution of a test, in retry order. */
async function histories(testCaseId: number) {
  const rows = await db
    .select({ retries: schema.testRunsCases.retries, attempts: schema.testRunsCases.attempts })
    .from(schema.testRunsCases)
    .where(eq(schema.testRunsCases.testCaseId, testCaseId))
    .orderBy(asc(schema.testRunsCases.retries));
  return rows.map((row) => row.attempts);
}

describe('the attempt history backfill', () => {
  test('makes a retry after a pass read as not flaky in the catalog and on the test page, as on the run page', async () => {
    // The run page builds the history from the run's rows; the SQL reads the row alone.
    const runPage = await getTestRun(db as never, 1);
    expect(runPage!.testCases.find((tc: any) => tc.retries === 1)!.attempts).toHaveLength(2);
    expect(await getTestCase(db as never, 1)).toMatchObject({ flakyRuns: 1 });

    expect(await backfillAttemptHistories(db as never)).toBe(2);

    expect(await getTestCase(db as never, 1)).toMatchObject({ totalRuns: 1, flakyRuns: 0, recentFlakyRuns: 0 });
    const catalog = await getProjectTestCases(db as never, 1);
    expect(catalog.items.find((t: any) => t.id === 1)).toMatchObject({ status: 'passed', flakyRuns: 0 });
    // A pass after a failure stays flaky, and so does a retry stored without its first attempt.
    expect(catalog.items.find((t: any) => t.id === 2)).toMatchObject({ status: 'flaky', flakyRuns: 1 });
    expect(catalog.items.find((t: any) => t.id === 3)).toMatchObject({ status: 'flaky', flakyRuns: 1 });
  });

  test('stores the history ingest stores, and leaves alone a first attempt, a lone retry and a reported history', async () => {
    await backfillAttemptHistories(db as never);
    expect(await histories(1)).toEqual([
      null,
      [
        { retry: 0, status: 'passed', duration: 100, startedAt: T0 + 60_000 },
        { retry: 1, status: 'passed', duration: 101, startedAt: T0 + 61_000 },
      ],
    ]);
    expect(await histories(2)).toEqual([
      null,
      [
        { retry: 0, status: 'failed', duration: 100, startedAt: T0 + 120_000 },
        { retry: 1, status: 'passed', duration: 101, startedAt: T0 + 121_000 },
      ],
    ]);
    expect(await histories(3)).toEqual([null]);
    expect(await histories(4)).toEqual([[{ retry: 0, status: 'passed', duration: 100, startedAt: null }]]);
  });

  test('runs once per instance, and resumes after the last page an earlier start finished', async () => {
    const [refunds] = await db
      .select({ id: schema.testRunsCases.id })
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.testCaseId, 2))
      .orderBy(asc(schema.testRunsCases.id));
    await setAppSetting(db as never, ATTEMPT_HISTORY_BACKFILL_SETTING, { after: refunds!.id });

    expect(await backfillAttemptHistoriesOnce(db as never)).toBe(1);
    expect((await histories(1))[1]).toBeNull();
    expect((await histories(2))[1]).toHaveLength(2);
    expect(await getAppSetting(db as never, ATTEMPT_HISTORY_BACKFILL_SETTING)).toEqual({
      doneAt: expect.any(String),
    });

    expect(await backfillAttemptHistoriesOnce(db as never)).toBeNull();
    expect((await histories(1))[1]).toBeNull();
  });
});
