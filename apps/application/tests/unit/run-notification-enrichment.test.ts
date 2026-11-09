import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/** A run notification goes out without an enrichment that cannot be loaded, never not at all. */

// The failing code of each failure is read through the case payloads; this store is down.
vi.mock('../../server/utils/case-payloads', () => ({
  inlineCasePayloads: async () => {
    throw new Error('SQLITE_BUSY: database is locked');
  },
}));

delete process.env.PIWI_DATABASE_URL;

const { loadRunPayload } = await import('../../server/utils/notifications/run-notifications');

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/pay.spec.ts', title: 'pays' });
  await db.insert(schema.testRuns).values({
    id: 5,
    projectId: 1,
    status: 'failed',
    branch: 'main',
    startTime: new Date('2026-10-01T10:00:00Z'),
    totalTests: 1,
    failedTests: 1,
  });
  await db.insert(schema.testRunsCases).values({
    id: 50,
    testRunId: 5,
    testCaseId: 1,
    status: 'failed',
    browserName: 'chromium',
    error: 'Error: expect(received).toBe(expected)',
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  return close();
});

describe('loadRunPayload', () => {
  test('names the failures without their code when the code cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const loaded = await loadRunPayload(db as never, 5);
    expect(loaded!.runPayload.topFailures.map((f) => [f.title, f.source])).toEqual([['pays', undefined]]);
    expect(loaded!.runPayload.history).toEqual([{ runId: 5, status: 'failed', failedTests: 1 }]);
  });
});
