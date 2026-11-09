import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { TestRunFinishPayload } from '#shared/types';
import { HIDDEN_VALUE } from '@piwitests/core/mask';
import { migrateToLatest } from './temp-db';

/**
 * The demo's runs keep what the server's keep (`tests/unit/run-errors-ingest.test.ts`,
 * `tests/unit/test-output-ingest.test.ts`, `tests/unit/error-credentials-ingest.test.ts`): a run's errors outside any
 * test, a sharded run adding each shard's, what a test wrote to stdout and stderr, through `case_payloads`, and a
 * test's error with a credential's shape hidden.
 */

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../app/demo/db.client', () => ({ getDemoDb: async () => state.db }));

const { apiSetupTestRun, apiBeginTestRun, apiPostRunEvents, apiFinishTestRun } =
  await import('../../app/demo/api/reporter');
const { getTestRunCase } = await import('#shared/handlers/test-cases');
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

  test('keeps what a test wrote to stdout and stderr', async () => {
    const { runId, streamToken } = await beginRun();
    await apiPostRunEvents(runId, {
      streamToken,
      testCases: [
        {
          type: 'complete',
          title: 'pays',
          location: 'tests/pays.spec.ts:1:1',
          status: 'failed',
          duration: 10,
          stdout: 'order 4521 created\n',
          stderr: 'payment sandbox answered 502\n',
        },
      ],
    });
    await apiFinishTestRun(runId, finishBody(streamToken));

    const [execution] = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testRunId, runId));
    const detail = await getTestRunCase(db as never, execution!.id);
    expect(detail?.stdout).toBe('order 4521 created\n');
    expect(detail?.stderr).toBe('payment sandbox answered 502\n');
  });

  test('hides a credential’s shape in a test’s error, its steps’ and its hooks’ errors', async () => {
    const key = ['pd_', 'a3'.repeat(32)].join('');
    const error = `Error: 401 for ${key}\n\nReceived: "${key}"`;
    const { runId, streamToken } = await beginRun();
    await apiPostRunEvents(runId, {
      streamToken,
      testCases: [
        {
          type: 'complete',
          title: 'signs in',
          location: 'tests/signs-in.spec.ts:1:1',
          status: 'failed',
          duration: 10,
          error,
          steps: [{ title: 'Expect "toBe"', category: 'expect', duration: 1, error: { message: error } }],
          stepEvents: [
            { title: 'Before Hooks', category: 'hook', startedAt: 1, duration: 1, status: 'failed', error: key },
          ],
        },
      ],
    });
    await apiFinishTestRun(runId, finishBody(streamToken));

    const executions = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testRunId, runId));
    const clusters = await db.select().from(schema.failureClusters);
    expect(JSON.stringify([executions, clusters])).not.toContain(key);
    expect(executions[0]!.error).toBe(`Error: 401 for ${HIDDEN_VALUE}\n\nReceived: "${HIDDEN_VALUE}"`);
    expect((executions[0]!.stepEvents as Array<{ error: string }>)[0]!.error).toBe(HIDDEN_VALUE);
    expect(clusters[0]!.fingerprintSample).toBe(executions[0]!.error);
  });
});
