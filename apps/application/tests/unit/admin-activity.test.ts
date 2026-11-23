import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

/**
 * What the admin activity route answers: the runs of every project not ended yet, by their last activity, and the
 * requests counted as receiving a run's results or files.
 */

delete process.env.PIWI_DATABASE_URL;
const { getRunsInProgress } = await import('../../shared/handlers/admin-activity');
const { receivesRunUpload, runUploads } = await import('../../server/utils/instance-activity');

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: 1, name: 'activity-one' },
    { id: 2, name: 'activity-two' },
  ]);
});

const at = (minute: number) => new Date(Date.UTC(2026, 10, 23, 12, minute));

describe('getRunsInProgress', () => {
  test('lists the runs of every project not ended yet, most recently active first', async () => {
    await db.insert(schema.testRuns).values([
      { projectId: 1, status: 'running', startTime: at(0), createdAt: at(0), updatedAt: at(5) },
      { projectId: 2, status: 'finalizing', startTime: at(0), createdAt: at(0), updatedAt: at(9) },
      { projectId: 1, status: 'initializing', startTime: at(0), createdAt: at(7), updatedAt: null },
      { projectId: 1, status: 'passed', startTime: at(0), createdAt: at(0), updatedAt: at(10) },
      { projectId: 2, status: 'interrupted', startTime: at(0), createdAt: at(0), updatedAt: at(10) },
    ]);

    expect(await getRunsInProgress(db as never)).toEqual([
      { status: 'finalizing', lastActivityAt: at(9) },
      { status: 'initializing', lastActivityAt: at(7) },
      { status: 'running', lastActivityAt: at(5) },
    ]);
  });

  test('is empty when every run has ended', async () => {
    await db.insert(schema.testRuns).values({ projectId: 1, status: 'failed', startTime: at(0) });
    expect(await getRunsInProgress(db as never)).toEqual([]);
  });
});

describe('receivesRunUpload', () => {
  test.each([
    ['POST', '/api/test-runs/submit'],
    ['POST', '/api/test-runs/upload'],
    ['POST', '/api/test-runs/upload/results'],
    ['POST', '/api/test-runs/import?project=shop'],
    ['POST', '/api/test-runs/12/case-files/'],
    ['PUT', '/api/test-runs/12/coverage'],
  ])('counts %s %s', (method, path) => {
    expect(receivesRunUpload(method, path)).toBe(true);
  });

  test.each([
    ['GET', '/api/test-runs/upload'],
    ['POST', '/api/test-runs/12/events'],
    ['POST', '/api/test-runs/12/finish'],
    ['POST', '/api/test-runs/import/check'],
  ])('leaves %s %s out', (method, path) => {
    expect(receivesRunUpload(method, path)).toBe(false);
  });
});

test('an upload counts until its close, once', () => {
  const before = runUploads.value;
  const close = runUploads.open();
  expect(runUploads.value).toBe(before + 1);
  close();
  close();
  expect(runUploads.value).toBe(before);
});
