import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

/**
 * A run's failure groups flag a cluster whose tests all failed on one worker (`workerCorrelated`): a lane in its
 * shard, whichever processes Playwright started in it, or the worker process of a result without a lane.
 */

// The schema barrel picks PostgreSQL at import time when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const { getFailureGroups } = await import('#shared/handlers/test-runs');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

interface Ran {
  testCaseId: number;
  status: 'passed' | 'failed';
  workerIndex: number;
  parallelIndex?: number;
  shardIndex?: number;
}

/** A run whose failures all fall in one cluster, the run and the cluster sharing its id. */
async function runOf(id: number, executions: Ran[]) {
  await db.insert(schema.testRuns).values({ id, projectId: 1, status: 'failed', startTime: new Date() });
  await db.insert(schema.failureClusters).values({
    id,
    projectId: 1,
    fingerprint: `fp-${id}`,
    signature: 'Error: account locked',
    errorType: 'unknown',
    firstSeenRunId: id,
    lastSeenRunId: id,
  });
  await db.insert(schema.testRunsCases).values(
    executions.map((e) => ({
      testRunId: id,
      ...e,
      ...(e.status === 'failed' ? { error: 'Error: account locked', failureClusterId: id } : {}),
    })),
  );
}

async function workerCorrelated(runId: number) {
  const [group] = await getFailureGroups(db as never, runId);
  return group!.workerCorrelated;
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, title: 'pays by card', filePath: 'tests/checkout.spec.ts' },
    { id: 2, projectId: 1, title: 'pays by transfer', filePath: 'tests/checkout.spec.ts' },
    { id: 3, projectId: 1, title: 'browses', filePath: 'tests/catalog.spec.ts' },
  ]);
});

describe('a failure group', () => {
  test('is worker correlated when its tests failed on one lane, across the processes Playwright started in it', async () => {
    await runOf(1, [
      { testCaseId: 1, status: 'failed', workerIndex: 0, parallelIndex: 0 },
      { testCaseId: 2, status: 'failed', workerIndex: 2, parallelIndex: 0 },
      { testCaseId: 3, status: 'passed', workerIndex: 1, parallelIndex: 1 },
    ]);
    expect(await workerCorrelated(1)).toBe(true);

    const [group] = await getFailureGroups(db as never, 1);
    expect(group!.cases.map((c) => [c.workerIndex, c.parallelIndex, c.shardIndex])).toEqual([
      [0, 0, null],
      [2, 0, null],
    ]);
  });

  test('is not worker correlated when its tests failed on the same lane of two shards', async () => {
    await runOf(2, [
      { testCaseId: 1, status: 'failed', workerIndex: 0, parallelIndex: 0, shardIndex: 1 },
      { testCaseId: 2, status: 'failed', workerIndex: 0, parallelIndex: 0, shardIndex: 2 },
      { testCaseId: 3, status: 'passed', workerIndex: 1, parallelIndex: 1, shardIndex: 1 },
    ]);
    expect(await workerCorrelated(2)).toBe(false);
  });

  test('is not worker correlated in a run that used one worker', async () => {
    await runOf(3, [
      { testCaseId: 1, status: 'failed', workerIndex: 0, parallelIndex: 0 },
      { testCaseId: 2, status: 'failed', workerIndex: 1, parallelIndex: 0 },
    ]);
    expect(await workerCorrelated(3)).toBe(false);
  });

  test('compares the worker processes of results without a lane', async () => {
    await runOf(4, [
      { testCaseId: 1, status: 'failed', workerIndex: 1 },
      { testCaseId: 2, status: 'failed', workerIndex: 1 },
      { testCaseId: 3, status: 'passed', workerIndex: 0 },
    ]);
    expect(await workerCorrelated(4)).toBe(true);

    await runOf(5, [
      { testCaseId: 1, status: 'failed', workerIndex: 0 },
      { testCaseId: 2, status: 'failed', workerIndex: 2 },
      { testCaseId: 3, status: 'passed', workerIndex: 1 },
    ]);
    expect(await workerCorrelated(5)).toBe(false);
  });
});
