import type * as http from 'node:http';
import type { Page, WorkerInfo } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_SHARE_MISSING,
  LIVE_SHARE_UNKNOWN,
  LIVE_VIEW_ENV,
  formatLiveViewEnv,
  formatLiveViewMissing,
  readWorkerToInstance,
  type WorkerToInstance,
} from '@piwitests/core/live-view';
import {
  closeLiveView,
  liveViewPage,
  liveViewState,
  liveViewStopped,
  liveViewTestBegan,
  liveViewTestEnded,
  onLiveViewChange,
  openLiveView,
  shareLiveView,
} from '../src/internal/capture/live-view.js';
import { jsonRes, startServer, type FakeServer } from './_helpers.js';

/**
 * The worker's side of the instance's live view, against a fake instance and a fake page: a stop the capture fixtures
 * show (`showStop` calls `liveViewStopped`) goes out as it starts and as it ends, the secrets of its call hidden; so
 * are the calls of the frames, each frame naming its test; someone who watches while no test runs hears why no image
 * shows; and the key is out of the worker's environment while its connection is open. Outside CI, the worker holds
 * the key and sends nothing until the run is shared (Share live): then it opens its stream, with the stop it holds,
 * and as the sharing stops it tells the viewers why and closes it; a run without a key says why it cannot be shared.
 */

const KEY = `pdl_${'k'.repeat(43)}`;
const RUN = 9;
const worker = { workerIndex: 0, config: { shard: null } } as unknown as Pick<WorkerInfo, 'workerIndex' | 'config'>;

let server: FakeServer;
let posts: WorkerToInstance[];
let streams: http.ServerResponse[];
/** What the instance answers a stream: 200, or a refusal. */
let streamStatus = 200;
/** Whether a worker's new stream closes the one it held, as the instance's relay does. */
let replaceStreams = false;

beforeEach(async () => {
  posts = [];
  streams = [];
  streamStatus = 200;
  replaceStreams = false;
  server = await startServer((req, res) => {
    if (!req.url.startsWith(`/api/test-runs/${RUN}/live-view`)) return jsonRes(res, 404, {});
    if (req.method === 'GET' && streamStatus !== 200) return jsonRes(res, streamStatus, {});
    if (req.headers.authorization !== `Bearer ${KEY}`) return jsonRes(res, 401, {});
    if (req.method === 'GET') {
      if (replaceStreams) for (const earlier of streams) earlier.end();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'viewers', count: 0 })}\n\n`);
      streams.push(res);
      return;
    }
    const message = readWorkerToInstance(JSON.parse(req.body));
    if (typeof message !== 'string') posts.push(message);
    jsonRes(res, 200, { success: true });
  });
});

afterEach(async () => {
  closeLiveView();
  for (const stream of streams) stream.end();
  await server.close();
});

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Open the worker's connection to the fake instance, as a CI run's worker does, and wait for its stream. */
async function open(env: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  env[LIVE_VIEW_ENV] = formatLiveViewEnv(server.url, RUN, KEY);
  expect(openLiveView(worker, env, true)).toBe(true);
  await waitFor(() => streams.length === 1);
  return env;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sayViewers(count: number): void {
  streams[0]!.write(`data: ${JSON.stringify({ type: 'viewers', count })}\n\n`);
}

/** A page as the view reads it: its viewport, and a screencast that paints when told. */
function fakePage(): { page: Page; paint: (data: string) => void } {
  let onFrame: ((frame: { data: Buffer; viewportWidth: number; viewportHeight: number }) => unknown) | null = null;
  // One frame, which shows no secret field.
  const fields = { or: () => fields, evaluateAll: async () => ({ rects: [], width: 1280, height: 720 }) };
  const frame = { locator: () => fields, isDetached: () => false };
  const page = {
    viewportSize: () => ({ width: 1280, height: 720 }),
    frames: () => [frame],
    mainFrame: () => frame,
    isClosed: () => false,
    once: () => page,
    off: () => page,
    screenshot: async () => Buffer.from('shot'),
    screencast: {
      start: async (options: { onFrame: typeof onFrame }) => {
        onFrame = options.onFrame;
        return { dispose: async () => void (onFrame = null) };
      },
    },
  };
  return {
    page: page as unknown as Page,
    paint: (data) => void onFrame?.({ data: Buffer.from(data), viewportWidth: 1280, viewportHeight: 720 }),
  };
}

const SECRET_CALL = { title: 'Navigate to "/reset?token=abc123def456"', file: 'tests/a.spec.ts', line: 4 };
const HIDDEN_CALL = { ...SECRET_CALL, title: 'Navigate to "/reset?token=<hidden>"' };

describe("the worker's live view connection", () => {
  it('posts a stop as it starts and as it ends, the secrets of its call hidden', async () => {
    await open();
    const goneOn = liveViewStopped({ reason: 'breakpoint', call: SECRET_CALL, test: 'pays' });
    goneOn();
    await waitFor(() => posts.length === 2);
    expect(posts).toEqual([
      { type: 'stop', shard: null, worker: 0, stop: { reason: 'breakpoint', call: HIDDEN_CALL, test: 'pays' } },
      { type: 'stop', shard: null, worker: 0, stop: null },
    ]);
  });

  it('posts the stop its test holds again on a stream it opens again', async () => {
    await open();
    const goneOn = liveViewStopped({ reason: 'page-pause', call: SECRET_CALL, test: 'pays' });
    await waitFor(() => posts.length === 1);
    // The instance restarts, or a proxy drops the stream: the worker opens it again a second later.
    streams[0]!.destroy();
    await waitFor(() => streams.length === 2 && posts.length === 2);
    expect(posts[1]).toEqual(posts[0]);
    goneOn();
    await waitFor(() => posts.length === 3);
    expect(posts[2]).toEqual({ type: 'stop', shard: null, worker: 0, stop: null });
  });

  it('names its test on each frame, the secrets of its call hidden, and says why none shows between tests', async () => {
    await open();
    sayViewers(1);
    await waitFor(() => posts.length === 1);
    expect(posts[0]).toEqual({
      type: 'frame',
      shard: null,
      worker: 0,
      refused: expect.stringMatching(/^No test runs on this worker now/),
    });

    liveViewTestBegan('pays', () => SECRET_CALL);
    const { page, paint } = fakePage();
    liveViewPage(page);
    // The page paints once its screencast started.
    await waitFor(() => {
      paint('a frame of the page');
      return posts.some((p) => p.type === 'frame' && 'data' in p);
    });
    const framed = posts.find((p) => p.type === 'frame' && 'data' in p);
    // No read of the secret fields came before the first frame: an image taken between two reads goes in its place.
    expect(framed).toEqual({
      type: 'frame',
      shard: null,
      worker: 0,
      data: Buffer.from('shot').toString('base64'),
      call: HIDDEN_CALL,
      test: 'pays',
    });

    await liveViewTestEnded();
    await waitFor(() => posts.some((p) => p.type === 'ended'));
    // A second viewer between two tests hears it too.
    sayViewers(2);
    await waitFor(() => posts.filter((p) => p.type === 'frame' && 'refused' in p).length === 2);
  });

  it('keeps the key out of the environment it was read from until the connection closes', async () => {
    const env = await open({ OTHER: 'kept' });
    expect(env[LIVE_VIEW_ENV]).toBeUndefined();
    expect(env.OTHER).toBe('kept');
    closeLiveView();
    expect(env[LIVE_VIEW_ENV]).toBe(formatLiveViewEnv(server.url, RUN, KEY));
  });
});

describe('Share live, in a run outside CI', () => {
  const STOP = { reason: 'breakpoint' as const, call: SECRET_CALL, test: 'pays' };

  /** Open the worker's connection as a run outside CI does: it holds the key and opens nothing. */
  function openHere(): void {
    expect(openLiveView(worker, { [LIVE_VIEW_ENV]: formatLiveViewEnv(server.url, RUN, KEY) }, false)).toBe(true);
  }

  it('holds the key and sends nothing until the run is shared, its stop included', async () => {
    openHere();
    const goneOn = liveViewStopped(STOP);
    await sleep(300);
    expect(server.requests).toEqual([]);
    expect(liveViewState()).toEqual({
      can: true,
      on: false,
      viewers: 0,
      page: `${server.url}/test-runs/${RUN}`,
      why: null,
    });
    goneOn();
    await sleep(100);
    expect(server.requests).toEqual([]);
  });

  it('opens its stream once shared, with the stop it holds, counts the viewers, and closes it as the sharing stops', async () => {
    openHere();
    const heard: string[] = [];
    const unhear = onLiveViewChange(() => heard.push(JSON.stringify(liveViewState())));
    const goneOn = liveViewStopped(STOP);
    await shareLiveView(true);
    await waitFor(() => streams.length === 1 && posts.length === 1);
    expect(posts[0]).toEqual({ type: 'stop', shard: null, worker: 0, stop: { ...STOP, call: HIDDEN_CALL } });
    expect(liveViewState()).toMatchObject({ can: true, on: true, viewers: 0 });
    sayViewers(2);
    await waitFor(() => liveViewState().viewers === 2);
    // Shared twice, it is shared once.
    await shareLiveView(true);
    expect(streams).toHaveLength(1);

    await shareLiveView(false);
    expect(posts[posts.length - 1]).toEqual({ type: 'unshared', shard: null, worker: 0 });
    await waitFor(() => streams[0]!.destroyed || streams[0]!.writableEnded || streams[0]!.closed);
    expect(liveViewState()).toMatchObject({ can: true, on: false, viewers: 0 });
    // Nothing more goes once the sharing stopped: the stop's end neither.
    const sent = server.requests.length;
    goneOn();
    await sleep(200);
    expect(server.requests.length).toBe(sent);
    expect(heard.map((h) => JSON.parse(h) as { on: boolean; viewers: number })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ on: true, viewers: 0 }),
        expect.objectContaining({ on: true, viewers: 2 }),
        expect.objectContaining({ on: false, viewers: 0 }),
      ]),
    );
    unhear();

    // Shared again, it opens a stream again.
    await shareLiveView(true);
    await waitFor(() => streams.length === 2);
  });

  it('says why a run without a key cannot be shared, and shares nothing for it', async () => {
    expect(openLiveView(worker, { [LIVE_VIEW_ENV]: formatLiveViewMissing('off') }, false)).toBe(false);
    expect(liveViewState()).toEqual({ can: false, on: false, viewers: 0, page: null, why: LIVE_SHARE_MISSING.off });
    await shareLiveView(true);
    closeLiveView();
    expect(openLiveView(worker, {}, false)).toBe(false);
    expect(liveViewState()).toMatchObject({ can: false, why: LIVE_SHARE_UNKNOWN });
    await sleep(100);
    expect(server.requests).toEqual([]);
  });

  it('stopped and shared again at once, holds one stream, and tries nothing again for the one it replaced', async () => {
    replaceStreams = true;
    openHere();
    await shareLiveView(true);
    await waitFor(() => streams.length === 1);
    const off = shareLiveView(false);
    const on = shareLiveView(true);
    await off;
    await on;
    await waitFor(() => streams.length === 2);
    // Past the first retries' waits: no stream more opens, and the one the worker holds stays open.
    await sleep(3500);
    expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(2);
    expect(streams[1]!.writableEnded).toBe(false);
    expect(liveViewState()).toMatchObject({ can: true, on: true });
  }, 10_000);

  it('gives up a stream the instance holds as interrupted after the retries, saying so', async () => {
    streamStatus = 409;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      openHere();
      await shareLiveView(true);
      const gets = () => server.requests.filter((request) => request.method === 'GET').length;
      for (let tried = 1; liveViewState().on && tried <= 10; tried++) {
        const start = Date.now();
        while (gets() < tried && Date.now() - start < 5000) await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(16_000);
      }
      expect(liveViewState()).toEqual({
        can: true,
        on: false,
        viewers: 0,
        page: `${server.url}/test-runs/${RUN}`,
        why: expect.stringMatching(/^Sharing stopped: the instance holds the run as interrupted/),
      });
      expect(gets()).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cannot be shared once the instance refused its key, and says why', async () => {
    streamStatus = 404;
    openHere();
    await shareLiveView(true);
    await waitFor(() => !liveViewState().can);
    expect(liveViewState()).toMatchObject({ can: false, on: false, why: expect.stringMatching(/turned off/) });
    const asked = server.requests.length;
    await shareLiveView(true);
    await sleep(200);
    expect(server.requests.length).toBe(asked);
  });
});
