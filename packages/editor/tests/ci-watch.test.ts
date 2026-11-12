import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import {
  LIVE_HEARTBEAT,
  LIVE_STREAM_TYPE,
  encodeLiveMessage,
  encodeLiveViewerMessage,
  type LiveViewerMessage,
} from '@piwitests/core/live-view';
import { CI_WATCH_SIZE, CiWatch, type CiWatchTarget } from '../src/ci-watch';
import { PiwiClient } from '../src/piwi-client';
import type { CiFrame, CiLayer, CiSession } from '../src/protocol';

const ROOT = '/work/shop';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const OTHER_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const WATCH_ID = 'w4tch-1d-0f-the-1nstance';
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const pause = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(read: () => T | undefined | false, ms = 2_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await pause(5);
  }
}

/** A watch the stub instance holds open: the request that opened it, and the stream to write live messages to. */
interface Opened {
  url: URL;
  headers: http.IncomingHttpHeaders;
  write: (header: Record<string, unknown>, data?: Uint8Array) => Promise<void>;
  heartbeat: () => void;
  close: () => void;
  closed: boolean;
}

/**
 * A stub instance serving the binary watch of run 78: each GET opens a stream of live messages, `hello` first, unless
 * `refuse` answers it; a POST is kept and answered with `changeStatus`.
 */
function stubInstance() {
  const opened: Opened[] = [];
  const posts: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  /** The watches the stub held without answering, and whether each request closed. */
  const held: Array<{ closed: boolean }> = [];
  const state = {
    refuse: null as { status: number; body: unknown; type?: string } | null,
    /** The next watches get no answer, not even their headers. */
    hold: false,
    changeStatus: 200,
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://stub');
    if (url.pathname !== '/api/test-runs/78/live-view/watch') {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'POST') {
      let text = '';
      req.on('data', (chunk: Buffer) => (text += chunk.toString()));
      req.on('end', () => {
        posts.push({ headers: req.headers, body: JSON.parse(text) as Record<string, unknown> });
        res.writeHead(state.changeStatus, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(state.changeStatus === 200 ? { success: true } : { message: 'No such watch of this run' }),
        );
      });
      return;
    }
    if (state.hold) {
      const entry = { closed: false };
      req.on('close', () => (entry.closed = true));
      held.push(entry);
      return;
    }
    if (state.refuse) {
      res.writeHead(state.refuse.status, { 'Content-Type': state.refuse.type ?? 'application/json' });
      res.end(typeof state.refuse.body === 'string' ? state.refuse.body : JSON.stringify(state.refuse.body));
      return;
    }
    res.writeHead(200, { 'Content-Type': LIVE_STREAM_TYPE, 'Cache-Control': 'no-store' });
    const entry: Opened = {
      url,
      headers: req.headers,
      write: async (header, data) => {
        res.write(data ? encodeLiveMessage(header, data) : encodeLiveViewerMessage(header as LiveViewerMessage));
        await pause();
      },
      heartbeat: () => res.write(LIVE_HEARTBEAT),
      close: () => res.end(),
      closed: false,
    };
    req.on('close', () => (entry.closed = true));
    res.write(encodeLiveMessage({ type: 'hello', watch: WATCH_ID }));
    opened.push(entry);
  });
  return { server, opened, posts, held, state };
}

describe('watching a CI run’s lane on the instance', () => {
  let stub: ReturnType<typeof stubInstance> | null = null;
  let watch: CiWatch | null = null;

  afterEach(async () => {
    watch?.dispose();
    watch = null;
    if (stub) {
      stub.server.closeAllConnections();
      await new Promise((r) => stub!.server.close(r));
    }
    stub = null;
  });

  /** A watch of the stub's run 78 through the CI sessions' target, with its lanes' workers (`lane` → worker). */
  async function start(
    options: { watchable?: boolean; idleMs?: number; openMs?: number; workers?: Record<number, number> } = {},
  ) {
    stub = stubInstance();
    await new Promise<void>((r) => stub!.server.listen(0, '127.0.0.1', r));
    const port = (stub.server.address() as AddressInfo).port;
    const client = new PiwiClient({ serverUrl: `http://127.0.0.1:${port}`, apiKey: 'pd_key', project: 'Shop' });
    const workers = options.workers ?? { 2: 4, 1: 3 };
    const frames: CiFrame[] = [];
    /** Why the last thing the client heard ended the watch; undefined for anything else. */
    const ended = () => {
      const last = frames[frames.length - 1];
      return last && 'ended' in last ? last.ended : undefined;
    };
    const asked: Array<[string | undefined, number, number | null, number]> = [];
    const layers: CiLayer[] = [];
    watch = new CiWatch({
      target: (root, runId, shard, lane): CiWatchTarget | null => {
        asked.push([root, runId, shard, lane]);
        if (runId !== 78) return null;
        return { root: ROOT, client, watchable: options.watchable ?? true, worker: workers[lane] ?? null };
      },
      send: async (frame) => {
        frames.push(frame);
      },
      sendLayer: async (layer) => {
        layers.push(layer);
      },
      idleMs: options.idleMs,
      openMs: options.openMs,
      textMs: 40,
    });
    return { frames, layers, ended, asked, stub: stub!, watch: watch! };
  }

  const lane2 = { root: ROOT, runId: 78, shard: null, lane: 2 };

  test('opens the lane’s view with the editor’s key at the panels’ size, and passes on its images alone', async () => {
    const { frames, stub, watch } = await start();
    expect(await watch.watch({ ...lane2, on: true })).toEqual({
      ok: true,
      message: 'You watch worker 2 of CI run #78.',
    });
    const open = stub.opened[0]!;
    expect(open.headers['x-api-key']).toBe('pd_key');
    expect(open.headers.accept).toBe(LIVE_STREAM_TYPE);
    // The lane's worker in full, by its lane (Playwright's parallel index), at the size the editors' panels show it.
    expect(Object.fromEntries(open.url.searchParams)).toEqual({
      worker: '4',
      slot: '1',
      width: String(CI_WATCH_SIZE.width),
      height: String(CI_WATCH_SIZE.height),
    });

    const call = { title: "Click getByRole('button', { name: 'Pay' })", file: 'tests/checkout.spec.ts', line: 9 };
    await open.write({ type: 'frame', shard: null, worker: 4, slot: 1, call, test: 'checkout › pays' }, JPEG);
    open.heartbeat();
    // Another lane's image, the call log and a test's outcome are not shown.
    await open.write({ type: 'frame', shard: null, worker: 3, slot: 0, call: null, test: 'cart' }, OTHER_JPEG);
    await open.write({
      type: 'call-log',
      shard: null,
      worker: 4,
      slot: 1,
      test: 'checkout › pays',
      log: { id: 'c1', call, status: 'running', lines: ['waiting for getByRole'], point: null, target: null },
    });
    await open.write({ type: 'test-ended', shard: null, worker: 4, slot: 1, outcome: null });
    await open.write({ type: 'refused', shard: null, worker: 4, slot: 1, message: 'The page is closed.' });
    // The worker Playwright starts in the lane after a failure is the lane's too.
    await open.write({ type: 'frame', shard: null, worker: 7, slot: 1, call: null, test: 'checkout › refunds' }, JPEG);
    expect(frames).toEqual([
      { ...lane2, data: base64(JPEG), test: 'checkout › pays', call: call.title },
      { ...lane2, refused: 'The page is closed.' },
      { ...lane2, data: base64(JPEG), test: 'checkout › refunds', call: null },
    ]);

    // The run ends on the instance: the watch's last word, and the stream let go.
    await open.write({ type: 'end', reason: 'run-ended' });
    expect(frames[frames.length - 1]).toEqual({ ...lane2, ended: 'The CI run ended.' });
    await waitFor(() => open.closed);
  });

  test('shows another lane of the run on the same watch, by a POST naming it', async () => {
    const { frames, stub, watch } = await start();
    await watch.watch({ ...lane2, on: true });
    const open = stub.opened[0]!;
    await pause();
    const lane1 = { ...lane2, lane: 1 };
    expect(await watch.watch({ ...lane1, on: true })).toEqual({
      ok: true,
      message: 'You watch worker 1 of CI run #78.',
    });
    expect(stub.opened).toHaveLength(1);
    expect(stub.posts).toEqual([
      {
        headers: expect.objectContaining({ 'x-api-key': 'pd_key', 'content-type': 'application/json' }),
        body: { watch: WATCH_ID, focus: { worker: 3, shard: null, slot: 0 }, ...CI_WATCH_SIZE },
      },
    ]);
    // An image of the lane before that was on its way goes nowhere.
    await open.write({ type: 'frame', shard: null, worker: 4, slot: 1, call: null, test: 'pays' }, JPEG);
    await open.write({ type: 'frame', shard: null, worker: 3, slot: 0, call: null, test: 'cart' }, OTHER_JPEG);
    expect(frames).toEqual([{ ...lane1, data: base64(OTHER_JPEG), test: 'cart', call: null }]);

    // A change the instance refuses ends the watch, the refusal its answer.
    stub.state.changeStatus = 404;
    expect(await watch.watch({ ...lane2, on: true })).toEqual({ ok: false, message: 'No such watch of this run.' });
    await waitFor(() => open.closed);
    expect(frames.some((f) => 'ended' in f)).toBe(false);
  });

  test('passes on the layers the client asked for alone, changes them in place, and asks for the text', async () => {
    const { layers, stub, watch } = await start();
    const at = 1_800_000_000_000;
    await watch.watch({ ...lane2, on: true, layers: ['filmstrip', 'calls', 'events'] });
    const open = stub.opened[0]!;
    // The call log comes with the full view: the instance hears of the others.
    expect(open.url.searchParams.get('layers')).toBe('events,filmstrip');
    const of = { shard: null, worker: 4, slot: 1, test: 'checkout › pays' };
    const call = { title: 'Click', file: null, line: null };
    await open.write({ type: 'call-log', ...of, log: { id: 'c1', call, status: 'running', lines: [], point: null } });
    await open.write({ type: 'page-event', ...of, event: { kind: 'console', text: 'Oops' }, at });
    await open.write({
      type: 'page-event',
      ...of,
      slot: 0,
      worker: 3,
      event: { kind: 'console', text: 'Not this lane' },
      at,
    });
    const thumb = { call: 'c1', title: 'Click', index: 1, width: 320, height: 200, at };
    await open.write({ type: 'thumb', ...of, thumb }, JPEG);
    const text = { call: null, source: 'snapshot', text: '- heading "Shop"', cut: false, at };
    await open.write({ type: 'text', ...of, text });
    const where = { ...lane2, worker: 4, test: 'checkout › pays' };
    expect(layers).toEqual([
      { ...where, layer: 'calls', log: expect.objectContaining({ id: 'c1', status: 'running' }) },
      { ...where, layer: 'events', event: { kind: 'console', text: 'Oops' }, at },
      { ...where, layer: 'filmstrip', thumb, data: base64(JPEG) },
    ]);

    // The layers change on the watch open, and the text is asked for as it is first shown, then as the client asks:
    // an ask within a moment of the last is that one, and the instance hears none.
    expect(await watch.watch({ ...lane2, on: true, layers: ['events'], text: true })).toEqual({
      ok: false,
      message: 'Show the page’s text first.',
    });
    expect(await watch.watch({ ...lane2, on: true, layers: ['events', 'text'] })).toMatchObject({ ok: true });
    const onItsWay = { ok: true, message: 'The page’s text is on its way.' };
    expect(await watch.watch({ ...lane2, on: true, layers: ['events', 'text'], text: true })).toEqual(onItsWay);
    expect(stub.posts.map((post) => post.body)).toEqual([{ watch: WATCH_ID, layers: ['events', 'text'], text: true }]);
    await pause(60);
    const asks = [1, 2].map(() => watch!.watch({ ...lane2, on: true, layers: ['events', 'text'], text: true }));
    expect(await Promise.all(asks)).toEqual([onItsWay, onItsWay]);
    expect(stub.posts.map((post) => post.body).slice(1)).toEqual([{ watch: WATCH_ID, text: true }]);
    await open.write({ type: 'text', ...of, text });
    await open.write({ type: 'thumb', ...of, thumb }, JPEG);
    expect(layers.slice(3)).toEqual([{ ...where, layer: 'text', text }]);

    // A change the instance refuses leaves the watch as it was: the text still comes, and the same change is asked
    // again.
    stub.state.changeStatus = 429;
    expect(await watch.watch({ ...lane2, on: true, layers: ['events'] })).toMatchObject({ ok: false });
    expect(open.closed).toBe(false);
    expect(stub.opened).toHaveLength(1);
    await open.write({ type: 'text', ...of, text });
    expect(layers.slice(4)).toEqual([{ ...where, layer: 'text', text }]);
    expect(await watch.watch({ ...lane2, on: true, layers: ['events'] })).toMatchObject({ ok: false });
    expect(stub.posts.map((post) => post.body).slice(2)).toEqual([
      { watch: WATCH_ID, layers: ['events'] },
      { watch: WATCH_ID, layers: ['events'] },
    ]);
    // A refused ask of the text is answered so, and the next is asked of the instance.
    await pause(60);
    expect(await watch.watch({ ...lane2, on: true, layers: ['events', 'text'], text: true })).toMatchObject({
      ok: false,
    });
    expect(stub.posts).toHaveLength(5);
  });

  test('gives one watch at a time: another run’s takes its place, and stopping says nothing', async () => {
    const { frames, stub, watch } = await start();
    await watch.watch({ ...lane2, on: true });
    await pause();
    // A lane of a run the service does not follow is refused, and the watch before it ends with the ask.
    expect(await watch.watch({ ...lane2, runId: 79, on: true })).toEqual({
      ok: false,
      message: 'The editor follows no CI run #79 now: it ended, or the editor reads another branch.',
    });
    await waitFor(() => stub.opened[0]!.closed);

    await watch.watch({ ...lane2, on: true });
    await waitFor(() => stub.opened[1]);
    // Off for another lane leaves it be; off for its own ends it, with no word to the client.
    await watch.watch({ ...lane2, lane: 1, on: false });
    await pause();
    expect(stub.opened[1]!.closed).toBe(false);
    expect(await watch.watch({ ...lane2, on: false })).toEqual({
      ok: true,
      message: 'You no longer watch the CI run’s worker.',
    });
    await waitFor(() => stub.opened[1]!.closed);
    expect(frames).toEqual([]);
  });

  test('refuses before asking the instance a lane no test ran in, or one it does not name', async () => {
    const { stub, watch, asked } = await start({ workers: {} });
    expect(await watch.watch({ ...lane2, on: true })).toEqual({
      ok: false,
      message: 'No test ran in this worker’s lane yet.',
    });
    expect(await watch.watch({ ...lane2, lane: 0, on: true })).toMatchObject({ ok: false });
    expect(await watch.watch({ ...lane2, shard: 0, on: true })).toMatchObject({ ok: false });
    expect(asked).toEqual([[ROOT, 78, null, 2]]);
    expect(stub.opened).toEqual([]);
  });

  test('refuses a run whose live view cannot be watched', async () => {
    const { stub, watch } = await start({ watchable: false });
    expect(await watch.watch({ ...lane2, on: true })).toEqual({
      ok: false,
      message: 'This CI run cannot be watched: its project’s live view is off, or the run holds no key.',
    });
    expect(stub.opened).toEqual([]);
  });

  test('passes on why the instance would not open the watch', async () => {
    const { stub, watch } = await start();
    stub.state.refuse = { status: 404, body: { statusCode: 404, message: 'The live view is off for this project' } };
    expect(await watch.watch({ ...lane2, on: true })).toEqual({
      ok: false,
      message: 'The live view is off for this project.',
    });
    stub.state.refuse = { status: 429, body: 'busy', type: 'text/plain' };
    expect(await watch.watch({ ...lane2, on: true })).toEqual({
      ok: false,
      message: 'Too many people watch this run now: try again in a moment.',
    });
    // An instance whose watch is not a stream of live messages: the dashboard watches it.
    stub.state.refuse = { status: 200, body: 'data: {}\n\n', type: 'text/event-stream' };
    expect(await watch.watch({ ...lane2, on: true })).toEqual({
      ok: false,
      message: 'This instance’s live view is not one the editor reads: watch the test on the dashboard.',
    });
  });

  test('refuses a watch the instance does not answer in time, and lets its request go', async () => {
    const { stub, watch } = await start({ openMs: 150 });
    stub.state.hold = true;
    const asked = Date.now();
    expect(await watch.watch({ ...lane2, on: true })).toEqual({
      ok: false,
      message: 'The instance did not open the watch in time: try again in a moment.',
    });
    expect(Date.now() - asked).toBeLessThan(1_000);
    await waitFor(() => stub.held[0]?.closed);

    // Off while the instance has not answered lets the request go at once.
    const late = watch.watch({ ...lane2, on: true });
    await waitFor(() => stub.held[1]);
    await watch.watch({ ...lane2, on: false });
    expect(await late).toEqual({ ok: false, message: 'Another CI watch took the place of this one.' });
    await waitFor(() => stub.held[1]!.closed);
  });

  test('ends saying why: the session ends, the instance closes it, ends its view or stops answering', async () => {
    const { frames, ended, stub, watch } = await start({ idleMs: 150 });
    const session = (status: string): CiSession =>
      ({ ...lane2, ended: true, progress: { status } }) as unknown as CiSession;

    await watch.watch({ ...lane2, on: true });
    watch.sessionChanged({ ...session('passed'), ended: false });
    watch.sessionChanged(session('passed'));
    expect(frames[frames.length - 1]).toEqual({ ...lane2, ended: 'The CI run ended.' });
    await waitFor(() => stub.opened[0]!.closed);

    await watch.watch({ ...lane2, on: true });
    watch.sessionChanged(session('running'));
    expect(ended()).toContain('follows this CI run no more');

    await watch.watch({ ...lane2, on: true });
    await pause();
    stub.opened[2]!.close();
    await waitFor(() => ended() === 'The instance closed the watch.');

    await watch.watch({ ...lane2, on: true });
    await stub.opened[3]!.write({ type: 'end', shard: null, worker: 4, slot: 1, reason: 'worker-left' });
    expect(frames[frames.length - 1]).toEqual({ ...lane2, ended: 'No worker runs in this lane any more.' });

    await watch.watch({ ...lane2, on: true });
    await waitFor(() => ended() === 'The instance stopped answering.');
    await waitFor(() => stub.opened[4]!.closed);
    expect(frames.filter((f) => 'ended' in f)).toHaveLength(5);
  });
});
