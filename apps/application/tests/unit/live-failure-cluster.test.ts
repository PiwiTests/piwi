import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import { PROBE_RUN_METADATA_KEY } from '#shared/run-eligibility';
import { migrateToLatest } from './temp-db';

/**
 * A streamed failure's `test-completed` run event, and its replay in the stream's catch-up, carry the failure cluster
 * the attempt joined and what the run page shows of it (its name and triage status), so the page files the row under
 * its cluster at once. A run that forms no clusters (a lab run, a private run) carries none.
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
const start = (await import('../../server/api/test-runs/start.post')).default as unknown as Route;
const events = (await import('../../server/api/test-runs/[id]/events.post')).default as unknown as Route;
const { storedCaseEventData } = await import('../../server/utils/run-stream-catch-up');
const { runEventBus } = await import('../../server/utils/run-events');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const PROJECT = 'live-failure-cluster';

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
  testCaseCache.invalidate(project!.id);
  testSuiteCache.invalidate(project!.id);
});

/** A failed attempt as the reporter streams it. */
function failed(title: string, error = 'TimeoutError: locator.click: Timeout 5000ms exceeded') {
  return { type: 'complete', title, location: `tests/${title}.spec.ts:3:1`, status: 'failed', duration: 10, error };
}

/** Starts a streamed run, its stored run then changed by `stamp`, and returns what streaming `cases` publishes. */
async function stream(cases: unknown[], stamp?: Partial<typeof schema.testRuns.$inferInsert>) {
  const { runId, streamToken } = await start({
    body: { projectName: PROJECT, startTime: '2026-11-01T10:00:00.000Z', instanceId: 'local-1' },
  });
  if (stamp) await db.update(schema.testRuns).set(stamp).where(eq(schema.testRuns.id, runId));
  const published: Array<{ type: string; data: Record<string, unknown> }> = [];
  const unsubscribe = runEventBus.subscribe(runId, (event) => published.push(event as never));
  try {
    await events({ params: { id: String(runId) }, body: { streamToken, testCases: cases } });
  } finally {
    unsubscribe();
  }
  return { runId, completed: published.filter((event) => event.type === 'test-completed').map((e) => e.data) };
}

describe("a streamed failure's cluster", () => {
  test('rides on its test-completed event and on its replay, with the name and triage status the page shows', async () => {
    const { runId, completed } = await stream([failed('pays'), failed('refunds')]);
    const [cluster] = await db.select().from(schema.failureClusters);
    expect(cluster).toBeDefined();
    const expected = {
      failureClusterId: cluster!.id,
      failureCluster: { name: cluster!.title ?? `Cluster #${cluster!.id}`, status: 'open' },
    };
    expect(completed).toEqual([expect.objectContaining(expected), expect.objectContaining(expected)]);
    expect(await storedCaseEventData(db as never, runId)).toEqual([
      expect.objectContaining(expected),
      expect.objectContaining(expected),
    ]);
  });

  test('carries the triage status and the title the cluster has', async () => {
    await stream([failed('pays')]);
    const [cluster] = await db.select().from(schema.failureClusters);
    await db
      .update(schema.failureClusters)
      .set({ title: 'Pay button times out', status: 'investigating' })
      .where(eq(schema.failureClusters.id, cluster!.id));
    const { runId, completed } = await stream([failed('pays')]);
    const expected = {
      failureClusterId: cluster!.id,
      failureCluster: { name: 'Pay button times out', status: 'investigating' },
    };
    expect(completed[0]).toMatchObject(expected);
    expect((await storedCaseEventData(db as never, runId))[0]).toMatchObject(expected);
  });

  test('is none for a pass', async () => {
    const { runId, completed } = await stream([{ ...failed('pays'), status: 'passed', error: undefined }]);
    expect(completed[0]).toMatchObject({ failureClusterId: null, failureCluster: null });
    expect((await storedCaseEventData(db as never, runId))[0]).toMatchObject({
      failureClusterId: null,
      failureCluster: null,
    });
  });

  test('is none for a lab run, which forms no clusters', async () => {
    const { runId, completed } = await stream([failed('pays')], {
      origin: 'probe',
      metadata: { [PROBE_RUN_METADATA_KEY]: true },
    });
    expect(completed[0]).toMatchObject({ failureClusterId: null, failureCluster: null });
    expect((await storedCaseEventData(db as never, runId))[0]).toMatchObject({ failureClusterId: null });
    expect(await db.select().from(schema.failureClusters)).toEqual([]);
  });

  test('is none for a private run, which forms no clusters', async () => {
    const { completed } = await stream([failed('pays')], {
      origin: 'request',
      metadata: { piwiOrigin: { kind: 'request', ref: '1' } },
    });
    expect(completed.every((data) => data.failureClusterId === null && data.failureCluster === null)).toBe(true);
    expect(await db.select().from(schema.failureClusters)).toEqual([]);
  });
});
