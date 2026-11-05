import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import { InstanceRole, ADMIN_ACCESS } from '#shared/permissions';
import { compareWorkers, shownWorkerNumber, workerLane, workerNumber } from '#shared/worker-lane';
import { DashboardLinks, eventFacts } from '#shared/notifications/message-parts';
import type { User } from '../../server/database/schema';
import { migrateToLatest } from './temp-db';

/**
 * A worker's lane (Playwright's `parallelIndex`) reaches its execution through the batch body and the stream, comes
 * back with the run and its stream's catch-up, and is what the MCP tools and the pages read a worker by, from 1; a
 * result without one (an older reporter's) keeps its worker process.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db, getDialect: () => 'sqlite' }));
vi.mock('../../server/utils/auth', () => ({
  requireAuth: async () => ({ id: 0, role: 'administrator' }),
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
const { getTestRun } = await import('#shared/handlers/test-runs');
const { getTestRunCase } = await import('#shared/handlers/test-cases');
const { storedCaseEventData } = await import('../../server/utils/run-stream-catch-up');
const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const PROJECT = 'worker-lanes';
const ctx = { user: { id: 0, role: InstanceRole.ADMINISTRATOR } as User, access: ADMIN_ACCESS, scope: 'all' as const };

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
  testCaseCache.invalidate(project!.id);
  testSuiteCache.invalidate(project!.id);
});

/** A failed test as the reporter sends it, run by worker process `workerIndex` on lane `parallelIndex`. */
function laneCase(title: string, workerIndex: number, parallelIndex?: unknown, shardIndex?: number) {
  return {
    title,
    location: `tests/${title}.spec.ts:3:1`,
    status: 'failed',
    duration: 10,
    workerIndex,
    ...(parallelIndex !== undefined ? { parallelIndex } : {}),
    ...(shardIndex !== undefined ? { shardIndex } : {}),
  };
}

async function submitRun(testCases: unknown[]): Promise<number> {
  const { runId } = await submit({
    body: {
      projectName: PROJECT,
      status: 'failed',
      startTime: '2026-11-01T10:00:00.000Z',
      duration: 1000,
      totalTests: testCases.length,
      failedTests: testCases.length,
      testCases,
    },
  });
  return runId;
}

async function lanesOf(runId: number) {
  const rows = await db
    .select({ workerIndex: schema.testRunsCases.workerIndex, parallelIndex: schema.testRunsCases.parallelIndex })
    .from(schema.testRunsCases)
    .where(eq(schema.testRunsCases.testRunId, runId))
    .orderBy(asc(schema.testRunsCases.id));
  return rows.map((row) => [row.workerIndex, row.parallelIndex]);
}

describe('a worker lane', () => {
  test('is a non-negative integer, else none', () => {
    expect([0, 3].map(workerLane)).toEqual([0, 3]);
    for (const value of [-1, 1.5, '2', null, undefined, Number.NaN, 2 ** 31]) expect(workerLane(value)).toBeNull();
    expect([workerNumber(0), workerNumber(3), workerNumber(null)]).toEqual([1, 4, null]);
  });

  test('names its worker from 1, else the worker process of a result without one', () => {
    expect(shownWorkerNumber({ workerIndex: 5, parallelIndex: 1 })).toBe(2);
    expect(shownWorkerNumber({ workerIndex: 5 })).toBe(5);
    expect(shownWorkerNumber({ workerIndex: null, parallelIndex: null })).toBeNull();
    // A test Playwright never ran carries -1 for both.
    expect(shownWorkerNumber({ workerIndex: -1, parallelIndex: -1 })).toBeNull();
  });

  test('orders executions by shard, then lane, then worker process', () => {
    const executions = [
      { id: 'shard 2 lane 0', shardIndex: 2, parallelIndex: 0, workerIndex: 0 },
      { id: 'lane 1', shardIndex: 1, parallelIndex: 1, workerIndex: 1 },
      { id: 'lane 0, restarted', shardIndex: 1, parallelIndex: 0, workerIndex: 2 },
      { id: 'lane 0', shardIndex: 1, parallelIndex: 0, workerIndex: 0 },
      { id: 'never ran', shardIndex: 1, workerIndex: null },
    ];
    expect([...executions].sort(compareWorkers).map((e) => e.id)).toEqual([
      'never ran',
      'lane 0',
      'lane 0, restarted',
      'lane 1',
      'shard 2 lane 0',
    ]);
  });
});

describe("an execution's lane", () => {
  test('is stored from a batch, and a lane that is not one is stored as none', async () => {
    const runId = await submitRun([
      laneCase('pays', 4, 1),
      laneCase('refunds', 5, 0),
      laneCase('ships', 6),
      laneCase('returns', 7, -1),
      laneCase('browses', 8, 1.5),
    ]);
    expect(await lanesOf(runId)).toEqual([
      [4, 1],
      [5, 0],
      [6, null],
      [7, null],
      [8, null],
    ]);
  });

  test('is stored from the stream, and comes back with the run and its catch-up', async () => {
    const { runId, streamToken } = await start({
      body: { projectName: PROJECT, startTime: '2026-11-01T10:00:00.000Z', instanceId: 'local-1' },
    });
    await events({
      params: { id: String(runId) },
      body: { streamToken, testCases: [{ type: 'complete', ...laneCase('pays', 3, 1) }] },
    });
    expect(await lanesOf(runId)).toEqual([[3, 1]]);

    const run = await getTestRun(db as never, runId);
    expect(run?.testCases.map((tc) => [tc.workerIndex, tc.parallelIndex])).toEqual([[3, 1]]);
    expect((await storedCaseEventData(db as never, runId)).map((e) => e.parallelIndex)).toEqual([1]);
    const [row] = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testRunId, runId));
    expect((await getTestRunCase(db as never, row!.id))?.parallelIndex).toBe(1);
  });
});

describe('the worker an MCP tool reports', () => {
  test('is the lane from 1 with its shard, else the worker process of a result without a lane', async () => {
    const runId = await submitRun([laneCase('pays', 4, 1, 2), laneCase('refunds', 5)]);
    const getRun = MCP_TOOLS.find((tool) => tool.name === 'get_run')!.handler;
    const run = (await getRun(db as never, { runId }, ctx)) as { cases: Array<Record<string, unknown>> };
    const byTitle = new Map(run.cases.map((c) => [c.title, c]));
    expect(byTitle.get('pays')).toMatchObject({ worker: 2, shardIndex: 2 });
    expect(byTitle.get('pays')).toMatchObject({ workerIndex: 4 });
    expect(byTitle.get('refunds')).toMatchObject({ workerIndex: 5 });
    expect('worker' in byTitle.get('refunds')!).toBe(false);
    expect('shardIndex' in byTitle.get('refunds')!).toBe(false);

    const getCase = MCP_TOOLS.find((tool) => tool.name === 'get_test_run_case')!.handler;
    const pays = (await getCase(db as never, { executionId: byTitle.get('pays')!.executionId }, ctx)) as Record<
      string,
      unknown
    >;
    expect([pays.worker, pays.shardIndex, pays.workerIndex]).toEqual([2, 2, 4]);
    const refunds = (await getCase(db as never, { executionId: byTitle.get('refunds')!.executionId }, ctx)) as Record<
      string,
      unknown
    >;
    expect([refunds.workerIndex, 'worker' in refunds]).toEqual([5, false]);
  });
});

describe('a stuck test notification', () => {
  const stuck = {
    runId: 3,
    projectId: 1,
    projectName: 'checkout',
    testTitle: 'pays',
    browserName: 'chromium',
    startedAt: 1_700_000_000_000,
    elapsedMs: 300_000,
    usualMs: 8000,
  };
  const runningIn = (payload: Record<string, unknown>) =>
    eventFacts('test.stuck', { ...stuck, ...payload } as never, new DashboardLinks('https://piwi.example.test')).find(
      (f) => f.label === 'Running in',
    )?.value;

  test('names the worker by its lane from 1, with its shard', () => {
    expect(runningIn({ workerIndex: 5, parallelIndex: 1, shardIndex: 2 })).toBe('chromium, shard 2, worker 2');
    expect(runningIn({ workerIndex: 5 })).toBe('chromium, worker 5');
  });
});
