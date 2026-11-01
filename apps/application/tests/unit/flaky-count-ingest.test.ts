import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import { migrateToLatest } from './temp-db';

/**
 * A run's flaky count through the ingest routes: a test is flaky when it passed after an earlier attempt failed, as
 * Playwright counts it. A `describe.serial` group retried for one test's failure runs its other tests again, and none
 * of those is flaky: the ones that passed before, the `test.fail()` one whose failure was expected, and the one that
 * did not run behind the failure.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', () => ({
  requireAuth: async () => ({ id: 0, role: 'administrator' }),
  getCurrentUser: async () => null,
  isAuthEnabled: () => false,
}));
vi.mock('../../server/utils/run-finalize-side-effects', () => ({ runFinalizeSideEffects: vi.fn(async () => {}) }));

interface RouteEvent {
  params?: Record<string, string>;
  body: Record<string, unknown>;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: RouteEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: RouteEvent, name: string) => event.params?.[name]);
vi.stubGlobal('getRequestHeader', () => undefined);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('durationStats', durationStats);

type Route = (event: RouteEvent) => Promise<Record<string, any>>;
const submit = (await import('../../server/api/test-runs/submit.post')).default as unknown as Route;
const start = (await import('../../server/api/test-runs/start.post')).default as unknown as Route;
const events = (await import('../../server/api/test-runs/[id]/events.post')).default as unknown as Route;
const finish = (await import('../../server/api/test-runs/[id]/finish.post')).default as unknown as Route;
const { runEventBus } = await import('../../server/utils/run-events');
const { batchShardTally } = await import('../../server/utils/sharded-runs');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let projectId: number;

const PROJECT = 'flaky-count';

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
  projectId = project!.id;
  testCaseCache.invalidate(projectId);
  testSuiteCache.invalidate(projectId);
});

/** One attempt of a test as the reporter sends it, with its attempt history up to it. */
function attempt(title: string, line: number, statuses: string[]) {
  const retries = statuses.length - 1;
  const status = statuses[retries]!;
  return {
    title,
    location: `tests/checkout.spec.ts:${line}:5`,
    suitePath: ['checkout flow'],
    status,
    duration: 100,
    retries,
    repeatEachIndex: 0,
    attempts: statuses.map((s, retry) => ({ retry, status: s, duration: 100, startedAt: null })),
    error: status === 'failed' ? 'Error: expect(received).toBe(expected)' : null,
    browser: { projectName: 'chromium' },
  };
}

/** Each attempt of a `describe.serial` group of four tests, retried once because `pays` failed. */
const SERIAL_GROUP = [
  attempt('logs in', 3, ['passed']),
  attempt('pays', 7, ['failed']),
  attempt('shows the receipt', 11, ['didnotrun']),
  attempt('rejects an expired card', 15, ['passed']),
  attempt('logs in', 3, ['passed', 'passed']),
  attempt('pays', 7, ['failed', 'passed']),
  attempt('shows the receipt', 11, ['didnotrun', 'passed']),
  // test.fail(): its expected failure is stored as passed.
  attempt('rejects an expired card', 15, ['passed', 'passed']),
];

/** The group's counters, one per test, as the reporter sends them. */
const COUNTS = { totalTests: 4, passedTests: 4, failedTests: 0, skippedTests: 0, didNotRunTests: 0 };

async function readRun(runId: number) {
  const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
  return run!;
}

describe('the flaky count of a run', () => {
  test('a submitted run counts only the test whose earlier attempt failed', async () => {
    const { runId } = await submit({
      body: {
        projectName: PROJECT,
        status: 'passed',
        startTime: new Date().toISOString(),
        testCases: SERIAL_GROUP,
        ...COUNTS,
      },
    });
    expect(await readRun(runId)).toMatchObject({ passedTests: 4, flakyTests: 1 });
  });

  test("a sharded batch run counts it in each shard's tally and once settled", async () => {
    const shard = (shardIndex: number, testCases: unknown[], counts: Record<string, number>) =>
      submit({
        body: {
          projectName: PROJECT,
          status: 'passed',
          startTime: new Date().toISOString(),
          instanceId: 'nightly',
          shardIndex,
          shardTotal: 2,
          testCases,
          ...counts,
        },
      });
    const other = [attempt('lists orders', 3, ['passed']), attempt('lists orders', 3, ['passed', 'passed'])];
    expect(batchShardTally({ ...COUNTS } as never, SERIAL_GROUP).flakyTests).toBe(1);
    expect(batchShardTally({} as never, other).flakyTests).toBe(0);

    await shard(1, SERIAL_GROUP, COUNTS);
    const { runId } = await shard(2, other, { totalTests: 1, passedTests: 1 });
    expect(await readRun(runId)).toMatchObject({ status: 'passed', totalTests: 5, passedTests: 5, flakyTests: 1 });
  });

  test('a streamed run counts it from its stored attempts, whatever the reporter sent', async () => {
    const { runId, streamToken } = await start({ body: { projectName: PROJECT, totalTests: 4 } });
    const published: Array<{ type: string; data: any }> = [];
    const unsubscribe = runEventBus.subscribe(runId, (event) => published.push(event as never));
    try {
      await events({
        params: { id: String(runId) },
        body: { streamToken, testCases: SERIAL_GROUP.map((tc) => ({ type: 'complete', ...tc })) },
      });
    } finally {
      unsubscribe();
    }
    // The live page reads a flaky pass from the attempts that ride along.
    const completed = published.filter((e) => e.type === 'test-completed').map((e) => e.data);
    expect(completed.at(-3)!.attempts.map((a: { status: string }) => a.status)).toEqual(['failed', 'passed']);

    // An older reporter counts every pass on a retry as flaky.
    await finish({
      params: { id: String(runId) },
      body: { streamToken, status: 'passed', duration: 1000, ...COUNTS, flakyTests: 4 },
    });
    expect(await readRun(runId)).toMatchObject({ status: 'passed', passedTests: 4, flakyTests: 1 });
  });
});
