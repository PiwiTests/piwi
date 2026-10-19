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
      // Every third test fails, the next one passes on retry, the last one passes.
      await db.insert(schema.testRunsCases).values(
        batch.map((id) => ({
          testRunId: 2,
          testCaseId: id,
          status: id % 3 === 1 ? 'failed' : 'passed',
          retries: id % 3 === 2 ? 1 : 0,
        })),
      );
    }

    await computeRegressionSignals(db as never, 2);

    const rows = await db
      .select({
        testCaseId: schema.testRunsCases.testCaseId,
        isNewRegression: schema.testRunsCases.isNewRegression,
        isNewFlaky: schema.testRunsCases.isNewFlaky,
      })
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.testRunId, 2));
    expect(rows).toHaveLength(cases);
    for (const row of rows) {
      expect(row.isNewRegression).toBe(row.testCaseId % 3 === 1 ? 1 : null);
      expect(row.isNewFlaky).toBe(row.testCaseId % 3 === 2 ? 1 : null);
    }
  });
});
