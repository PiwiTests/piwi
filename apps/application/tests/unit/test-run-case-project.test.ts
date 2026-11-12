import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/**
 * `getTestRunCase` names the Playwright project and the repetition of the execution it returns: with the test case,
 * that is what tells a result from the same test's other results in the run, even for an earlier attempt, whose own
 * `attempts` list stops at its own retry.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const { getTestRunCase } = await import('../../shared/handlers/test-cases');

let db: TempDb;
let close: () => Promise<void>;

const T0 = 1_700_000_000_000;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/a.spec.ts', title: 'one' });
  await db
    .insert(schema.testRuns)
    .values({ id: 1, projectId: 1, status: 'failed', startTime: new Date(T0), totalTests: 1 });
  await db.insert(schema.testRunsCases).values([
    // chromium: failed first attempt, passed retry; firefox: a single passed attempt
    { id: 30, testRunId: 1, testCaseId: 1, status: 'failed', retries: 0, browserName: 'chromium', line: 7, column: 3 },
    { id: 31, testRunId: 1, testCaseId: 1, status: 'passed', retries: 1, browserName: 'chromium', line: 7, column: 3 },
    { id: 32, testRunId: 1, testCaseId: 1, status: 'passed', retries: 0, browserName: 'firefox', line: 7, column: 3 },
    // a `--repeat-each` repetition without a project
    { id: 33, testRunId: 1, testCaseId: 1, status: 'passed', retries: 0, repeatEachIndex: 2 },
  ]);
});

afterEach(async () => {
  await close();
});

describe('getTestRunCase project and repetition', () => {
  test('returns the project, repetition and column of an earlier attempt', async () => {
    const earlier = await getTestRunCase(db as any, 30);
    expect(earlier).toMatchObject({ id: 30, retries: 0, browserName: 'chromium', repeatEachIndex: 0, column: 3 });
  });

  test('returns the project of the final attempt and of another project', async () => {
    expect(await getTestRunCase(db as any, 31)).toMatchObject({ browserName: 'chromium', repeatEachIndex: 0 });
    expect(await getTestRunCase(db as any, 32)).toMatchObject({ browserName: 'firefox', repeatEachIndex: 0 });
  });

  test('returns the repetition, and no project when the run has none', async () => {
    const repeated = await getTestRunCase(db as any, 33);
    expect(repeated).toMatchObject({ browserName: null, repeatEachIndex: 2, column: null });
  });
});
