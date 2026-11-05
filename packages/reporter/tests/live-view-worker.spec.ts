import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Page, WorkerInfo } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_SHARE_MISSING,
  LIVE_SHARE_UNKNOWN,
  LIVE_VIEW_ENV,
  formatLiveViewEnv,
  formatLiveViewMissing,
  liveShareRefusal,
  readWorkerToInstance,
  type WorkerToInstance,
} from '@piwitests/core/live-view';
import { PIWI_RUN_LOG_ENV } from '../src/internal/config/env.js';
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
 * A CI run's worker opens its stream again while the run lasts, through an outage, an instance started again and a
 * stream cut at a fixed age, the run's log saying once that its view is lost and once that it is back; a run shared
 * from a developer's machine may be shared again after the instance took no key, never after it refused it for good.
 */

const KEY = `pdl_${'k'.repeat(43)}`;
const RUN = 9;
const worker = { workerIndex: 0, config: { shard: null } } as unknown as Pick<WorkerInfo, 'workerIndex' | 'config'>;

let server: FakeServer;
let posts: WorkerToInstance[];
let streams: http.ServerResponse[];
/** The address of each stream a worker opened. */
let streamUrls: string[];
/** What the instance answers a stream: 200, or a refusal. */
let streamStatus = 200;
/** Whether a worker's new stream closes the one it held, as the instance's relay does. */
let replaceStreams = false;

beforeEach(async () => {
  posts = [];
  streams = [];
  streamUrls = [];
  streamStatus = 200;
  replaceStreams = false;
  server = await startServer((req, res) => {
    if (!req.url.startsWith(`/api/test-runs/${RUN}/live-view`)) return jsonRes(res, 404, {});
    if (req.method === 'GET' && streamStatus !== 200) return jsonRes(res, streamStatus, {});
    if (req.headers.authorization !== `Bearer ${KEY}`) return jsonRes(res, 401, {});
    if (req.method === 'GET') {
      streamUrls.push(req.url);
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

/** Wait for `check` without timers, which a test fakes: the worker's requests and their answers go on meanwhile. */
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** How many times a worker opened its stream, answered or not. */
const gets = (): number => server.requests.filter((request) => request.method === 'GET').length;

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
  it('names its lane on its stream and in each message, and says how its test ended', async () => {
    const env: NodeJS.ProcessEnv = { [LIVE_VIEW_ENV]: formatLiveViewEnv(server.url, RUN, KEY) };
    const laneWorker = { ...worker, workerIndex: 3, parallelIndex: 1 } as Parameters<typeof openLiveView>[0];
    expect(openLiveView(laneWorker, env, true)).toBe(true);
    await waitFor(() => streams.length === 1);
    expect(new URL(streamUrls[0]!, server.url).searchParams.get('slot')).toBe('1');
    sayViewers(1);
    // The viewer between two tests hears why no image shows: the worker read that someone watches.
    await waitFor(() => posts.length === 1);
    expect(posts[0]).toMatchObject({ type: 'frame', worker: 3, slot: 1 });
    liveViewTestBegan('pays', () => null);
    await liveViewTestEnded('failed');
    await waitFor(() => posts.some((p) => p.type === 'ended'));
    expect(posts.find((p) => p.type === 'ended')).toEqual({
      type: 'ended',
      shard: null,
      worker: 3,
      slot: 1,
      outcome: { test: 'pays', status: 'failed', ms: expect.any(Number) },
    });
  });

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
    // It says when the page looked so, in the worker's clock.
    expect(framed).toEqual({
      type: 'frame',
      shard: null,
      worker: 0,
      data: Buffer.from('shot').toString('base64'),
      call: HIDDEN_CALL,
      test: 'pays',
      at: expect.any(Number),
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

describe("a CI run's live view, as the instance stops answering and answers again", () => {
  const laneWorker = { ...worker, parallelIndex: 1 } as Parameters<typeof openLiveView>[0];
  let logDir: string;
  /** The file the run's log reads the worker's lines from, as the global setup names it. */
  let runLog: string;
  const logLines = (): string[] =>
    fs.existsSync(runLog) ? fs.readFileSync(runLog, 'utf8').split('\n').filter(Boolean) : [];

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-live-log-'));
    runLog = path.join(logDir, 'run.log');
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  /** Open the worker's connection as a CI run's worker does, its lines going to the run's log; wait for its stream. */
  async function openInCi(): Promise<void> {
    const env = { [LIVE_VIEW_ENV]: formatLiveViewEnv(server.url, RUN, KEY), [PIWI_RUN_LOG_ENV]: runLog };
    expect(openLiveView(laneWorker, env, true)).toBe(true);
    await waitFor(() => streams.length === 1);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  }

  /** The instance closes the worker's stream: the worker waits to open it again. */
  async function cut(stream: http.ServerResponse): Promise<void> {
    stream.end();
    await until(() => vi.getTimerCount() === 1);
  }

  it('comes back after the instance answered 503 for 40 s, its log saying once it was lost and once it is back', async () => {
    await openInCi();
    streamStatus = 503;
    await cut(streams[0]!);
    // Tried again after 1, 2, 4, 8 and 16 s, each answered 503: then every 30 to 60 s, the log saying it once.
    for (const [tried, wait] of [1000, 2000, 4000, 8000, 16_000].entries()) {
      await vi.advanceTimersByTimeAsync(wait);
      await until(() => gets() === tried + 2 && vi.getTimerCount() === 1);
    }
    await until(() => logLines().length === 1);
    expect(logLines()).toEqual([
      'Worker 2: live view lost: the instance answered 503. Trying again every 30 to 60 s while the run lasts.',
    ]);
    // 40 s into the outage, the instance answers again; nothing was tried meanwhile.
    await vi.advanceTimersByTimeAsync(9000);
    expect(gets()).toBe(6);
    streamStatus = 200;
    await vi.advanceTimersByTimeAsync(51_000);
    await until(() => streams.length === 2);
    expect(gets()).toBe(7);
    // Back once the stream it opened again has stayed open 30 s.
    expect(logLines()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => logLines().length === 2);
    expect(logLines()[1]).toBe('Worker 2: live view back.');
    expect(liveViewState()).toMatchObject({ can: true, on: true });
    // It hears its viewers on the stream it opened again.
    streams[1]!.write(`data: ${JSON.stringify({ type: 'viewers', count: 1 })}\n\n`);
    await until(() => liveViewState().viewers === 1);
  });

  it('tries again after an instance started again did not take its key, and comes back once one takes it', async () => {
    await openInCi();
    streamStatus = 401;
    await cut(streams[0]!);
    await vi.advanceTimersByTimeAsync(1000);
    // A key the instance does not take skips the quick retries.
    await until(() => logLines().length === 1 && vi.getTimerCount() === 1);
    expect(logLines()).toEqual([
      "Worker 2: live view lost: the instance does not take the run's live view key now. Trying again every 30 to 60 s while the run lasts.",
    ]);
    expect(gets()).toBe(2);
    expect(liveViewState()).toMatchObject({ can: true });
    await vi.advanceTimersByTimeAsync(60_000);
    await until(() => gets() === 3 && vi.getTimerCount() === 1);
    expect(logLines()).toHaveLength(1);
    streamStatus = 200;
    await vi.advanceTimersByTimeAsync(60_000);
    await until(() => streams.length === 2);
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => logLines().length === 2);
    expect(logLines()[1]).toBe('Worker 2: live view back.');
  });

  it('says once that its view is lost while the instance cuts each stream it opens again before 30 s', async () => {
    await openInCi();
    streamStatus = 503;
    await cut(streams[0]!);
    for (const wait of [1000, 2000, 4000, 8000, 16_000]) await vi.advanceTimersByTimeAsync(wait);
    await until(() => logLines().length === 1 && vi.getTimerCount() === 1);
    streamStatus = 200;
    // Each stream it opens again is cut after 20 s: no stream stays open long enough to say the view is back.
    for (let opened = 2; opened <= 4; opened++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await until(() => streams.length === opened);
      await vi.advanceTimersByTimeAsync(20_000);
      await cut(streams[opened - 1]!);
    }
    expect(logLines()).toHaveLength(1);
    // One stays open: the view is back, said once.
    await vi.advanceTimersByTimeAsync(60_000);
    await until(() => streams.length === 5);
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => logLines().length === 2);
    expect(logLines()[1]).toBe('Worker 2: live view back.');
  }, 30_000);

  it('opens a stream the instance cuts at a fixed age again each time, however often, the log saying nothing', async () => {
    await openInCi();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    for (let cuts = 1; cuts <= 25; cuts++) {
      await vi.advanceTimersByTimeAsync(31_000);
      await cut(streams[cuts - 1]!);
      await vi.advanceTimersByTimeAsync(1000);
      await until(() => streams.length === cuts + 1);
    }
    expect(gets()).toBe(26);
    expect(logLines()).toEqual([]);
  }, 30_000);

  it('gives up for good a run the instance no longer holds live, saying so once', async () => {
    await openInCi();
    streamStatus = 410;
    await cut(streams[0]!);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => logLines().length === 1);
    expect(logLines()).toEqual([
      'Worker 2: live view lost: the run is no longer live on the instance. It stays off for this worker.',
    ]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(gets()).toBe(2);
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

  it('may be shared again once the instance took no key, the live view off or the instance started again', async () => {
    streamStatus = 404;
    openHere();
    await shareLiveView(true);
    await waitFor(() => !liveViewState().on);
    expect(liveViewState()).toMatchObject({ can: true, on: false, why: liveShareRefusal(404) });
    expect(gets()).toBe(1);
    // Shared again while the instance does not take the key: it says so, and may be shared again.
    streamStatus = 401;
    await shareLiveView(true);
    await waitFor(() => gets() === 2 && !liveViewState().on);
    expect(liveViewState()).toMatchObject({ can: true, on: false, why: liveShareRefusal(401) });
    // Shared again once the instance takes it: it streams.
    streamStatus = 200;
    await shareLiveView(true);
    await waitFor(() => streams.length === 1);
    expect(liveViewState()).toEqual({
      can: true,
      on: true,
      viewers: 0,
      page: `${server.url}/test-runs/${RUN}`,
      why: null,
    });
  });

  it('cannot be shared once the instance refused its key for good, and says why', async () => {
    streamStatus = 410;
    openHere();
    await shareLiveView(true);
    await waitFor(() => !liveViewState().can);
    expect(liveViewState()).toMatchObject({ can: false, on: false, why: liveShareRefusal(410) });
    const asked = server.requests.length;
    await shareLiveView(true);
    await sleep(200);
    expect(server.requests.length).toBe(asked);
  });
});
