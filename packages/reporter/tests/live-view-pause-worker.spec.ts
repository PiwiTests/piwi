import type * as http from 'node:http';
import type { WorkerInfo } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIVE_VIEW_ENV, formatLiveViewEnv } from '@piwitests/core/live-view';
import {
  closeLiveView,
  liveViewMayPause,
  liveViewPause,
  liveViewTestBegan,
  liveViewTestEnded,
  onLiveViewPause,
  openLiveView,
  type LiveWait,
} from '../src/internal/capture/live-view.js';
import { jsonRes, startServer, type FakeServer } from './_helpers.js';

/**
 * A CI worker's pause of its test, asked by a controller on its live view stream, against a fake instance: a Pause is
 * taken only with the project's setting on (`hold`'s `pause`) and a controller watching the worker in full, the test
 * stopping at its next call (`onLiveViewPause`); the pause then ends at Resume, at End the test, at its length, as the
 * last controller leaves, as the setting turns off and as the run's live view ends; a Pause no call took yet is dropped
 * at those ends. Resume and End the test change nothing while the test is not paused, and so does a Let it go.
 */

const KEY = `pdl_${'p'.repeat(43)}`;
const RUN = 53;
const worker = { workerIndex: 0, parallelIndex: 0, config: { shard: null } } as unknown as Pick<
  WorkerInfo,
  'workerIndex' | 'config'
> & { parallelIndex: number };
const LONG_MS = 60_000;
const VIEW = { type: 'view', width: 640, height: 400, fps: 4, full: true, layers: [], inspect: false };

let server: FakeServer;
let streams: http.ServerResponse[];
let nextStatus: number;
let opening: unknown[];
/** What the worker asked of its running test: each Pause, and each drop of a Pause no call took. */
let asked: string[];
/** The address of each stream the worker opened. */
let urls: string[];

beforeEach(async () => {
  streams = [];
  nextStatus = 200;
  asked = [];
  urls = [];
  opening = [
    { type: 'hold', ms: LONG_MS, pause: true },
    { ...VIEW, controller: true },
    { type: 'viewers', count: 1 },
  ];
  onLiveViewPause({ pause: () => void asked.push('pause'), drop: () => void asked.push('drop') });
  server = await startServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) return jsonRes(res, 401, {});
    if (req.method === 'GET') {
      if (nextStatus !== 200) return jsonRes(res, nextStatus, {});
      urls.push(req.url);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const message of opening) res.write(`data: ${JSON.stringify(message)}\n\n`);
      streams.push(res);
      return;
    }
    jsonRes(res, 200, {});
  });
});

afterEach(async () => {
  await liveViewTestEnded();
  closeLiveView();
  onLiveViewPause(null);
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

/** A CI worker whose test runs, its stream open with the instance's opening. */
async function running(): Promise<void> {
  const env: NodeJS.ProcessEnv = { [LIVE_VIEW_ENV]: formatLiveViewEnv(server.url, RUN, KEY) };
  expect(openLiveView(worker, env, true)).toBe(true);
  await waitFor(() => streams.length === 1);
  liveViewTestBegan('pays', () => null);
  // The opening is read once the worker says it can pause.
  await sleep(100);
}

/** A running CI test a controller paused: the Pause taken, and the wait as its next call stops. */
async function paused(): Promise<{ wait: LiveWait; ended: () => string | null }> {
  await running();
  say({ type: 'pause' });
  await waitFor(() => asked.includes('pause'));
  const wait = liveViewPause();
  expect(wait).not.toBeNull();
  let ended: string | null = null;
  void wait!.ended.then((how) => (ended = how));
  return { wait: wait!, ended: () => ended };
}

describe('a CI worker’s pause of its test', () => {
  it('says on its stream that it can hold and pause', async () => {
    await running();
    expect(new URL(urls[0]!, 'http://x').searchParams.get('features')).toBe('hold,pause');
  });

  it('follows the call log through the instrumentation while the setting is on, and only then', async () => {
    await running();
    expect(liveViewMayPause()).toBe(true);
    say({ type: 'hold', ms: LONG_MS });
    await waitFor(() => !liveViewMayPause());
  });

  it('takes a Pause with the setting on and a controller watching in full, its wait ending at its length', async () => {
    const { wait } = await paused();
    expect(wait.until - Date.now()).toBeGreaterThan(LONG_MS - 1000);
    expect(wait.until - Date.now()).toBeLessThanOrEqual(LONG_MS);
    // One wait at a time: a second Pause is not taken while paused.
    say({ type: 'pause' });
    await sleep(100);
    expect(asked).toEqual(['pause']);
    expect(liveViewPause()).toBeNull();
  });

  it('ends at its length', async () => {
    opening[0] = { type: 'hold', ms: 300, pause: true };
    const { ended } = await paused();
    await waitFor(() => ended() === 'resume', 2000);
  });

  it('goes on at Resume, and ends the test at End the test', async () => {
    const first = await paused();
    say({ type: 'resume' });
    await waitFor(() => first.ended() === 'resume');
    say({ type: 'pause' });
    await waitFor(() => asked.length === 2);
    const second = liveViewPause()!;
    let how: string | null = null;
    void second.ended.then((end) => (how = end));
    say({ type: 'end-test' });
    await waitFor(() => how === 'end');
  });

  it('ignores Let it go, and Resume and End the test while the test is not paused', async () => {
    const { ended } = await paused();
    say({ type: 'let-go' });
    await sleep(200);
    expect(ended()).toBeNull();
  });

  it('ends as the last controller leaves, and drops a Pause no call took', async () => {
    const { ended } = await paused();
    say(VIEW);
    say({ type: 'viewers', count: 1 });
    await waitFor(() => ended() === 'resume');
    say({ ...VIEW, controller: true });
    say({ type: 'pause' });
    await waitFor(() => asked.length === 2);
    say({ type: 'viewers', count: 0 });
    await waitFor(() => asked[2] === 'drop');
    expect(liveViewPause()).toBeNull();
  });

  it('ends as the setting turns off, the hold’s or the pause’s', async () => {
    const first = await paused();
    say({ type: 'hold', ms: LONG_MS });
    await waitFor(() => first.ended() === 'resume');
    say({ type: 'hold', ms: LONG_MS, pause: true });
    say({ type: 'pause' });
    await waitFor(() => asked.filter((a) => a === 'pause').length === 2);
    const second = liveViewPause()!;
    let how: string | null = null;
    void second.ended.then((end) => (how = end));
    say({ type: 'hold', ms: null });
    await waitFor(() => how === 'resume');
  });

  for (const status of [404, 409]) {
    it(`ends as the stream that opens again is answered ${status}: the run’s live view is not there now`, async () => {
      const { ended } = await paused();
      nextStatus = status;
      streams[0]!.end();
      await waitFor(() => ended() === 'resume', 4000);
    });
  }

  it('takes no Pause with the setting off, for a Viewer, or with no test running', async () => {
    opening[0] = { type: 'hold', ms: LONG_MS };
    await running();
    say({ type: 'pause' });
    say({ type: 'hold', ms: LONG_MS, pause: true });
    say({ ...VIEW });
    say({ type: 'pause' });
    say({ ...VIEW, controller: true });
    await liveViewTestEnded();
    say({ type: 'pause' });
    await sleep(200);
    expect(asked.filter((a) => a === 'pause')).toEqual([]);
    expect(liveViewPause()).toBeNull();
  });
});
