import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { recordRouteMeta, underRoutePermission, type RouteAccessState, type RouteCaller } from './route-access';
import type { EventStreamSink } from '../../server/utils/event-stream';

/**
 * Who holds a failing CI test and lets it go, through the routes: a worker that says it can hold hears its project's
 * hold as its stream opens; a watch says whether its person may control the run (`run:control`), which only a
 * Maintainer's or a Project admin's does; and **Let it go** needs `run:control`, the project's setting on, the
 * person's own watch showing the held worker, and is logged with who asked.
 */

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
const streams = vi.hoisted(() => [] as Array<EventStreamSink & { sent: unknown[] }>);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/project-access', async (importOriginal) =>
  (await import('./route-access')).projectAccessMock(state, await importOriginal<object>()),
);
vi.mock('../../server/utils/event-stream', () => {
  const open = () => {
    const closers: Array<() => void> = [];
    let closed = false;
    const sink = {
      sent: [] as unknown[],
      send(message: unknown) {
        if (!closed) sink.sent.push(message);
      },
      backedUp: () => false,
      onDrain: () => {},
      onClose: (listener: () => void) => void closers.push(listener),
      close() {
        closed = true;
        for (const close of closers.splice(0)) close();
      },
      get closed() {
        return closed;
      },
    };
    streams.push(sink);
    return sink;
  };
  return { openEventStream: open, openLiveStream: open };
});

interface FakeEvent {
  context: Record<string, unknown>;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
  node: { req: { headers: Record<string, string> }; res: Record<string, unknown> };
}

vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params[name]);
vi.stubGlobal('getQuery', (event: FakeEvent) => event.query);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.mock('h3', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRequestHeader: (event: FakeEvent, name: string) => event.headers[name.toLowerCase()],
}));

type Route = (event: FakeEvent) => Promise<unknown>;
const watchRoute = underRoutePermission(
  state,
  (await import('../../server/api/test-runs/[id]/live-view/watch.get')).default as unknown as Route,
);
const streamRoute = underRoutePermission(
  state,
  (await import('../../server/api/test-runs/[id]/live-view.get')).default as unknown as Route,
);
const changeRoute = underRoutePermission(
  state,
  (await import('../../server/api/test-runs/[id]/live-view/watch.post')).default as unknown as Route,
);
const letGoRoute = underRoutePermission(
  state,
  (await import('../../server/api/test-runs/[id]/live-view/let-go.post')).default as unknown as Route,
);
const { liveViewRelay } = await import('../../server/utils/live-view');

function event(query: Record<string, string> = {}, headers: Record<string, string> = {}, body?: unknown): FakeEvent {
  return { context: {}, params: { id: '10' }, query, headers, body, node: { req: { headers }, res: {} } };
}

async function refusal(route: Route, e: FakeEvent): Promise<number | null> {
  try {
    await route(e);
    return null;
  } catch (error) {
    return (error as { statusCode?: number }).statusCode ?? -1;
  }
}

const caller = (id: number, name: string, role: ProjectRole): RouteCaller => ({
  user: { id, role: 'user', name, username: name.toLowerCase() } as User,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role }]),
});
const ANA = caller(1, 'Ana', ProjectRole.MAINTAINER);
const SAM = caller(2, 'Sam', ProjectRole.VIEWER);
const CAL = caller(3, 'Cal', ProjectRole.CONTRIBUTOR);

const WORKER = { shard: null, worker: 0, slot: 0 };
const HELD = {
  reason: 'held' as const,
  call: { title: 'Failed: Timed out', file: 'tests/a.spec.ts', line: 9 },
  test: 'pays',
  until: Date.now() + 300_000,
};

let db: TempDb;
let close: () => Promise<void>;
let key: string;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.caller = ANA;
  streams.length = 0;
  await db
    .insert(schema.projects)
    .values([{ id: 1, name: 'shop', liveView: true, liveViewHold: true, liveViewHoldMinutes: 3 }]);
  await db.insert(schema.testRuns).values([{ id: 10, projectId: 1, status: 'running', startTime: new Date() }]);
  key = liveViewRelay.mintKey(10, 1)!;
});

afterEach(async () => {
  liveViewRelay.endProject(1);
  await close();
});

/** The worker's stream, opened through its route: one that can hold says so. */
async function openWorker(features = 'hold'): Promise<EventStreamSink & { sent: unknown[] }> {
  const query: Record<string, string> = { worker: '0', slot: '0', ...(features ? { features } : {}) };
  expect(await refusal(streamRoute, event(query, { authorization: `Bearer ${key}` }))).toBeNull();
  return streams[streams.length - 1]!;
}

/** A watch of the worker in full, opened through its route by the caller now: its id. */
async function openWatch(): Promise<string> {
  expect(await refusal(watchRoute, event({ worker: '0', slot: '0' }))).toBeNull();
  return (streams[streams.length - 1]!.sent[0] as { watch: string }).watch;
}

const of = (sink: { sent: unknown[] }, type: string) => sink.sent.filter((m) => (m as { type: string }).type === type);

describe('the worker’s stream', () => {
  test('tells a worker that can hold its project’s hold, and nothing to one that cannot', async () => {
    expect(of(await openWorker(), 'hold')).toEqual([{ type: 'hold', ms: 180_000 }]);
    expect(of(await openWorker(''), 'hold')).toEqual([]);
  });
});

describe('a watch', () => {
  test('counts as a controller’s for a Maintainer, never a Viewer’s', async () => {
    vi.useFakeTimers();
    try {
      const worker = await openWorker();
      state.caller = SAM;
      await openWatch();
      vi.advanceTimersByTime(1000);
      expect(of(worker, 'view').some((view) => (view as { controller?: true }).controller)).toBe(false);
      state.caller = ANA;
      await openWatch();
      vi.advanceTimersByTime(1000);
      expect(of(worker, 'view').at(-1)).toMatchObject({ full: true, controller: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a change of a watch', () => {
  test('reads again whether its person may control the run', async () => {
    vi.useFakeTimers();
    try {
      const worker = await openWorker();
      const watch = await openWatch();
      vi.advanceTimersByTime(1000);
      expect(of(worker, 'view').at(-1)).toMatchObject({ controller: true });
      // Ana is a Viewer of the project now: her watch's next change says so.
      state.caller = caller(1, 'Ana', ProjectRole.VIEWER);
      expect(await changeRoute(event({}, {}, { watch, width: 900, height: 600 }))).toMatchObject({ success: true });
      vi.advanceTimersByTime(1000);
      expect(of(worker, 'view').at(-1)).not.toHaveProperty('controller');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Let it go', () => {
  const body = (watch: string) => ({ watch, worker: 0, slot: 0 });

  test('sends the command on the held worker’s stream, and logs who asked', async () => {
    const worker = await openWorker();
    const watch = await openWatch();
    liveViewRelay.receive(10, { type: 'stop', ...WORKER, stop: HELD });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      expect(await letGoRoute(event({}, {}, body(watch)))).toMatchObject({ success: true });
      expect(of(worker, 'let-go')).toEqual([{ type: 'let-go' }]);
      expect(info).toHaveBeenCalledWith(expect.stringMatching(/run #10, worker 1, by Ana \(user #1\)/));
    } finally {
      info.mockRestore();
    }
  });

  test('refuses a Viewer and a Contributor, a project with the setting off, and a worker not held', async () => {
    const worker = await openWorker();
    const watch = await openWatch();
    // Not held yet.
    expect(await refusal(letGoRoute, event({}, {}, body(watch)))).toBe(409);
    liveViewRelay.receive(10, { type: 'stop', ...WORKER, stop: HELD });
    for (const who of [SAM, CAL]) {
      state.caller = who;
      expect(await refusal(letGoRoute, event({}, {}, body(watch))), who.user.name!).toBe(403);
    }
    state.caller = ANA;
    expect(await refusal(letGoRoute, event({}, {}, { watch }))).toBe(400);
    expect(await refusal(letGoRoute, event({}, {}, { worker: 0 }))).toBe(400);
    await db.update(schema.projects).set({ liveViewHold: false });
    expect(await refusal(letGoRoute, event({}, {}, body(watch)))).toBe(409);
    expect(of(worker, 'let-go')).toEqual([]);
  });
});
