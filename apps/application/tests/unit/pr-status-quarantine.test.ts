import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const { buildRunPrSummary } = await import('../../server/utils/scm/pr-feedback');
const { buildCommitStatus } = await import('../../shared/pr-feedback');
const { distinctRunCountsFromAttempts } = await import('../../shared/utils/test-counts');

let db: ReturnType<typeof drizzle<typeof schema>>;

type Attempt = { testCaseId: number; status: string; retries: number };

/** A run on `main` holding these attempts, its counters derived from them as ingest derives them. */
async function runOf(attempts: Attempt[]) {
  const rows = attempts.map((attempt) => ({ ...attempt, browserName: 'chromium', repeatEachIndex: 0 }));
  const counts = distinctRunCountsFromAttempts(rows);
  await db.insert(schema.testRuns).values({
    id: 1,
    projectId: 1,
    status: counts.failedTests > 0 ? 'failed' : 'passed',
    startTime: new Date(),
    branch: 'main',
    ...counts,
  });
  await db.insert(schema.testRunsCases).values(
    rows.map((row) => ({
      testRunId: 1,
      testCaseId: row.testCaseId,
      status: row.status,
      retries: row.retries,
      browserName: row.browserName,
      browser: { projectName: row.browserName },
      repeatEachIndex: 0,
      error: row.status === 'passed' ? null : 'Error: boom',
    })),
  );
}

async function commitStatus() {
  const summary = await buildRunPrSummary(db as never, 1, 'https://piwi.example.com');
  return buildCommitStatus(summary!, 'piwi/tests');
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/q.spec.ts', title: 'quarantined' },
    { id: 2, projectId: 1, filePath: 'tests/x.spec.ts', title: 'fails X' },
    { id: 3, projectId: 1, filePath: 'tests/y.spec.ts', title: 'fails Y' },
  ]);
  await db.insert(schema.quarantinedTests).values({ projectId: 1, testCaseId: 1, source: 'manual' });
});

describe('the commit status of a run with a quarantined test', () => {
  test('fails on another test’s failure when the quarantined test passed on its retry', async () => {
    await runOf([
      { testCaseId: 1, status: 'failed', retries: 0 },
      { testCaseId: 1, status: 'passed', retries: 1 },
      { testCaseId: 2, status: 'failed', retries: 0 },
      { testCaseId: 2, status: 'failed', retries: 1 },
    ]);

    expect((await commitStatus()).state).toBe('failure');
  });

  test('leaves out the quarantined test once, however many attempts it failed', async () => {
    await runOf([
      { testCaseId: 1, status: 'failed', retries: 0 },
      { testCaseId: 1, status: 'failed', retries: 1 },
      { testCaseId: 1, status: 'failed', retries: 2 },
      { testCaseId: 2, status: 'failed', retries: 0 },
      { testCaseId: 3, status: 'failed', retries: 0 },
    ]);

    const summary = await buildRunPrSummary(db as never, 1, 'https://piwi.example.com');
    expect(summary!.quarantinedFailures).toBe(1);
    expect((await commitStatus()).state).toBe('failure');
  });

  test('passes when the quarantined test is the only failure', async () => {
    await runOf([
      { testCaseId: 1, status: 'failed', retries: 0 },
      { testCaseId: 1, status: 'failed', retries: 1 },
      { testCaseId: 2, status: 'passed', retries: 0 },
    ]);

    expect((await commitStatus()).state).toBe('success');
  });
});
