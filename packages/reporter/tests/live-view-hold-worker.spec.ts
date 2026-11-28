import type * as http from 'node:http';
import type { WorkerInfo } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LIVE_VIEW_ENV,
  formatLiveViewEnv,
  readWorkerToInstance,
  type LiveStop,
  type WorkerToInstance,
} from '@piwitests/core/live-view';
import {
  closeLiveView,
  liveViewHold,
  liveViewStopped,
  liveViewTestBegan,
  liveViewTestEnded,
  openLiveView,
  type LiveHold,
} from '../src/internal/capture/live-view.js';
import { jsonRes, startServer, type FakeServer } from './_helpers.js';

/**
 * A CI worker's hold of a failing test against a fake instance, between the hold's start and its end: it ends as the
 * stream that opens again is answered that the run's live view is not there now (the project's live view off, the run
 * not live), as the setting turns off, and as the last controller leaves while a Viewer still watches in full; a drop
 * and a reopen keep it; and a new length applies to it, its held stop posted again with its new end.
 */

const KEY = `pdl_${'w'.repeat(43)}`;
const RUN = 51;
const worker = { workerIndex: 0, parallelIndex: 0, config: { shard: null } } as unknown as Pick<
  WorkerInfo,
  'workerIndex' | 'config'
> & { parallelIndex: number };
const LONG_MS = 60_000;
const VIEW = { type: 'view', width: 640, height: 400, fps: 4, full: true, layers: [], inspect: false };

let server: FakeServer;
let streams: http.ServerResponse[];
let posts: WorkerToInstance[];
/** How the instance answers the next stream a worker opens: 200 and the hold's opening, or a refusal. */
let nextStatus: number;
/** What the instance says on each stream as it opens. */
let opening: unknown[];

beforeEach(async () => {
  streams = [];
  posts = [];
  nextStatus = 200;
  opening = [
    { type: 'hold', ms: LONG_MS },
    { ...VIEW, controller: true },
    { type: 'viewers', count: 1 },
  ];
  server = await startServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) return jsonRes(res, 401, {});
    if (req.method === 'GET') {
      if (nextStatus !== 200) return jsonRes(res, nextStatus, {});
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const message of opening) res.write(`data: ${JSON.stringify(message)}\n\n`);
      streams.push(res);
      return;
    }
    if (req.headers['content-type'] === 'application/json') {
      const message = readWorkerToInstance(JSON.parse(req.body));
      if (typeof message !== 'string') posts.push(message);
    }
    jsonRes(res, 200, {});
  });
});

afterEach(async () => {
  await liveViewTestEnded();
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function say(message: unknown): void {
  streams[streams.length - 1]!.write(`data: ${JSON.stringify(message)}\n\n`);
}

/** A CI worker whose test failed while a controller watches it in full: its hold, and whether it ended. */
async function held(): Promise<{ hold: LiveHold; ended: () => boolean }> {
  const env: NodeJS.ProcessEnv = { [LIVE_VIEW_ENV]: formatLiveViewEnv(server.url, RUN, KEY) };
  expect(openLiveView(worker, env, true)).toBe(true);
  await waitFor(() => streams.length === 1);
  liveViewTestBegan('pays', () => null);
  let hold: LiveHold | null = null;
  await waitFor(() => (hold = liveViewHold()) !== null);
  let ended = false;
  void hold!.ended.then(() => (ended = true));
  return { hold: hold!, ended: () => ended };
}

describe('a CI worker’s hold of a failing test', () => {
  for (const status of [404, 409]) {
    it(`ends as the stream that opens again is answered ${status}: the run’s live view is not there now`, async () => {
      const { ended } = await held();
      nextStatus = status;
      streams[0]!.end();
      await waitFor(ended, 4000);
    });
  }

  it('lasts through a drop and a reopen that says the same', async () => {
    const { ended } = await held();
    streams[0]!.end();
    await waitFor(() => streams.length === 2, 4000);
    await sleep(300);
    expect(ended()).toBe(false);
  });

  it('ends as the setting turns off', async () => {
    const { ended } = await held();
    say({ type: 'hold', ms: null });
    await waitFor(ended);
  });

  it('ends as the last controller leaves while a Viewer still watches in full', async () => {
    const { ended } = await held();
    say(VIEW);
    say({ type: 'viewers', count: 1 });
    await waitFor(ended);
  });

  it('takes a new length, saying its new end, and ends at once when that length is past', async () => {
    const { hold, ended } = await held();
    const began = hold.until - LONG_MS;
    const stop: LiveStop = { reason: 'held', call: { title: 'Failed: x', file: null, line: null }, test: 'pays' };
    liveViewStopped({ ...stop, until: hold.until });
    await waitFor(() => posts.some((p) => p.type === 'stop'));
    say({ type: 'hold', ms: 2 * LONG_MS });
    await waitFor(() => posts.filter((p) => p.type === 'stop').length === 2);
    const stops = posts.filter((p) => p.type === 'stop');
    const again = stops[stops.length - 1] as Extract<WorkerToInstance, { type: 'stop' }>;
    expect(again.stop).toMatchObject({ reason: 'held', test: 'pays' });
    expect(again.stop!.until).toBeGreaterThanOrEqual(began + 2 * LONG_MS - 5);
    expect(again.stop!.until).toBeLessThanOrEqual(began + 2 * LONG_MS + 5);
    expect(ended()).toBe(false);
    say({ type: 'hold', ms: 1 });
    await waitFor(ended);
  });
});
