import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { recordRouteMeta, underRoutePermission, type RouteAccessState, type RouteCaller } from './route-access';
import type { EventStreamSink } from '../../server/utils/event-stream';

/**
 * Who pauses a CI test, resumes it and ends it, through the routes: a worker that says it can pause hears beside its
 * project's hold whether its controllers may pause; **Pause**, **Resume** and **End the test** need `run:control`,
 * the project's two settings on, the person's own watch showing the worker in full, and are logged with who asked;
 * and a project admin's change turns the pause on only beside the hold.
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
const controlRoute = underRoutePermission(
  state,
  (await import('../../server/api/test-runs/[id]/live-view/control.post')).default as unknown as Route,
);
const { updateProject } = await import('#shared/handlers/projects');
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
const PAUSED = {
  reason: 'pause' as const,
  call: { title: "Click getByRole('button')", file: 'tests/a.spec.ts', line: 9 },
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
    .values([{ id: 1, name: 'shop', liveView: true, liveViewHold: true, liveViewHoldMinutes: 3, liveViewPause: true }]);
  await db.insert(schema.testRuns).values([{ id: 10, projectId: 1, status: 'running', startTime: new Date() }]);
  key = liveViewRelay.mintKey(10, 1)!;
});

afterEach(async () => {
  liveViewRelay.endProject(1);
  await close();
});

/** The worker's stream, opened through its route: one that can hold says so. */
async function openWorker(features = 'hold,pause'): Promise<EventStreamSink & { sent: unknown[] }> {
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

const commands = (sink: { sent: unknown[] }) =>
  sink.sent.filter((m) => ['pause', 'resume', 'end-test'].includes((m as { type: string }).type));

describe('the worker’s stream', () => {
  test('tells a worker that can pause whether its controllers may, beside the hold', async () => {
    expect(of(await openWorker(), 'hold')).toEqual([{ type: 'hold', ms: 180_000, pause: true }]);
    expect(of(await openWorker('hold'), 'hold')).toEqual([{ type: 'hold', ms: 180_000 }]);
    await db.update(schema.projects).set({ liveViewPause: false });
    expect(of(await openWorker(), 'hold')).toEqual([{ type: 'hold', ms: 180_000 }]);
  });
});

describe('Pause, Resume and End the test', () => {
  const body = (watch: string, command: string) => ({ watch, worker: 0, slot: 0, command });

  test('send each command on the watched worker’s stream, and log who asked', async () => {
    const worker = await openWorker();
    const watch = await openWatch();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      expect(await controlRoute(event({}, {}, body(watch, 'pause')))).toMatchObject({ success: true });
      liveViewRelay.receive(10, { type: 'stop', ...WORKER, stop: PAUSED });
      expect(await controlRoute(event({}, {}, body(watch, 'resume')))).toMatchObject({ success: true });
      liveViewRelay.receive(10, { type: 'stop', ...WORKER, stop: PAUSED });
      expect(await controlRoute(event({}, {}, body(watch, 'end')))).toMatchObject({ success: true });
      expect(commands(worker)).toEqual([{ type: 'pause' }, { type: 'resume' }, { type: 'end-test' }]);
      expect(info).toHaveBeenCalledWith(expect.stringMatching(/Pause: run #10, worker 1, by Ana \(user #1\)/));
      expect(info).toHaveBeenCalledWith(expect.stringMatching(/End the test: run #10, worker 1, by Ana/));
    } finally {
      info.mockRestore();
    }
  });

  test('refuse a Viewer and a Contributor, either setting off, a command they do not know, and a watch of another worker', async () => {
    const worker = await openWorker();
    const watch = await openWatch();
    for (const who of [SAM, CAL]) {
      state.caller = who;
      expect(await refusal(controlRoute, event({}, {}, body(watch, 'pause'))), who.user.name!).toBe(403);
    }
    state.caller = ANA;
    expect(await refusal(controlRoute, event({}, {}, body(watch, 'step')))).toBe(400);
    expect(await refusal(controlRoute, event({}, {}, { watch, command: 'pause' }))).toBe(400);
    expect(await refusal(controlRoute, event({}, {}, body(watch, 'resume')))).toBe(409);
    expect(await refusal(controlRoute, event({}, {}, { ...body(watch, 'pause'), worker: 1, slot: 1 }))).toBe(409);
    await db.update(schema.projects).set({ liveViewPause: false });
    expect(await refusal(controlRoute, event({}, {}, body(watch, 'pause')))).toBe(409);
    await db.update(schema.projects).set({ liveViewPause: true, liveViewHold: false });
    expect(await refusal(controlRoute, event({}, {}, body(watch, 'pause')))).toBe(409);
    expect(commands(worker)).toEqual([]);
  });

  test('refuse a worker whose reporter cannot pause', async () => {
    const worker = await openWorker('hold');
    const watch = await openWatch();
    expect(await refusal(controlRoute, event({}, {}, body(watch, 'pause')))).toBe(409);
    expect(commands(worker)).toEqual([]);
  });
});

describe('the project’s pause setting', () => {
  test('turns on only beside the hold, and goes off with it', async () => {
    await db.update(schema.projects).set({ liveViewHold: false, liveViewPause: false });
    await expect(updateProject(db as never, 1, { liveViewPause: true })).rejects.toThrow(
      /needs Hold a failing CI test/,
    );
    await updateProject(db as never, 1, { liveViewHold: true, liveViewPause: true });
    let [row] = await db.select().from(schema.projects);
    expect(row).toMatchObject({ liveViewHold: true, liveViewPause: true });
    await updateProject(db as never, 1, { liveViewHold: false });
    [row] = await db.select().from(schema.projects);
    expect(row).toMatchObject({ liveViewHold: false, liveViewPause: false });
  });
});
