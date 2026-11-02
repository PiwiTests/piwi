import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

/**
 * The demo's runs, through its reporter endpoints (`app/demo/api/reporter.ts`): the same results, counters, status and
 * metadata as the server's (a sharded run's in `tests/unit/sharded-run-setup.test.ts`).
 */

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../app/demo/db.client', () => ({ getDemoDb: async () => state.db }));

const { apiSetupTestRun, apiBeginTestRun, apiPostRunEvents, apiFinishTestRun } =
  await import('../../app/demo/api/reporter');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const SHARDS = { projectName: 'demo-shards', instanceId: 'ci-run-1', shardTotal: 2 };

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
});

async function readRun(runId: number) {
  const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
  return run!;
}

/** A shard set up and begun, planning `totalTests`; its stream token. */
async function beginShard(shardIndex: number, totalTests: number, metadata?: Record<string, unknown>) {
  const { runId, setupToken } = await apiSetupTestRun({ ...SHARDS, shardIndex });
  const { streamToken } = await apiBeginTestRun(runId, { setupToken, totalTests, shardIndex, metadata, ...SHARDS });
  return { runId, streamToken };
}

function result(title: string, status: string, shardIndex: number) {
  return { type: 'complete' as const, title, location: `tests/${title}.spec.ts:1:1`, status, duration: 10, shardIndex };
}

describe("the demo's sharded run", () => {
  test('counts each result once until its last shard ends, and settles to the planned total', async () => {
    const one = await beginShard(1, 2);
    const two = await beginShard(2, 2);
    expect(two.runId).toBe(one.runId);

    await apiPostRunEvents(one.runId, { streamToken: one.streamToken, testCases: [result('pays', 'passed', 1)] });
    await apiFinishTestRun(one.runId, {
      streamToken: one.streamToken,
      status: 'passed',
      duration: 1000,
      totalTests: 2,
      passedTests: 1,
      failedTests: 0,
      skippedTests: 0,
      didNotRunTests: 1,
      flakyTests: 0,
      durations: [10],
      shardIndex: 1,
      shardTotal: 2,
    });
    expect(await readRun(one.runId)).toMatchObject({ status: 'running', passedTests: 1, didNotRunTests: 0 });

    await apiPostRunEvents(one.runId, { streamToken: two.streamToken, testCases: [result('adds', 'passed', 2)] });
    await apiFinishTestRun(one.runId, {
      streamToken: two.streamToken,
      status: 'timedout',
      duration: 1000,
      totalTests: 2,
      passedTests: 1,
      failedTests: 0,
      skippedTests: 0,
      flakyTests: 0,
      durations: [10],
      shardIndex: 2,
      shardTotal: 2,
    });

    expect(await readRun(one.runId)).toMatchObject({ status: 'timedout', totalTests: 4, passedTests: 2 });
  });

  test("keeps every shard's suite setup steps", async () => {
    const hookOf = (shardIndex: number) => ({
      title: `beforeAll hook of shard ${shardIndex}`,
      category: 'hook',
      startedAt: 1_793_000_000_000 + shardIndex,
      duration: 1200,
      status: 'passed',
      workerIndex: 0,
    });
    const one = await beginShard(1, 1);
    const two = await beginShard(2, 1);
    const finished = (shardIndex: number) => ({
      status: 'passed',
      duration: 1000,
      totalTests: 1,
      passedTests: 0,
      failedTests: 0,
      skippedTests: 0,
      flakyTests: 0,
      durations: [],
      shardIndex,
      shardTotal: 2,
      setupSteps: [hookOf(shardIndex)],
    });

    await apiFinishTestRun(one.runId, { streamToken: one.streamToken, ...finished(1) });
    await apiFinishTestRun(one.runId, { streamToken: two.streamToken, ...finished(2) });

    expect((await readRun(one.runId)).setupSteps).toEqual([hookOf(1), hookOf(2)]);
  });

  test('takes the branch and commit of a shard that joins a run whose first shard sent none', async () => {
    const scm = { branch: 'feature/pay', commit: '9f2c4e1a7b' };
    const one = await beginShard(1, 1);
    await beginShard(2, 1, { scm });

    expect(await readRun(one.runId)).toMatchObject({ branch: 'feature/pay', commit: '9f2c4e1a7b' });
  });
});

describe("the demo's streamed result", () => {
  test('of a test with an empty title is stored, as Playwright runs it', async () => {
    const { runId, setupToken } = await apiSetupTestRun({ projectName: 'demo-results', instanceId: 'local-1' });
    const { streamToken } = await apiBeginTestRun(runId, { setupToken });

    await apiPostRunEvents(runId, { streamToken, testCases: [result('', 'passed', 1)] });

    const titles = await db
      .select({ title: schema.testCases.title })
      .from(schema.testRunsCases)
      .innerJoin(schema.testCases, eq(schema.testCases.id, schema.testRunsCases.testCaseId));
    expect(titles).toEqual([{ title: '' }]);
  });
});

describe("the demo's run begun after a long global setup", () => {
  test('is active from its begin', async () => {
    const { runId, setupToken } = await apiSetupTestRun({ projectName: 'demo-setup', instanceId: 'local-1' });
    const beganAt = Date.now() + 10 * 60_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(beganAt);
    try {
      await apiBeginTestRun(runId, { setupToken });
    } finally {
      vi.useRealTimers();
    }

    // The column keeps whole seconds.
    expect((await readRun(runId)).updatedAt!.getTime()).toBeGreaterThan(beganAt - 1000);
  });
});
