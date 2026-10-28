import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { recordRouteMeta, underRoutePermission, type RouteAccessState, type RouteCaller } from './route-access';

/**
 * Who reaches a run's live view: watching a worker needs what opening the run needs, in a project with the live view
 * on; a worker's stream and posts need a key of that run, while it is live and its project's live view is on, and an
 * interrupted run keeps its keys for the worker to try again; a post is bounded.
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
  query: Record<string, string>;
  headers: Record<string, string>;
  node: { req: { headers: Record<string, string> }; res: Record<string, unknown> };
}

vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params[name]);
vi.stubGlobal('getQuery', (event: FakeEvent) => event.query);
vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.headers[name.toLowerCase()]);
vi.stubGlobal('apiError', apiError);
vi.mock('h3', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRequestHeader: (event: FakeEvent, name: string) => event.headers[name.toLowerCase()],
}));

type Route = (event: FakeEvent) => Promise<unknown>;
const watch = underRoutePermission(
  state,
  (await import('../../server/api/test-runs/[id]/live-view/watch.get')).default as unknown as Route,
);
const workers = underRoutePermission(
  state,
  (await import('../../server/api/test-runs/[id]/live-view/workers.get')).default as unknown as Route,
);
const stream = underRoutePermission(
  state,
  (await import('../../server/api/test-runs/[id]/live-view.get')).default as unknown as Route,
);
const post = underRoutePermission(
  state,
  (await import('../../server/api/test-runs/[id]/live-view.post')).default as unknown as Route,
);
const { liveViewRelay } = await import('../../server/utils/live-view');

function event(runId: number, query: Record<string, string> = {}, headers: Record<string, string> = {}): FakeEvent {
  return { context: {}, params: { id: String(runId) }, query, headers, node: { req: { headers }, res: {} } };
}

/** The status a route refuses with; null when it answers. */
async function refusal(route: Route, e: FakeEvent): Promise<number | null> {
  try {
    await route(e);
    return null;
  } catch (error) {
    return (error as { statusCode?: number }).statusCode ?? -1;
  }
}

const viewerOf = (projectId: number): RouteCaller => ({
  user: { id: 3, role: 'user', name: 'Sam', username: 'sam' } as User,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId, role: ProjectRole.VIEWER }]),
});

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.caller = viewerOf(1);
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop', liveView: true },
    { id: 2, name: 'admin', liveView: true },
    { id: 3, name: 'quiet' },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 10, projectId: 1, status: 'running', startTime: new Date() },
    { id: 20, projectId: 2, status: 'running', startTime: new Date() },
    { id: 30, projectId: 3, status: 'running', startTime: new Date() },
    { id: 11, projectId: 1, status: 'passed', startTime: new Date() },
    { id: 12, projectId: 1, status: 'interrupted', startTime: new Date() },
  ]);
});

afterEach(async () => {
  for (const runId of [10, 11, 12, 20, 30]) liveViewRelay.endRun(runId);
  await close();
});

describe('watching a worker', () => {
  test('needs what opening the run needs: a viewer of another project is refused', async () => {
    expect(await refusal(watch, event(20, { worker: '0' }))).toBe(403);
    expect(await refusal(workers, event(20))).toBe(403);
    state.caller = null;
    expect(await refusal(watch, event(10, { worker: '0' }))).toBe(401);
  });

  test('needs the project’s live view on, and a worker in it', async () => {
    state.caller = viewerOf(3);
    expect(await refusal(watch, event(30, { worker: '0' }))).toBe(404);
    expect(await workers(event(30))).toEqual({
      enabled: false,
      workers: [],
      received: { requests: 0, frames: 0, bytes: 0 },
    });
    expect(await refusal(watch, event(10, { worker: '0' }))).toBe(403);
    state.caller = viewerOf(1);
    expect(await refusal(watch, event(10, { worker: '0' }))).toBe(404);
    expect(await refusal(watch, event(10, { worker: 'x' }))).toBe(400);
    expect(await workers(event(10))).toMatchObject({ enabled: true, workers: [] });
  });
});

describe("a worker's stream and posts", () => {
  test('need a key of the run, while the run is live', async () => {
    const key = liveViewRelay.mintKey(10, 1)!;
    const otherKey = liveViewRelay.mintKey(20, 2)!;
    const ended = liveViewRelay.mintKey(11, 1)!;
    expect(await refusal(stream, event(10, { worker: '0' }))).toBe(401);
    expect(await refusal(stream, event(10, { worker: '0' }, { authorization: `Bearer ${otherKey}` }))).toBe(401);
    expect(await refusal(stream, event(10, { worker: '0' }, { authorization: 'Bearer pd_api_key' }))).toBe(401);
    expect(await refusal(stream, event(10, {}, { authorization: `Bearer ${key}` }))).toBe(400);
    expect(await refusal(stream, event(11, { worker: '0' }, { authorization: `Bearer ${ended}` }))).toBe(410);
    // A run no longer live gives its keys up.
    expect(liveViewRelay.authorize(11, ended)).toBeNull();

    expect(await refusal(post, event(10, {}, { authorization: `Bearer ${otherKey}` }))).toBe(401);
    expect(await refusal(post, event(10, {}, { authorization: `Bearer ${key}`, 'content-length': '999999999' }))).toBe(
      413,
    );
    expect(await refusal(post, event(10, {}, { authorization: `Bearer ${key}` }))).toBe(413);
    // Every request is counted, refused ones too.
    expect(liveViewRelay.countsFor(10).requests).toBe(7);
  });

  test('need the project’s live view on: a key minted as it turned off opens nothing', async () => {
    const key = liveViewRelay.mintKey(30, 3)!;
    expect(await refusal(stream, event(30, { worker: '0' }, { authorization: `Bearer ${key}` }))).toBe(404);
    expect(liveViewRelay.authorize(30, key)).toBeNull();
  });

  test('are refused for a while as the run is interrupted, its key kept for when it goes on', async () => {
    const key = liveViewRelay.mintKey(12, 1)!;
    expect(await refusal(stream, event(12, { worker: '0' }, { authorization: `Bearer ${key}` }))).toBe(409);
    expect(liveViewRelay.authorize(12, key)).not.toBeNull();
  });
});
