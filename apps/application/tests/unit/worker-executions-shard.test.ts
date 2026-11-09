import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler modules load.
delete process.env.PIWI_DATABASE_URL;
const { loadFailureClueInput, getFailureClues } = await import('../../shared/handlers/test-cases');

let db: ReturnType<typeof drizzle<typeof schema>>;
let failingId: number;
let sameShardId: number;

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'checkout.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'checkout.spec.ts', title: 'adds to cart' },
    { id: 3, projectId: 1, filePath: 'admin.spec.ts', title: 'resets catalog' },
  ]);
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId: 1, status: 'failed', startTime: new Date(), duration: 60_000, totalTests: 3 })
    .returning({ id: schema.testRuns.id });
  const t0 = Date.now() - 60_000;
  const rows = await db
    .insert(schema.testRunsCases)
    .values([
      // Worker 0 of shard 1: a passing test, then the failure.
      { testRunId: run!.id, testCaseId: 2, status: 'passed', workerIndex: 0, shardIndex: 1, startedAt: t0 },
      {
        testRunId: run!.id,
        testCaseId: 1,
        status: 'failed',
        error: 'Error: expect(locator).toBeVisible() failed',
        workerIndex: 0,
        shardIndex: 1,
        startedAt: t0 + 10_000,
      },
      // Worker 0 of shard 2, another machine: it failed just before.
      {
        testRunId: run!.id,
        testCaseId: 3,
        status: 'failed',
        error: 'Error: boom',
        workerIndex: 0,
        shardIndex: 2,
        startedAt: t0 + 9_000,
      },
    ])
    .returning({ id: schema.testRunsCases.id });
  sameShardId = rows[0]!.id;
  failingId = rows[1]!.id;
});

describe('same-worker executions', () => {
  test('come from the same shard only', async () => {
    const input = await loadFailureClueInput(db as any, failingId);
    const ids = input!.workerExecutions.map((w) => w.id).sort();
    expect(ids).toEqual([sameShardId, failingId].sort());
  });

  test('a failure on the same worker index of another shard is no worker-pollution clue', async () => {
    const { clues } = await getFailureClues(db as any, failingId);
    expect(clues.map((c) => c.id)).not.toContain('worker-pollution');
  });
});
