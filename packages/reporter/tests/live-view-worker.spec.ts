import type * as http from 'node:http';
import type { Page, WorkerInfo } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LIVE_VIEW_ENV,
  formatLiveViewEnv,
  readWorkerToInstance,
  type WorkerToInstance,
} from '@piwitests/core/live-view';
import {
  closeLiveView,
  liveViewPage,
  liveViewStopped,
  liveViewTestBegan,
  liveViewTestEnded,
  openLiveView,
} from '../src/internal/capture/live-view.js';
import { jsonRes, startServer, type FakeServer } from './_helpers.js';

/**
 * The worker's side of the instance's live view, against a fake instance and a fake page: a stop the capture fixtures
 * show (`showStop` calls `liveViewStopped`) goes out as it starts and as it ends, the secrets of its call hidden; so
 * are the calls of the frames, each frame naming its test; someone who watches while no test runs hears why no image
 * shows; and the key is out of the worker's environment while its connection is open.
 */

const KEY = `pdl_${'k'.repeat(43)}`;
const RUN = 9;
const worker = { workerIndex: 0, config: { shard: null } } as unknown as Pick<WorkerInfo, 'workerIndex' | 'config'>;

let server: FakeServer;
let posts: WorkerToInstance[];
let streams: http.ServerResponse[];

beforeEach(async () => {
  posts = [];
  streams = [];
  server = await startServer((req, res) => {
    if (!req.url.startsWith(`/api/test-runs/${RUN}/live-view`)) return jsonRes(res, 404, {});
    if (req.headers.authorization !== `Bearer ${KEY}`) return jsonRes(res, 401, {});
    if (req.method === 'GET') {
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

/** Open the worker's connection to the fake instance, and wait for its stream. */
async function open(env: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  env[LIVE_VIEW_ENV] = formatLiveViewEnv(server.url, RUN, KEY);
  expect(openLiveView(worker, env)).toBe(true);
  await waitFor(() => streams.length === 1);
  return env;
}

function sayViewers(count: number): void {
  streams[0]!.write(`data: ${JSON.stringify({ type: 'viewers', count })}\n\n`);
}

/** A page as the view reads it: its viewport, and a screencast that paints when told. */
function fakePage(): { page: Page; paint: (data: string) => void } {
  let onFrame: ((frame: { data: Buffer; viewportWidth: number; viewportHeight: number }) => unknown) | null = null;
  const page = {
    viewportSize: () => ({ width: 1280, height: 720 }),
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
    expect(framed).toEqual({
      type: 'frame',
      shard: null,
      worker: 0,
      data: Buffer.from('a frame of the page').toString('base64'),
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
