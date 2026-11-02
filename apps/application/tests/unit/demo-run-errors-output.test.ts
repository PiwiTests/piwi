import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { TestRunFinishPayload } from '#shared/types';
import { migrateToLatest } from './temp-db';

/**
 * The demo's runs keep what the server's keep (`tests/unit/run-errors-ingest.test.ts`): a run's errors outside any
 * test, a sharded run adding each shard's.
 */

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../app/demo/db.client', () => ({ getDemoDb: async () => state.db }));

const { apiSetupTestRun, apiBeginTestRun, apiFinishTestRun } = await import('../../app/demo/api/reporter');
const { getTestRun } = await import('#shared/handlers/test-runs');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
});

/** A run set up and begun, as one reporter (`shards` for one shard of a sharded run); its id and stream token. */
async function beginRun(shards: { shardIndex?: number; shardTotal?: number } = {}) {
  const run = { projectName: 'demo-evidence', instanceId: 'ci-run-3', ...shards };
  const { runId, setupToken } = await apiSetupTestRun(run);
  const { streamToken } = await apiBeginTestRun(runId, { setupToken, totalTests: 1, ...run });
  return { runId, streamToken };
}

function finishBody(streamToken: string, extra: Partial<TestRunFinishPayload> = {}): TestRunFinishPayload {
  return {
    streamToken,
    status: 'failed',
    duration: 1000,
    totalTests: 1,
    passedTests: 0,
    failedTests: 1,
    skippedTests: 0,
    flakyTests: 0,
    durations: [10],
    ...extra,
  };
}

describe("the demo's run", () => {
  test('keeps its errors outside any test', async () => {
    const { runId, streamToken } = await beginRun();
    await apiFinishTestRun(
      runId,
      finishBody(streamToken, {
        runErrors: [
          { message: 'Error: worker teardown failed', location: { file: 'fixtures.ts', line: 9, column: 3 } },
        ],
      }),
    );
    expect((await getTestRun(db as never, runId))?.runErrors).toEqual([
      { message: 'Error: worker teardown failed', stack: null, location: { file: 'fixtures.ts', line: 9, column: 3 } },
    ]);
  });

  test("adds each shard's errors outside any test to the others'", async () => {
    const shards = { shardTotal: 2 };
    const one = await beginRun({ ...shards, shardIndex: 1 });
    const two = await beginRun({ ...shards, shardIndex: 2 });
    expect(two.runId).toBe(one.runId);
    for (const [i, shard] of [one, two].entries()) {
      await apiFinishTestRun(
        one.runId,
        finishBody(shard.streamToken, {
          shardIndex: i + 1,
          shardTotal: 2,
          runErrors: [{ message: `Error: shard ${i + 1}: No tests found` }],
        }),
      );
    }
    const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, one.runId));
    expect(run!.runErrors).toEqual([
      { message: 'Error: shard 1: No tests found', stack: null, location: null },
      { message: 'Error: shard 2: No tests found', stack: null, location: null },
    ]);
  });
});
