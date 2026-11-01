import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const { computeRegressionSignals } = await import('../../server/utils/compute-regression-signals');

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values({ id: 1, name: 'signals' });
});
afterEach(() => close());

describe('computeRegressionSignals', () => {
  test('flags new regressions and new flaky executions against the baseline, past one update batch', async () => {
    const cases = 1_203;
    await db
      .insert(schema.testCases)
      .values(
        Array.from({ length: cases }, (_, i) => ({ id: i + 1, projectId: 1, filePath: 'a.spec.ts', title: `t${i}` })),
      );
    await db.insert(schema.testRuns).values([
      { id: 1, projectId: 1, status: 'passed', startTime: new Date('2026-10-01T10:00:00Z'), branch: 'main' },
      { id: 2, projectId: 1, status: 'failed', startTime: new Date('2026-10-02T10:00:00Z'), branch: 'main' },
    ]);
    const ids = Array.from({ length: cases }, (_, i) => i + 1);
    for (let i = 0; i < cases; i += 400) {
      const batch = ids.slice(i, i + 400);
      await db
        .insert(schema.testRunsCases)
        .values(batch.map((id) => ({ testRunId: 1, testCaseId: id, status: 'passed', retries: 0 })));
      // Every third test fails, the next one fails then passes on retry, the last one passes.
      await db.insert(schema.testRunsCases).values(
        batch.flatMap((id) =>
          id % 3 === 2
            ? [
                { testRunId: 2, testCaseId: id, status: 'failed', retries: 0 },
                { testRunId: 2, testCaseId: id, status: 'passed', retries: 1 },
              ]
            : [{ testRunId: 2, testCaseId: id, status: id % 3 === 1 ? 'failed' : 'passed', retries: 0 }],
        ),
      );
    }

    await computeRegressionSignals(db as never, 2);

    const rows = await db
      .select({
        testCaseId: schema.testRunsCases.testCaseId,
        retries: schema.testRunsCases.retries,
        isNewRegression: schema.testRunsCases.isNewRegression,
        isNewFlaky: schema.testRunsCases.isNewFlaky,
      })
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.testRunId, 2));
    expect(rows).toHaveLength(cases + rows.filter((row) => row.retries === 1).length);
    for (const row of rows) {
      // A flaky test's failed first attempt is no new regression: the test passed in the run.
      expect(row.isNewRegression).toBe(row.testCaseId % 3 === 1 ? 1 : null);
      expect(row.isNewFlaky).toBe(row.testCaseId % 3 === 2 && row.retries === 1 ? 1 : null);
    }
  });

  test('flags a regression on the final attempt of a test that failed on every attempt', async () => {
    await db.insert(schema.testCases).values([{ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'pays' }]);
    await db.insert(schema.testRuns).values([
      { id: 1, projectId: 1, status: 'passed', startTime: new Date('2026-10-01T10:00:00Z'), branch: 'main' },
      { id: 2, projectId: 1, status: 'failed', startTime: new Date('2026-10-02T10:00:00Z'), branch: 'main' },
    ]);
    await db.insert(schema.testRunsCases).values([
      { testRunId: 1, testCaseId: 1, status: 'passed', retries: 0 },
      { testRunId: 2, testCaseId: 1, status: 'failed', retries: 0 },
      { testRunId: 2, testCaseId: 1, status: 'timedout', retries: 1 },
    ]);

    await computeRegressionSignals(db as never, 2);

    const flagged = await db
      .select({ retries: schema.testRunsCases.retries })
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.isNewRegression, 1));
    expect(flagged).toEqual([{ retries: 1 }]);
  });

  test('flags no retry that passed after attempts that passed, here or in the baseline', async () => {
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'serial sibling' },
      { id: 2, projectId: 1, filePath: 'a.spec.ts', title: 'blocked' },
      { id: 3, projectId: 1, filePath: 'a.spec.ts', title: 'flaky' },
    ]);
    await db.insert(schema.testRuns).values([
      { id: 1, projectId: 1, status: 'passed', startTime: new Date('2026-10-01T10:00:00Z'), branch: 'main' },
      { id: 2, projectId: 1, status: 'passed', startTime: new Date('2026-10-02T10:00:00Z'), branch: 'main' },
    ]);
    await db.insert(schema.testRunsCases).values([
      { testRunId: 1, testCaseId: 1, status: 'passed', retries: 0 },
      { testRunId: 1, testCaseId: 2, status: 'passed', retries: 0 },
      // The baseline re-ran this test with its serial group: it stays stable there.
      { testRunId: 1, testCaseId: 3, status: 'passed', retries: 0 },
      { testRunId: 1, testCaseId: 3, status: 'passed', retries: 1 },
      // A describe.serial group retried for test 3's failure runs its siblings again.
      { testRunId: 2, testCaseId: 1, status: 'passed', retries: 0 },
      { testRunId: 2, testCaseId: 1, status: 'passed', retries: 1 },
      { testRunId: 2, testCaseId: 2, status: 'didnotrun', retries: 0 },
      { testRunId: 2, testCaseId: 2, status: 'passed', retries: 1 },
      { testRunId: 2, testCaseId: 3, status: 'failed', retries: 0 },
      { testRunId: 2, testCaseId: 3, status: 'passed', retries: 1 },
    ]);

    await computeRegressionSignals(db as never, 2);

    const flagged = await db
      .select({ testCaseId: schema.testRunsCases.testCaseId, retries: schema.testRunsCases.retries })
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.isNewFlaky, 1));
    expect(flagged).toEqual([{ testCaseId: 3, retries: 1 }]);
  });
});
