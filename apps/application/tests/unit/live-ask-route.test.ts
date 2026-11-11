import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ASK_TO_WATCH_MS } from '@piwitests/core/live-view';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { recordRouteMeta, type RouteAccessState, type RouteCaller } from './route-access';

/**
 * Who may ask to watch a run, and of which run: a signed-in reader of its project, never an API key, of a running run
 * outside CI that holds a live view key and is not shared now, in a project with the live view and Ask to watch on;
 * once per `ASK_TO_WATCH_MS`, then 429 with when to ask again.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/project-access', async (importOriginal) =>
  (await import('./route-access')).projectAccessMock(state, await importOriginal<object>()),
);

interface FakeEvent {
  context: Record<string, unknown>;
  params: Record<string, string>;
  headers: Record<string, string>;
}

const responseHeaders = new Map<string, unknown>();
vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params[name]);
vi.stubGlobal('setResponseHeader', (_event: FakeEvent, name: string, value: unknown) =>
  responseHeaders.set(name, value),
);
vi.stubGlobal('apiError', apiError);

type Route = (event: FakeEvent) => Promise<unknown>;
const askRoute = (await import('../../server/api/test-runs/[id]/live-view/ask.post')).default as unknown as Route;
const { liveViewRelay } = await import('../../server/utils/live-view');
const { liveAsks } = await import('../../server/utils/live-asks');

const event = (runId: number): FakeEvent => ({ context: {}, params: { id: String(runId) }, headers: {} });

/** The status and data a route refuses with; null when it answers. */
async function refusal(runId: number): Promise<{ status: number; data?: Record<string, unknown> } | null> {
  try {
    await askRoute(event(runId));
    return null;
  } catch (error) {
    const e = error as { statusCode?: number; data?: Record<string, unknown> };
    return { status: e.statusCode ?? -1, data: e.data };
  }
}

const readerOf = (projectId: number, over: Partial<RouteCaller> = {}): RouteCaller => ({
  user: { id: 3, role: 'member', name: 'Dana', username: 'dana' } as User,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId, role: ProjectRole.VIEWER }]),
  ...over,
});

const RUNS = [10, 11, 12, 13, 20, 30];
let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.caller = readerOf(1);
  responseHeaders.clear();
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop', liveView: true },
    { id: 2, name: 'admin', liveView: true, askToWatch: false },
    { id: 3, name: 'quiet' },
  ]);
  const local = { piwiOrigin: { kind: 'editor' } };
  await db.insert(schema.testRuns).values([
    { id: 10, projectId: 1, status: 'running', startTime: new Date(), metadata: local },
    { id: 11, projectId: 1, status: 'running', startTime: new Date(), metadata: { ci: { provider: 'github' } } },
    { id: 12, projectId: 1, status: 'passed', startTime: new Date(), metadata: local },
    { id: 13, projectId: 1, status: 'running', startTime: new Date(), metadata: local },
    { id: 20, projectId: 2, status: 'running', startTime: new Date(), metadata: local },
    { id: 30, projectId: 3, status: 'running', startTime: new Date(), metadata: local },
  ]);
  for (const [runId, projectId] of [
    [10, 1],
    [11, 1],
    [12, 1],
    [20, 2],
    [30, 3],
  ] as const) {
    liveViewRelay.mintKey(runId, projectId);
  }
});

afterEach(async () => {
  for (const runId of RUNS) {
    liveViewRelay.endRun(runId);
    liveAsks.endRun(runId);
  }
  await close();
});

describe('asking to watch a run', () => {
  test('a signed-in reader asks once per window, then hears when they may ask again', async () => {
    expect(await askRoute(event(10))).toMatchObject({ by: 'Dana', answer: null, waitMs: ASK_TO_WATCH_MS });
    const again = await refusal(10);
    expect(again?.status).toBe(429);
    expect(again?.data?.waitMs).toBeGreaterThan(0);
    expect(Number(responseHeaders.get('Retry-After'))).toBeGreaterThan(0);
    // The ask waits for the run's reporter.
    expect(liveAsks.handOver(10)).toMatchObject({ by: 'Dana' });
  });

  test('refuses an API key and a reader of another project', async () => {
    state.caller = readerOf(1, { apiKey: true });
    expect((await refusal(10))?.status).toBe(403);
    state.caller = readerOf(3);
    expect((await refusal(10))?.status).toBe(403);
    state.caller = null;
    expect((await refusal(10))?.status).toBe(401);
  });

  test('refuses a CI run, a run that ended, a run without a key, and a project that does not take asks', async () => {
    expect((await refusal(11))?.status).toBe(409);
    expect((await refusal(12))?.status).toBe(409);
    expect((await refusal(13))?.status).toBe(409);
    state.caller = readerOf(2);
    expect((await refusal(20))?.status).toBe(409);
    state.caller = readerOf(3);
    expect((await refusal(30))?.status).toBe(409);
    expect(liveAsks.handOver(11) ?? liveAsks.handOver(20) ?? liveAsks.handOver(30)).toBeNull();
  });

  test('refuses a run shared now', async () => {
    const key = liveViewRelay.mintKey(10, 1)!;
    const sink = {
      closed: false,
      send: () => {},
      backedUp: () => false,
      onDrain: () => {},
      onClose: () => {},
      close: () => {},
    };
    expect(
      liveViewRelay.connectWorker(liveViewRelay.authorize(10, key)!, { shard: null, worker: 0 }, () => sink),
    ).toBeNull();
    expect((await refusal(10))?.status).toBe(409);
  });
});
