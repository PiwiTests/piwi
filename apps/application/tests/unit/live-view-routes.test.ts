import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import {
  LIVE_FRAME_TYPE,
  MAX_LIVE_INSPECT_MESSAGE,
  encodeLiveMessage,
  liveFrameHeader,
  liveResourceHeader,
  liveSnapshotHeader,
} from '@piwitests/core/live-view';
import type { LiveSnapshot } from '@piwitests/core/live-inspect';
import { recordRouteMeta, underRoutePermission, type RouteAccessState, type RouteCaller } from './route-access';
import type { EventStreamSink } from '../../server/utils/event-stream';

/**
 * Who reaches a run's live view: watching it needs what opening the run needs, in a project with the live view on and
 * while the run is live, and a watch changes what it shows only for the person who holds it; a worker's stream and
 * posts need a key of that run, while it is live and its project's live view is on, and an interrupted run keeps its
 * keys for the worker to try again; a post is bounded, a frame read as bytes or, from an older reporter, as JSON. A run keeps its keys' digests, never a
 * key, and an instance started again takes a running worker's key back by them, that run's alone, while it is live and
 * its project's live view is on.
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
  body?: unknown;
  stream?: ReadableStream<Uint8Array>;
  node: { req: { headers: Record<string, string> }; res: Record<string, unknown> };
}

vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params[name]);
vi.stubGlobal('getQuery', (event: FakeEvent) => event.query);
vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.headers[name.toLowerCase()]);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.mock('h3', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRequestHeader: (event: FakeEvent, name: string) => event.headers[name.toLowerCase()],
  getRequestWebStream: (event: FakeEvent) => event.stream,
  setResponseHeader: (event: FakeEvent, name: string, value: string) => {
    (event.node.res as Record<string, string>)[name.toLowerCase()] = value;
  },
}));

type Route = (event: FakeEvent) => Promise<unknown>;
const watch = underRoutePermission(
  state,
  (await import('../../server/api/test-runs/[id]/live-view/watch.get')).default as unknown as Route,
);
const change = underRoutePermission(
  state,
  (await import('../../server/api/test-runs/[id]/live-view/watch.post')).default as unknown as Route,
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
const page = underRoutePermission(
  state,
  (await import('../../server/api/test-runs/[id]/live-view/watch/[watch]/snapshot.get')).default as unknown as Route,
);
const { liveViewRelay, storeLiveViewKey } = await import('../../server/utils/live-view');

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
  // The projects' live view ends, which, unlike a run that ended, lets the next test watch the same runs.
  for (const projectId of [1, 2, 3]) liveViewRelay.endProject(projectId);
  await close();
});

/** A watch's stream as a route test holds it: what it was sent. */
function heldStream(): EventStreamSink & { sent: unknown[] } {
  const closers: Array<() => void> = [];
  let closed = false;
  return {
    sent: [],
    send(message) {
      if (!closed) this.sent.push(message);
    },
    backedUp: () => false,
    onDrain: () => {},
    onClose: (listener) => void closers.push(listener),
    close() {
      closed = true;
      for (const close of closers.splice(0)) close();
    },
    get closed() {
      return closed;
    },
  };
}

/** A key this instance never held, as a worker presents it after the instance started again. */
const KEY_BEFORE_RESTART = `pdl_${'r'.repeat(43)}`;
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

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
      viewers: 0,
      maxViewers: 16,
      received: { requests: 0, frames: 0, bytes: 0 },
    });
    expect(await refusal(watch, event(10, { worker: '0' }))).toBe(403);
    state.caller = viewerOf(1);
    expect(await refusal(watch, event(10, { worker: '0' }))).toBe(404);
    expect(await refusal(watch, event(10, { worker: 'x' }))).toBe(400);
    expect(await workers(event(10))).toMatchObject({ enabled: true, workers: [] });
  });

  test('shows a worker in full or every worker’s tile, at a size it names, while the run is live', async () => {
    // Neither a worker nor tiles: nothing to show.
    expect(await refusal(watch, event(10))).toBe(400);
    expect(await refusal(watch, event(10, { tiles: '1', width: 'wide', height: '600' }))).toBe(400);
    // A size names both its sides, each a whole number from 1.
    expect(await refusal(watch, event(10, { tiles: '1', height: '600' }))).toBe(400);
    expect(await refusal(watch, event(10, { tiles: '1', width: '900' }))).toBe(400);
    expect(await refusal(watch, event(10, { tiles: '1', width: '0', height: '600' }))).toBe(400);
    expect(await refusal(watch, event(11, { tiles: '1' }))).toBe(410);
    expect(await refusal(watch, event(12, { tiles: '1' }))).toBe(410);
    state.caller = viewerOf(3);
    expect(await refusal(watch, event(30, { tiles: '1' }))).toBe(404);
  });

  test('changes what a watch shows for the person who holds it alone, saying what it shows', async () => {
    const at = (runId: number, body: unknown) => ({ ...event(runId), body });
    expect(await refusal(change, at(20, { watch: 'w'.repeat(22), tiles: true }))).toBe(403);
    expect(await refusal(change, at(10, null))).toBe(400);
    expect(await refusal(change, at(10, { tiles: true }))).toBe(400);
    expect(await refusal(change, at(10, { watch: 'w'.repeat(22) }))).toBe(400);
    expect(await refusal(change, at(10, { watch: 'w'.repeat(22), tiles: 'yes' }))).toBe(400);
    expect(await refusal(change, at(10, { watch: 'w'.repeat(22), focus: { worker: -1 } }))).toBe(400);
    expect(await refusal(change, at(10, { watch: 'w'.repeat(22), width: 900 }))).toBe(400);
    // A watch the relay does not hold for this person.
    expect(await refusal(change, at(10, { watch: 'w'.repeat(22), focus: null, width: 900, height: 600 }))).toBe(404);
    expect(await refusal(change, at(10, { watch: 'w'.repeat(22), width: -5, height: 600 }))).toBe(400);
    state.caller = null;
    expect(await refusal(change, at(10, { watch: 'w'.repeat(22), tiles: true }))).toBe(401);
  });

  test('answers what the watch shows after a change, and after a full view refused, the rest applied', async () => {
    const sink = heldStream();
    expect(liveViewRelay.openWatch(10, 1, { focus: null, tiles: true }, () => sink, 3)).toBeNull();
    const id = (sink.sent[0] as { watch: string }).watch;
    const at = (body: unknown) => ({ ...event(10), body });
    expect(await change(at({ watch: id, width: 900, height: 600 }))).toEqual({
      success: true,
      watch: { focus: null, tiles: true, width: 900, height: 600, layers: [], inspect: false },
    });
    let refused: { statusCode?: number; data?: Record<string, unknown> } | null = null;
    try {
      await change(at({ watch: id, focus: { worker: 4 }, tiles: false }));
    } catch (error) {
      refused = error as typeof refused;
    }
    expect(refused?.statusCode).toBe(404);
    expect(refused?.data?.watch).toEqual({
      focus: null,
      tiles: false,
      width: 900,
      height: 600,
      layers: [],
      inspect: false,
    });
  });

  test('takes the layers a watch asks and its ask for the page’s text, and refuses them named wrongly', async () => {
    const sink = heldStream();
    expect(liveViewRelay.openWatch(10, 1, { focus: null, tiles: true }, () => sink, 3)).toBeNull();
    const id = (sink.sent[0] as { watch: string }).watch;
    const at = (body: unknown) => ({ ...event(10), body });
    expect(await change(at({ watch: id, layers: ['text', 'calls', 'events'], text: true }))).toMatchObject({
      success: true,
      watch: { layers: ['events', 'text'] },
    });
    expect(await refusal(change, at({ watch: id, layers: 'text' }))).toBe(400);
    expect(await refusal(change, at({ watch: id, text: false }))).toBe(400);
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
    // A run no longer live gives its keys up, and says so to the worker that presents one again.
    expect(liveViewRelay.authorize(11, ended)).toBeNull();
    expect(await refusal(stream, event(11, { worker: '0' }, { authorization: `Bearer ${ended}` }))).toBe(410);
    expect(await refusal(post, event(11, {}, { authorization: `Bearer ${ended}` }))).toBe(410);

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
    expect(await refusal(stream, event(30, { worker: '0' }, { authorization: `Bearer ${key}` }))).toBe(404);
  });

  test('turned off while a worker streams: the worker that opens its stream again, or posts, hears it is off', async () => {
    const key = liveViewRelay.mintKey(10, 1)!;
    liveViewRelay.endProject(1);
    expect(await refusal(stream, event(10, { worker: '0' }, { authorization: `Bearer ${key}` }))).toBe(404);
    expect(await refusal(post, event(10, {}, { authorization: `Bearer ${key}` }))).toBe(404);
  });

  test('read a frame as one live message, or as JSON from an older reporter', async () => {
    const key = liveViewRelay.mintKey(10, 1)!;
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const posting = (body: Uint8Array, type: string) => ({
      ...event(10, {}, { ...bearer(key), 'content-type': type, 'content-length': String(body.length) }),
      stream: new Blob([body as Uint8Array<ArrayBuffer>]).stream(),
    });
    const frame = encodeLiveMessage(liveFrameHeader({ shard: null, worker: 0 }, { call: null, test: 'pays' }), jpeg);
    // Read whole: the worker holds no stream yet (409).
    expect(await refusal(post, posting(frame, LIVE_FRAME_TYPE))).toBe(409);
    const json = new TextEncoder().encode(
      JSON.stringify({ type: 'frame', shard: null, worker: 0, data: Buffer.from(jpeg).toString('base64') }),
    );
    expect(await refusal(post, posting(json, 'application/json'))).toBe(409);
    // A message that is not one, or that is not a frame, as bytes.
    expect(await refusal(post, posting(frame.subarray(0, frame.length - 1), LIVE_FRAME_TYPE))).toBe(400);
    const stop = encodeLiveMessage({ type: 'stop', shard: null, worker: 0, stop: null });
    expect(await refusal(post, posting(stop, LIVE_FRAME_TYPE))).toBe(400);
    expect(await refusal(post, posting(new TextEncoder().encode('{'), 'application/json'))).toBe(400);
    // Either form's image is a JPEG.
    const png = new TextEncoder().encode(
      JSON.stringify({ type: 'frame', worker: 0, data: 'iVBORw0KGgoAAAANSUhEUg==' }),
    );
    expect(await refusal(post, posting(png, 'application/json'))).toBe(400);
    const notJpeg = encodeLiveMessage(liveFrameHeader({ shard: null, worker: 0 }, { call: null, test: null }), png);
    expect(await refusal(post, posting(notJpeg, LIVE_FRAME_TYPE))).toBe(400);
    // Bounded: a frame's message by its own size, larger than a JSON message's.
    const over = { ...posting(frame, LIVE_FRAME_TYPE) };
    over.headers['content-length'] = String(MAX_LIVE_INSPECT_MESSAGE + 1);
    expect(await refusal(post, over)).toBe(413);
  });

  test('are refused for a while as the run is interrupted, its key kept for when it goes on', async () => {
    const key = liveViewRelay.mintKey(12, 1)!;
    expect(await refusal(stream, event(12, { worker: '0' }, { authorization: `Bearer ${key}` }))).toBe(409);
    expect(liveViewRelay.authorize(12, key)).not.toBeNull();
  });
});

describe('a key its run stores, which the instance started again does not hold', () => {
  test('is kept as its digest alone, of each shard that set the run up', async () => {
    const first = liveViewRelay.mintKey(10, 1)!;
    const second = liveViewRelay.mintKey(10, 1)!;
    await storeLiveViewKey(db, 10, first);
    await storeLiveViewKey(db, 10, second);
    const [run] = await db
      .select({ digests: schema.testRuns.liveViewKeyDigests })
      .from(schema.testRuns)
      .where(eq(schema.testRuns.id, 10));
    expect(run!.digests).toHaveLength(2);
    expect(JSON.stringify(run!.digests)).not.toContain(first.slice(4));
    expect(JSON.stringify(run!.digests)).not.toContain(second.slice(4));
  });

  test('opens its running run’s posts and stream again, and is held again', async () => {
    await storeLiveViewKey(db, 10, KEY_BEFORE_RESTART);
    expect(liveViewRelay.authorize(10, KEY_BEFORE_RESTART)).toBeNull();
    // Taken: the post asks for its body (413), the stream for its worker (400).
    expect(await refusal(post, event(10, {}, bearer(KEY_BEFORE_RESTART)))).toBe(413);
    expect(liveViewRelay.authorize(10, KEY_BEFORE_RESTART)).not.toBeNull();
    expect(await refusal(stream, event(10, {}, bearer(KEY_BEFORE_RESTART)))).toBe(400);
  });

  test('opens no other run, nor a run that ended, nor a project with the live view off, and no wrong key opens it', async () => {
    for (const runId of [10, 11, 30]) await storeLiveViewKey(db, runId, KEY_BEFORE_RESTART);
    expect(await refusal(stream, event(20, { worker: '0' }, bearer(KEY_BEFORE_RESTART)))).toBe(401);
    expect(await refusal(post, event(20, {}, bearer(KEY_BEFORE_RESTART)))).toBe(401);
    expect(await refusal(stream, event(11, { worker: '0' }, bearer(KEY_BEFORE_RESTART)))).toBe(410);
    expect(await refusal(post, event(11, {}, bearer(KEY_BEFORE_RESTART)))).toBe(410);
    expect(await refusal(stream, event(30, { worker: '0' }, bearer(KEY_BEFORE_RESTART)))).toBe(404);
    const wrong = `pdl_${'s'.repeat(43)}`;
    expect(await refusal(stream, event(10, { worker: '0' }, bearer(wrong)))).toBe(401);
    expect(await refusal(post, event(10, {}, bearer(wrong)))).toBe(401);
    // The stored digest itself is no key.
    const [run] = await db
      .select({ digests: schema.testRuns.liveViewKeyDigests })
      .from(schema.testRuns)
      .where(eq(schema.testRuns.id, 10));
    expect(await refusal(stream, event(10, { worker: '0' }, bearer(run!.digests![0]!)))).toBe(401);
    for (const runId of [11, 20, 30]) expect(liveViewRelay.authorize(runId, KEY_BEFORE_RESTART)).toBeNull();
  });

  test('opens nothing while its project’s live view is off, and its run’s stream again once it is back on', async () => {
    await storeLiveViewKey(db, 10, KEY_BEFORE_RESTART);
    await db.update(schema.projects).set({ liveView: false }).where(eq(schema.projects.id, 1));
    liveViewRelay.endProject(1);
    expect(await refusal(stream, event(10, { worker: '0' }, bearer(KEY_BEFORE_RESTART)))).toBe(404);
    expect(await refusal(post, event(10, {}, bearer(KEY_BEFORE_RESTART)))).toBe(404);
    await db.update(schema.projects).set({ liveView: true }).where(eq(schema.projects.id, 1));
    expect(await refusal(stream, event(10, {}, bearer(KEY_BEFORE_RESTART)))).toBe(400);
  });

  test('of an interrupted run, is held again for when the run goes on', async () => {
    await storeLiveViewKey(db, 12, KEY_BEFORE_RESTART);
    expect(await refusal(stream, event(12, { worker: '0' }, bearer(KEY_BEFORE_RESTART)))).toBe(409);
    expect(liveViewRelay.authorize(12, KEY_BEFORE_RESTART)).not.toBeNull();
  });

  test('opens nothing a day after its run began', async () => {
    await storeLiveViewKey(db, 10, KEY_BEFORE_RESTART);
    await db
      .update(schema.testRuns)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(schema.testRuns.id, 10));
    expect(await refusal(stream, event(10, { worker: '0' }, bearer(KEY_BEFORE_RESTART)))).toBe(401);
  });
});

describe('Inspect’s page of a call', () => {
  const ID = { shard: null, worker: 0 };
  const CSS = `${'c'.repeat(40)}.css`;
  /** A snapshot's header as worker 0 posts it, full, of its page's main frame, naming the stylesheet `CSS`. */
  const header = (call: string, phase: LiveSnapshot['phase']): LiveSnapshot => ({
    call,
    title: `Click getByRole('button', { name: 'Pay' }) ${call}`,
    phase,
    page: 'page@1',
    frame: 'frame@1',
    main: true,
    full: true,
    index: 0,
    at: Date.now(),
    resources: [
      { url: 'https://shop.test/app.css', sha1: CSS },
      { url: 'https://shop.test/logo.svg', sha1: `${'d'.repeat(40)}.svg` },
    ],
  });
  /** A page holding what must never render: a script, an inline handler, a script URL, an SVG image. */
  const html = [
    'HTML',
    {},
    ['HEAD', {}, ['LINK', { rel: 'stylesheet', href: '/app.css' }]],
    [
      'BODY',
      { onload: 'steal()' },
      ['SCRIPT', { src: 'https://evil.test/x.js' }, 'document.cookie'],
      ['A', { href: 'javascript:steal()', onclick: 'steal()' }, 'Pay'],
      ['IMG', { src: '/logo.svg' }],
      ['INPUT', { type: 'password', __playwright_value_: 'hunter2' }],
    ],
  ];

  /** A run 10's worker 0 in the live view, and person 3's watch of it with Inspect open, and what the worker posts. */
  function inspecting(inspect = true, runId = 10) {
    const key = liveViewRelay.mintKey(runId, 1)!;
    liveViewRelay.connectWorker(liveViewRelay.authorize(runId, key)!, ID, () => heldStream());
    const sink = heldStream();
    expect(liveViewRelay.openWatch(runId, 1, { focus: ID, inspect }, () => sink, 3)).toBeNull();
    const watchId = (sink.sent[0] as { watch: string }).watch;
    const send = (head: Record<string, unknown>, data: Uint8Array) => {
      const body = encodeLiveMessage(head, data);
      const headers = { ...bearer(key), 'content-type': LIVE_FRAME_TYPE, 'content-length': String(body.length) };
      return refusal(post, {
        ...event(runId, {}, headers),
        stream: new Blob([body as Uint8Array<ArrayBuffer>]).stream(),
      });
    };
    const ask = (query: Record<string, string>, id = watchId) => ({
      ...event(runId, { worker: '0', ...query }),
      params: { id: String(runId), watch: id },
    });
    return { sink, send, ask, watchId };
  }

  test('serves the page of a call the worker sent in a sandboxed frame: no script, no handler, no script URL', async () => {
    const { send, ask, sink } = inspecting();
    const css = '.pay{background:url(/pay.png)}';
    expect(await send(liveResourceHeader(ID, { sha1: CSS, contentType: 'text/css' }), Buffer.from(css))).toBeNull();
    // A script, a document and an SVG are never taken.
    for (const contentType of ['text/javascript', 'text/html', 'image/svg+xml', 'application/octet-stream']) {
      const sha1 = `${'d'.repeat(40)}.svg`;
      expect(await send(liveResourceHeader(ID, { sha1, contentType }), Buffer.from('<svg onload="steal()"/>'))).toBe(
        400,
      );
    }
    const data = new TextEncoder().encode(
      JSON.stringify({ html, frameUrl: 'https://shop.test/checkout', viewport: { width: 1280, height: 720 } }),
    );
    expect(await send(liveSnapshotHeader(ID, header('call@4', 'action'), 'pays'), data)).toBeNull();
    // The watch heard of it, without its JSON nor the resources it names.
    const heard = sink.sent.find((m) => (m as { type: string }).type === 'snapshot') as Record<string, unknown>;
    expect(heard).toMatchObject({ type: 'snapshot', call: 'call@4', phase: 'action', test: 'pays' });
    expect(heard).not.toHaveProperty('resources');
    expect(heard).not.toHaveProperty('data');

    expect(await page(ask({ call: 'call@4', phase: 'action', format: 'json' }))).toEqual({
      viewport: { width: 1280, height: 720 },
    });
    const e = ask({ call: 'call@4', phase: 'action', mode: 'readonly' });
    const doc = (await page(e)) as string;
    const headers = e.node.res as Record<string, string>;
    expect(headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['cache-control']).toBe('no-store');
    expect(doc).toContain('.pay{background:none}');
    expect(doc).not.toMatch(/steal|document\.cookie|evil\.test|javascript:|hunter2|<svg|logo\.svg|<link/);
    expect(doc).toContain('<a>Pay</a>');
  });

  test('is the person’s own watch’s with Inspect open alone, of a run they may open, and says what it lacks', async () => {
    const { ask, send, watchId } = inspecting();
    const data = new TextEncoder().encode(JSON.stringify({ html: ['HTML', {}] }));
    expect(await send(liveSnapshotHeader(ID, header('call@1', 'before'), 'pays'), data)).toBeNull();
    expect(await page(ask({ call: 'call@1', phase: 'before' }))).toContain('<html>');
    // Named wrongly.
    expect(await refusal(page, ask({ call: 'call@1', phase: 'during' }))).toBe(400);
    expect(await refusal(page, ask({ call: 'call 1', phase: 'before' }))).toBe(400);
    expect(await refusal(page, ask({ call: 'call@1', phase: 'before', worker: 'x' }))).toBe(400);
    // A moment the worker sent no page of.
    expect(await refusal(page, ask({ call: 'call@2', phase: 'before' }))).toBe(404);
    // Another person's watch, a watch of another run, one without Inspect open.
    state.caller = { ...viewerOf(1), user: { ...viewerOf(1).user!, id: 4 } as User };
    expect(await refusal(page, ask({ call: 'call@1', phase: 'before' }))).toBe(404);
    state.caller = viewerOf(1);
    expect(await refusal(page, ask({ call: 'call@1', phase: 'before' }, 'w'.repeat(22)))).toBe(404);
    const other = inspecting(false);
    expect(await refusal(page, other.ask({ call: 'call@1', phase: 'before' }))).toBe(409);
    // A viewer of another project, and nobody signed in.
    state.caller = viewerOf(2);
    expect(await refusal(page, ask({ call: 'call@1', phase: 'before' }))).toBe(403);
    state.caller = null;
    expect(await refusal(page, ask({ call: 'call@1', phase: 'before' }))).toBe(401);
    state.caller = viewerOf(1);
    expect(watchId).toBeTruthy();
  });

  test('is gone with the run', async () => {
    await db.insert(schema.testRuns).values({ id: 13, projectId: 1, status: 'running', startTime: new Date() });
    const { ask, send } = inspecting(true, 13);
    const data = new TextEncoder().encode(JSON.stringify({ html: ['HTML', {}] }));
    expect(await send(liveSnapshotHeader(ID, header('call@1', 'before'), 'pays'), data)).toBeNull();
    liveViewRelay.endRun(13);
    expect(await refusal(page, ask({ call: 'call@1', phase: 'before' }))).toBe(410);
  });
});
