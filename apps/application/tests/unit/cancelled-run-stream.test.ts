import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
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
const start = (await import('../../server/api/test-runs/start.post')).default as unknown as Route;
const events = (await import('../../server/api/test-runs/[id]/events.post')).default as unknown as Route;
const heartbeat = (await import('../../server/api/test-runs/[id]/heartbeat.post')).default as unknown as Route;
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const PROJECT = 'cancelled-run-stream';

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
  testCaseCache.invalidate(project!.id);
  testSuiteCache.invalidate(project!.id);
});

/** A reporter's `/start` for the job whose runs share `instanceId`. */
async function startRun(instanceId: string): Promise<{ runId: number; streamToken: string }> {
  const res = await start({ body: { projectName: PROJECT, instanceId, startTime: '2026-11-02T10:00:00Z' } });
  return { runId: res.runId, streamToken: res.streamToken };
}

const result = (title: string) => ({
  type: 'complete',
  title,
  location: `tests/${title}.spec.ts:1:1`,
  status: 'passed',
  duration: 10,
});

const statusOf = async (runId: number) =>
  (await db.select({ status: schema.testRuns.status }).from(schema.testRuns).where(eq(schema.testRuns.id, runId)))[0]
    ?.status;

describe('a run that another run of its instance cancelled', () => {
  test('takes no more events or heartbeats: they are refused as the run is not running', async () => {
    const first = await startRun('ci-42');
    await events({
      params: { id: String(first.runId) },
      body: { streamToken: first.streamToken, testCases: [result('pays')] },
    });

    // A parallel job with the same run label starts, and cancels the first run.
    const second = await startRun('ci-42');
    expect(await statusOf(first.runId)).toBe('cancelled');

    await expect(
      events({
        params: { id: String(first.runId) },
        body: { streamToken: first.streamToken, testCases: [result('ships')] },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      heartbeat({ params: { id: String(first.runId) }, body: { streamToken: first.streamToken } }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const stored = await db
      .select({ runId: schema.testRunsCases.testRunId })
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.testRunId, first.runId));
    expect(stored).toHaveLength(1);

    // The run that replaced it streams on.
    const answer = await events({
      params: { id: String(second.runId) },
      body: { streamToken: second.streamToken, testCases: [result('ships')] },
    });
    expect(answer).toMatchObject({ success: true, processed: 1 });
  });
});
