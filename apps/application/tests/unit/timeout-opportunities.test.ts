import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { runOrigin } from '#shared/run-eligibility';
import { openTempDb, type TempDb } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const { getProjectTimeoutOpportunities } = await import('../../shared/handlers/projects');

let db: TempDb;
let close: () => Promise<void>;
let runSeq = 0;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  runSeq = 0;
  await db.insert(schema.projects).values({ id: 1, name: 'timeouts' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/a.spec.ts', title: 'loads' });
});
afterEach(() => close());

/** One run where the test took one second under a one-minute timeout. */
async function seedRun(status: string, metadata: object | null = null) {
  const id = ++runSeq;
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status,
    startTime: new Date(Date.UTC(2026, 9, 1, 0, id)),
    metadata,
    origin: runOrigin(metadata),
  });
  await db
    .insert(schema.testRunsCases)
    .values({ testRunId: id, testCaseId: 1, status: 'passed', duration: 1_000, timeout: 60_000 });
}

describe('getProjectTimeoutOpportunities', () => {
  test('reads finished runs only, leaving out lab, bisect and unfinished runs', async () => {
    for (let i = 0; i < 5; i++) await seedRun('passed');
    await seedRun('passed', { piwiFlakeLab: { experimentId: 'exp-1', armId: 'control' } });
    await seedRun('passed', { piwiOrigin: { kind: 'bisect' } });
    await seedRun('running');
    await seedRun('finalizing');

    const [opportunity] = await getProjectTimeoutOpportunities(db as never, 1, 50);
    expect(opportunity).toMatchObject({ testCaseId: 1, kind: 'oversized-timeout', runCount: 5 });
  });
});
