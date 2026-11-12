import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  LIVE_FRAME_FPS,
  LIVE_FRAME_HEIGHT,
  LIVE_FRAME_WIDTH,
  LIVE_TILE_FPS,
  LIVE_TILE_HEIGHT,
  LIVE_TILE_WIDTH,
  LIVE_VIEW_KEY_PREFIX,
  type LiveWorkerId,
} from '@piwitests/core/live-view';
import type { LiveWorkerState } from '#shared/live-view';
import {
  LANE_RESTARTING,
  LANE_WAIT_MS,
  LIVE_KEY_TTL_MS,
  LiveViewRelay,
  MAX_LIVE_KEYS,
  MAX_LIVE_BYTES_PER_RUN,
  MAX_LIVE_KEYS_PER_PROJECT,
  MAX_LIVE_VIEWERS_PER_PERSON,
  MAX_LIVE_VIEWERS_PER_RUN,
  MAX_LIVE_WORKERS_PER_RUN,
  MAX_RELAYED_FPS,
  type LiveRelayMessage,
  type LiveWatchAsk,
} from '../../server/utils/live-view';
import type { EventStreamSink } from '../../server/utils/event-stream';
import { runEventBus } from '../../server/utils/run-events';

/**
 * The relay between a live run's workers and the pages watching them: a key opens its own run's view alone and not
 * after it expired or the run ended, survives the run's interruption, and no project's keys push another's out;
 * frames reach the watches of their worker and nobody else, are kept nowhere, the latest alone while a viewer reads
 * slowly; a watch shows one worker in full and every worker as a tile, one a second, and changes what it shows on its
 * own stream, each worker hearing how many watch it and what they ask of its images; a key whose digest its run stores
 * is taken back by a relay that does not hold it, as one started again; workers, watches (per run and per person),
 * frames a second and the run's bytes of images a second are bounded; a stop reaches the run page and survives the
 * worker's new stream; and the run page hears each worker leave, whatever ends it.
 */

/** A stream as a test reads it: what was sent, whether it is backed up, and its close. */
class FakeSink implements EventStreamSink {
  sent: unknown[] = [];
  full = false;
  closed = false;
  private drains: Array<() => void> = [];
  private closers: Array<() => void> = [];
  send(message: unknown): void {
    if (!this.closed) this.sent.push(message);
  }
  backedUp(): boolean {
    return this.full;
  }
  onDrain(listener: () => void): void {
    this.drains.push(listener);
  }
  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closers.push(listener);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const close of this.closers.splice(0)) close();
  }
  drain(): void {
    this.full = false;
    for (const drain of this.drains) drain();
  }
}

function relay(now = () => 1_000_000) {
  const published: Array<{ runId: number; state: LiveWorkerState }> = [];
  const live = new LiveViewRelay((runId, state) => published.push({ runId, state }), now);
  return { live, published };
}

/** A JPEG's first bytes, then `n`: images told apart. */
const image = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n]);

const frame = (worker: number, bytes: Uint8Array, shard: number | null = null): LiveRelayMessage => ({
  type: 'frame',
  shard,
  worker,
  image: bytes,
  call: { title: 'Click', file: 'tests/a.spec.ts', line: 4 },
  test: 'pays',
});

/** A page's watch of run `runId`, showing `focus` in full, opened on `sink`. */
function watch(
  live: LiveViewRelay,
  runId: number,
  focus: LiveWorkerId | null,
  sink: FakeSink,
  person: number | null = null,
  ask: LiveWatchAsk = {},
) {
  return live.openWatch(runId, 1, { focus, ...ask }, () => sink, person);
}

/** What a watch heard, the id it opened with aside. */
const got = (sink: FakeSink) => sink.sent.filter((m) => (m as { type: string }).type !== 'hello');

const STOP = {
  reason: 'page-pause' as const,
  call: { title: 'Pause', file: 'tests/a.spec.ts', line: 9 },
  test: 'pays',
};

describe('the live view key', () => {
  test('opens its own run alone, and nothing once expired or once the run ended', () => {
    let now = 1_000_000;
    const { live } = relay(() => now);
    const key = live.mintKey(7, 1)!;
    expect(key.startsWith(LIVE_VIEW_KEY_PREFIX)).toBe(true);
    expect(live.authorize(7, key)).toMatchObject({ runId: 7, projectId: 1 });
    expect(live.authorize(8, key)).toBeNull();
    expect(live.authorize(7, `${key.slice(0, -1)}x`)).toBeNull();
    expect(live.authorize(7, 'pd_secret')).toBeNull();
    expect(live.authorize(7, null)).toBeNull();
    now += LIVE_KEY_TTL_MS;
    expect(live.authorize(7, key)).toBeNull();

    const other = live.mintKey(9, 1)!;
    expect(live.authorize(9, other)).not.toBeNull();
    live.endRun(9);
    expect(live.authorize(9, other)).toBeNull();
  });

  test('is minted 64 times a run at most, and every key of a project ends as it turns the view off', () => {
    const { live } = relay();
    const keys = Array.from({ length: 64 }, () => live.mintKey(3, 2));
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(64);
    expect(live.mintKey(3, 2)).toBeNull();
    const elsewhere = live.mintKey(4, 5)!;
    expect(live.endProject(2)).toEqual([3]);
    expect(keys.some((key) => live.authorize(3, key))).toBe(false);
    expect(live.authorize(4, elsewhere)).not.toBeNull();
  });

  test('says whether a run holds one, for its page: not once it expired, the run ended or the view turned off', () => {
    let now = 1_000_000;
    const { live } = relay(() => now);
    expect(live.holdsKey(7)).toBe(false);
    live.mintKey(7, 1);
    live.mintKey(8, 1);
    live.mintKey(9, 2);
    expect(live.holdsKey(7)).toBe(true);
    live.endRun(7);
    expect(live.holdsKey(7)).toBe(false);
    live.endProject(1);
    expect(live.holdsKey(8)).toBe(false);
    expect(live.holdsKey(9)).toBe(true);
    now += LIVE_KEY_TTL_MS;
    expect(live.holdsKey(9)).toBe(false);
  });

  test('is taken back from the digest its run stores by a relay that does not hold it, until a day after the run began', () => {
    let now = 1_000_000;
    const { live } = relay(() => now);
    const key = `${LIVE_VIEW_KEY_PREFIX}${'a'.repeat(43)}`;
    const digest = createHash('sha256').update(key).digest('hex');
    const stored = { digests: [`${digest.slice(0, -1)}0`, digest], createdAt: new Date(now - 1000) };
    expect(live.authorize(7, key)).toBeNull();
    expect(live.holdsKey(7)).toBe(false);
    expect(live.holdsKey(7, stored)).toBe(true);
    expect(live.holdsKey(7, { digests: null, createdAt: stored.createdAt })).toBe(false);
    // A wrong key, the digest itself, or a run that stores none take nothing back.
    expect(live.restoreKey(7, 1, `${key.slice(0, -1)}b`, stored)).toBeNull();
    expect(live.restoreKey(7, 1, digest, stored)).toBeNull();
    expect(live.restoreKey(7, 1, key, { digests: 'nothing', createdAt: stored.createdAt })).toBeNull();
    expect(live.restoreKey(7, 1, key, stored)).toMatchObject({ runId: 7, projectId: 1, streamed: false });
    // Taken back, it opens its own run alone, as long as a key minted with the run would.
    expect(live.authorize(7, key)).not.toBeNull();
    expect(live.authorize(8, key)).toBeNull();
    now += LIVE_KEY_TTL_MS - 1000;
    expect(live.authorize(7, key)).toBeNull();
    expect(live.restoreKey(7, 1, key, stored)).toBeNull();
    expect(live.holdsKey(7, stored)).toBe(false);
  });

  test('ended as the project turned its view off, is taken back once it is on again, and its end is forgotten', () => {
    const { live } = relay();
    const key = live.mintKey(7, 1)!;
    const stored = { digests: [createHash('sha256').update(key).digest('hex')], createdAt: new Date(1_000_000) };
    live.endProject(1);
    expect(live.endedWhy(7, key)).toBe('off');
    expect(live.restoreKey(7, 1, key, stored)).not.toBeNull();
    expect(live.endedWhy(7, key)).toBeNull();
    expect(live.authorize(7, key)).not.toBeNull();
  });

  test('is taken back within its run’s bound', () => {
    const { live } = relay();
    for (let i = 0; i < 64; i++) live.mintKey(3, 2);
    const key = `${LIVE_VIEW_KEY_PREFIX}${'c'.repeat(43)}`;
    const stored = { digests: [createHash('sha256').update(key).digest('hex')], createdAt: new Date(1_000_000) };
    expect(live.restoreKey(3, 2, key, stored)).toBeNull();
    expect(live.authorize(3, key)).toBeNull();
  });

  test('ends with its run, as the run finishes or is cancelled', () => {
    const live = new LiveViewRelay(() => undefined);
    const stop = live.followRuns();
    try {
      for (const type of ['run-finished', 'run-cancelled', 'run-finalizing', 'run-submitted'] as const) {
        const key = live.mintKey(11, 1)!;
        runEventBus.publishGlobal({ type, runId: 11, projectId: 1, status: 'passed' });
        expect(live.authorize(11, key), type).toBeNull();
      }
      const key = live.mintKey(11, 1)!;
      runEventBus.publishGlobal({ type: 'run-started', runId: 11, projectId: 1 });
      expect(live.authorize(11, key)).not.toBeNull();
    } finally {
      stop();
    }
  });

  test('outlives the run’s interruption, which closes its streams, until the run ends', () => {
    const { live, published } = relay();
    const stop = live.followRuns();
    try {
      const key = live.mintKey(12, 1)!;
      const entry = live.authorize(12, key)!;
      const worker = new FakeSink();
      live.connectWorker(entry, { shard: null, worker: 0 }, () => worker);
      const viewer = new FakeSink();
      watch(live, 12, { shard: null, worker: 0 }, viewer);
      runEventBus.publishGlobal({ type: 'run-finished', runId: 12, projectId: 1, status: 'interrupted' });
      expect(worker.closed).toBe(true);
      expect(got(viewer)).toEqual([{ type: 'end', reason: 'run-ended' }]);
      expect(viewer.closed).toBe(true);
      expect(published.at(-1)?.state).toEqual({ shard: null, worker: 0, connected: false, paused: null });
      expect(live.workersOf(12)).toEqual([]);
      // The run goes on: its worker opens its stream again with the same key.
      expect(live.authorize(12, key)).not.toBeNull();
      expect(live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink())).toBeNull();
      runEventBus.publishGlobal({ type: 'run-finished', runId: 12, projectId: 1, status: 'failed' });
      expect(live.authorize(12, key)).toBeNull();
    } finally {
      stop();
    }
  });

  test('a project at its bound gives up its expired keys, then its oldest, and no other project’s', () => {
    let now = 1_000_000;
    const { live } = relay(() => now);
    const others = [live.mintKey(1, 100)!, live.mintKey(2, 101)!];
    const first = live.mintKey(3, 200)!;
    now += LIVE_KEY_TTL_MS;
    const fresh = live.mintKey(4, 200)!;
    for (let run = 5; run < 3 + MAX_LIVE_KEYS_PER_PROJECT; run++) live.mintKey(run, 200);
    // At its bound: the expired key goes first.
    live.mintKey(9_000, 200);
    expect(live.authorize(4, fresh)).not.toBeNull();
    // Then its oldest.
    live.mintKey(9_001, 200);
    expect(live.authorize(4, fresh)).toBeNull();
    expect(live.authorize(3, first)).toBeNull();
    expect(others.map((key, i) => live.authorize(i + 1, key) !== null)).toEqual([false, false]);
  });

  test('a project at its bound keeps the key of a run that streams, giving up first those that never opened a stream', () => {
    let now = 1_000_000;
    const { live } = relay(() => now);
    // A CI run starts and streams; a minute later, the same project's developers start runs nobody shares.
    const ci = live.mintKey(1, 10)!;
    live.connectWorker(live.authorize(1, ci)!, { shard: null, worker: 0 }, () => new FakeSink());
    now += 60_000;
    const local = Array.from({ length: MAX_LIVE_KEYS_PER_PROJECT }, (_, i) => live.mintKey(100 + i, 10)!);
    expect(live.authorize(1, ci)).not.toBeNull();
    expect(live.authorize(100, local[0])).toBeNull();
    expect(live.authorize(101, local[1])).not.toBeNull();
  });

  test('the instance at its bound gives up first the keys that never opened a stream, of the project that holds most', () => {
    const { live } = relay();
    const streams = live.mintKey(1, 200)!;
    live.connectWorker(live.authorize(1, streams)!, { shard: null, worker: 0 }, () => new FakeSink());
    const small = live.mintKey(2, 100)!;
    for (let i = 0; i < MAX_LIVE_KEYS + 10; i++) live.mintKey(10 + i, 200 + Math.floor(i / MAX_LIVE_KEYS_PER_PROJECT));
    expect(live.authorize(1, streams)).not.toBeNull();
    expect(live.authorize(2, small)).not.toBeNull();
  });

  test('ends an interrupted run’s keys that never opened a stream, and tells why a key that ended opens nothing', () => {
    const { live } = relay();
    const stop = live.followRuns();
    try {
      const streams = live.mintKey(12, 1)!;
      live.connectWorker(live.authorize(12, streams)!, { shard: null, worker: 0 }, () => new FakeSink());
      const idle = live.mintKey(12, 1)!;
      runEventBus.publishGlobal({ type: 'run-finished', runId: 12, projectId: 1, status: 'interrupted' });
      expect(live.authorize(12, streams)).not.toBeNull();
      expect(live.authorize(12, idle)).toBeNull();
      expect(live.endedWhy(12, idle)).toBe('run-ended');
      expect(live.endedWhy(12, streams)).toBeNull();
      // The project turns its live view off: its keys say so to the workers that present them again.
      const other = live.mintKey(13, 1)!;
      live.endProject(1);
      expect(live.authorize(13, other)).toBeNull();
      expect(live.endedWhy(13, other)).toBe('off');
      expect(live.endedWhy(12, streams)).toBe('off');
      expect(live.endedWhy(14, other)).toBeNull();
      expect(live.endedWhy(13, `${LIVE_VIEW_KEY_PREFIX}${'x'.repeat(43)}`)).toBeNull();
    } finally {
      stop();
    }
  });

  test('the instance at its bound gives up the oldest key of the project that holds the most', () => {
    const { live } = relay();
    const small = live.mintKey(1, 100)!;
    const firstOfLargest = live.mintKey(2, 200)!;
    for (let i = 1; i < MAX_LIVE_KEYS + 10; i++) live.mintKey(2 + i, 200 + Math.floor(i / MAX_LIVE_KEYS_PER_PROJECT));
    expect(live.authorize(1, small)).not.toBeNull();
    expect(live.authorize(2, firstOfLargest)).toBeNull();
  });
});

describe('the relay', () => {
  test('tells a worker how many watch it and what they ask, and relays its frames to its viewers alone', () => {
    const { live, published } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const workers = [new FakeSink(), new FakeSink()];
    expect(live.connectWorker(entry, { shard: null, worker: 0 }, () => workers[0]!)).toBeNull();
    expect(live.connectWorker(entry, { shard: null, worker: 1 }, () => workers[1]!)).toBeNull();
    expect(workers[0]!.sent).toEqual([
      { type: 'masks', locators: [] },
      { type: 'view', width: LIVE_FRAME_WIDTH, height: LIVE_FRAME_HEIGHT, fps: LIVE_FRAME_FPS },
      { type: 'viewers', count: 0 },
    ]);
    expect(published.map((p) => p.state)).toEqual([
      { shard: null, worker: 0, connected: true, paused: null },
      { shard: null, worker: 1, connected: true, paused: null },
    ]);

    // Nobody watches: a frame goes nowhere, and is not kept for a viewer that comes later.
    expect(live.receive(7, frame(0, image(1)))).toBeNull();
    const viewer = new FakeSink();
    expect(watch(live, 7, { shard: null, worker: 0 }, viewer, null, { size: { width: 1000, height: 640 } })).toBeNull();
    expect(viewer.sent[0]).toEqual({ type: 'hello', watch: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) });
    expect(workers[0]!.sent.slice(-2)).toEqual([
      { type: 'view', width: 1000, height: 640, fps: LIVE_FRAME_FPS },
      { type: 'viewers', count: 1 },
    ]);
    expect(got(viewer)).toEqual([]);

    live.receive(7, frame(0, image(2)));
    live.receive(7, frame(1, image(3)));
    live.receive(7, { ...frame(0, image(4)), at: 1_760_000_000_000 });
    expect(got(viewer)).toEqual([
      {
        type: 'frame',
        shard: null,
        worker: 0,
        image: image(2),
        call: { title: 'Click', file: 'tests/a.spec.ts', line: 4 },
        test: 'pays',
      },
      {
        type: 'frame',
        shard: null,
        worker: 0,
        image: image(4),
        call: { title: 'Click', file: 'tests/a.spec.ts', line: 4 },
        test: 'pays',
        at: 1_760_000_000_000,
      },
    ]);
    expect(live.countsFor(7)).toMatchObject({ frames: 4, bytes: 4 * image(1).length });

    viewer.close();
    expect(workers[0]!.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
    expect(live.viewersOf(7)).toBe(0);
  });

  test('gives a viewer that reads slowly the latest frame alone, once it drains', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: 2, worker: 0 }, () => new FakeSink());
    const viewer = new FakeSink();
    watch(live, 7, { shard: 2, worker: 0 }, viewer);
    viewer.full = true;
    for (const n of [1, 2, 3]) live.receive(7, frame(0, image(n), 2));
    expect(got(viewer)).toEqual([]);
    viewer.drain();
    expect(got(viewer)).toEqual([expect.objectContaining({ type: 'frame', image: image(3) })]);
    viewer.drain();
    expect(got(viewer)).toHaveLength(1);
  });

  test('relays a worker’s call log to its full views alone, at its own rate, a slow viewer keeping its frame too', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink());
    live.connectWorker(entry, { shard: null, worker: 1 }, () => new FakeSink());
    const log = {
      id: 'call@1',
      call: { title: 'Click', file: 'tests/a.spec.ts', line: 4 },
      status: 'running' as const,
      lines: ['  element is not enabled'],
      point: null,
      target: { count: 1, box: null, enabled: false },
      viewport: { width: 1280, height: 800 },
      ms: 1200,
      error: null,
    };
    const callLog = (worker: number): LiveRelayMessage => ({
      type: 'call-log',
      shard: null,
      worker,
      log,
      test: 'pays',
    });
    const viewer = new FakeSink();
    watch(live, 7, { shard: null, worker: 0 }, viewer);
    expect(live.receive(7, callLog(0))).toBeNull();
    expect(live.receive(7, callLog(1))).toBeNull();
    expect(got(viewer)).toEqual([{ type: 'call-log', shard: null, worker: 0, log, test: 'pays' }]);

    // A viewer that reads slowly gets the latest frame and the latest call log once it drains: neither pushes the other out.
    viewer.full = true;
    live.receive(7, frame(0, image(1)));
    live.receive(7, callLog(0));
    viewer.drain();
    expect(
      got(viewer)
        .slice(1)
        .map((m) => (m as { type: string }).type),
    ).toEqual(['frame', 'call-log']);

    // A message that comes while older ones still wait goes after them: never a stale one after it.
    viewer.full = true;
    live.receive(7, { ...callLog(0), log: { ...log, status: 'passed' } } as LiveRelayMessage);
    viewer.full = false;
    live.receive(7, callLog(0));
    expect(got(viewer)).toHaveLength(3);
    viewer.drain();
    expect(got(viewer).slice(3)).toEqual([{ type: 'call-log', shard: null, worker: 0, log, test: 'pays' }]);

    // Why no image shows takes the image's place: the latest of the two alone reaches a slow viewer.
    const before = got(viewer).length;
    viewer.full = true;
    live.receive(7, frame(0, image(1)));
    live.receive(7, { type: 'frame', shard: null, worker: 0, refused: 'The page is too heavy.' });
    live.receive(7, frame(0, image(2)));
    viewer.drain();
    expect(got(viewer).slice(before)).toEqual([expect.objectContaining({ type: 'frame', image: image(2) })]);

    // Past the rate of call logs, one more is refused; frames have their own.
    let refused = null;
    for (let i = 0; i < 20 && !refused; i++) refused = live.receive(7, callLog(1));
    expect(refused).toMatchObject({ status: 429 });
    expect(live.receive(7, frame(1, image(1)))).toBeNull();
  });

  test('refuses a worker past the bound, a watch past the bound, and frames past the rate', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    for (let worker = 0; worker < MAX_LIVE_WORKERS_PER_RUN; worker++) {
      expect(live.connectWorker(entry, { shard: null, worker }, () => new FakeSink())).toBeNull();
    }
    let opened = false;
    expect(
      live.connectWorker(entry, { shard: null, worker: MAX_LIVE_WORKERS_PER_RUN }, () => {
        opened = true;
        return new FakeSink();
      }),
    ).toMatchObject({ status: 429 });
    expect(opened).toBe(false);
    // The same worker opening its stream again takes its place.
    expect(live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink())).toBeNull();

    // A watch counts once, whatever it shows: a full view, tiles of every worker, or both.
    for (let i = 0; i < MAX_LIVE_VIEWERS_PER_RUN; i++) {
      const ask = i % 2 ? { tiles: true } : {};
      expect(watch(live, 7, i % 3 ? { shard: null, worker: i % 3 } : null, new FakeSink(), null, ask)).toBeNull();
    }
    expect(watch(live, 7, { shard: null, worker: 5 }, new FakeSink())).toMatchObject({ status: 429 });
    expect(watch(live, 7, { shard: null, worker: 999 }, new FakeSink())).toMatchObject({ status: 404 });
    expect(watch(live, 8, { shard: null, worker: 0 }, new FakeSink())).toMatchObject({ status: 404 });

    for (let i = 0; i < MAX_RELAYED_FPS; i++) expect(live.receive(7, frame(4, image(1)))).toBeNull();
    expect(live.receive(7, frame(4, image(1)))).toMatchObject({ status: 429 });
    expect(live.receive(7, frame(999, image(1)))).toMatchObject({ status: 409 });
  });

  test('holds the run’s workers together to a byte rate of images, a second at a time', () => {
    let now = 1_000_000;
    const { live } = relay(() => now);
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    for (let worker = 0; worker < 4; worker++) live.connectWorker(entry, { shard: null, worker }, () => new FakeSink());
    const heavy = new Uint8Array(MAX_LIVE_BYTES_PER_RUN / 4).fill(1);
    for (let worker = 0; worker < 4; worker++) expect(live.receive(7, frame(worker, heavy))).toBeNull();
    expect(live.receive(7, frame(0, image(1)))).toMatchObject({ status: 429, message: expect.stringMatching(/MB/) });
    // Why no image shows is no image: it goes.
    expect(live.receive(7, { type: 'frame', shard: null, worker: 1, refused: 'No page yet.' })).toBeNull();
    now += 1000;
    expect(live.receive(7, frame(0, image(1)))).toBeNull();
  });

  test('tells a worker the elements its project masks as it connects, and each change, to that project’s workers alone', () => {
    const { live } = relay();
    const own = new FakeSink();
    const other = new FakeSink();
    live.connectWorker(live.authorize(7, live.mintKey(7, 1))!, { shard: null, worker: 0 }, () => own, [
      "getByLabel('IBAN')",
    ]);
    live.connectWorker(live.authorize(8, live.mintKey(8, 2))!, { shard: null, worker: 0 }, () => other);
    expect(own.sent[0]).toEqual({ type: 'masks', locators: ["getByLabel('IBAN')"] });
    live.setMasks(1, ["getByLabel('IBAN')", "getByTestId('card')"]);
    expect(own.sent.at(-1)).toEqual({ type: 'masks', locators: ["getByLabel('IBAN')", "getByTestId('card')"] });
    expect(other.sent.filter((m) => (m as { type: string }).type === 'masks')).toEqual([
      { type: 'masks', locators: [] },
    ]);

    // A worker whose route read the list before that change gets the change.
    const late = new FakeSink();
    live.connectWorker(live.authorize(9, live.mintKey(9, 1))!, { shard: null, worker: 0 }, () => late, [
      "getByLabel('IBAN')",
    ]);
    expect(late.sent[0]).toEqual({ type: 'masks', locators: ["getByLabel('IBAN')", "getByTestId('card')"] });
  });

  test('keeps the viewers and the stop of a worker that opens its stream again', () => {
    const { live, published } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const first = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => first);
    live.receive(7, { type: 'stop', shard: null, worker: 0, stop: STOP });
    const viewer = new FakeSink();
    watch(live, 7, { shard: null, worker: 0 }, viewer);
    const second = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => second);
    expect(first.closed).toBe(true);
    expect(second.sent).toEqual([
      { type: 'masks', locators: [] },
      { type: 'view', width: LIVE_FRAME_WIDTH, height: LIVE_FRAME_HEIGHT, fps: LIVE_FRAME_FPS },
      { type: 'viewers', count: 1 },
    ]);
    expect(live.workersOf(7)).toEqual([{ shard: null, worker: 0, connected: true, paused: STOP }]);
    expect(published.at(-1)?.state).toEqual({ shard: null, worker: 0, connected: true, paused: STOP });
    live.receive(7, frame(0, image(4)));
    expect(got(viewer)).toEqual([expect.objectContaining({ image: image(4) })]);

    // Its stream drops and opens again: still paused.
    second.close();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink());
    expect(live.workersOf(7)[0]?.paused).toBeNull();
  });

  test('gives one person 4 watches of a run at most, a further one replacing their oldest', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => worker);
    live.connectWorker(entry, { shard: null, worker: 1 }, () => new FakeSink());
    const mine = Array.from({ length: MAX_LIVE_VIEWERS_PER_PERSON }, () => new FakeSink());
    for (const [i, sink] of mine.entries()) {
      expect(watch(live, 7, { shard: null, worker: i % 2 }, sink, 3)).toBeNull();
    }
    const fifth = new FakeSink();
    expect(watch(live, 7, { shard: null, worker: 1 }, fifth, 3)).toBeNull();
    expect(got(mine[0]!)).toEqual([{ type: 'end', reason: 'replaced' }]);
    expect(mine[0]!.closed).toBe(true);
    expect(worker.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });
    expect(mine.slice(1).every((sink) => !sink.closed)).toBe(true);

    // The run's other seats stay for other people; a person unknown (authentication off) takes any.
    for (const person of [4, 5, null]) {
      for (let i = 0; i < MAX_LIVE_VIEWERS_PER_PERSON; i++) {
        expect(watch(live, 7, { shard: null, worker: 0 }, new FakeSink(), person)).toBeNull();
      }
    }
    expect(MAX_LIVE_VIEWERS_PER_PERSON * 4).toBe(MAX_LIVE_VIEWERS_PER_RUN);
    expect(watch(live, 7, { shard: null, worker: 0 }, new FakeSink(), 6)).toMatchObject({ status: 429 });
    // Past the run's seats, a person at their share still replaces their own oldest.
    expect(watch(live, 7, { shard: null, worker: 0 }, new FakeSink(), 3)).toBeNull();
    expect(mine[1]!.closed).toBe(true);
  });

  test('says a worker is paused at its call, then running, then gone, and ends its full views as it leaves', () => {
    const { live, published } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 3 }, () => worker);
    live.receive(7, { type: 'stop', shard: null, worker: 3, stop: STOP });
    expect(live.workersOf(7)).toEqual([{ shard: null, worker: 3, connected: true, paused: STOP }]);
    live.receive(7, { type: 'stop', shard: null, worker: 3, stop: null });
    const viewer = new FakeSink();
    watch(live, 7, { shard: null, worker: 3 }, viewer);
    worker.close();
    expect(got(viewer)).toEqual([{ type: 'end', shard: null, worker: 3, reason: 'worker-left' }]);
    // The watch stays, for the page to show another worker on it.
    expect(viewer.closed).toBe(false);
    expect(live.viewersOf(7)).toBe(1);
    expect(published.slice(1).map((p) => p.state.paused ?? p.state.connected)).toEqual([STOP, true, false]);
    expect(live.workersOf(7)).toEqual([]);
  });

  test('ends a full view as the test it watched ends, and every watch as the run ends or the project turns it off', () => {
    const { live, published } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => worker);
    const watching = new FakeSink();
    watch(live, 7, { shard: null, worker: 0 }, watching);
    live.receive(7, { type: 'ended', shard: null, worker: 0 });
    expect(got(watching)).toEqual([{ type: 'end', shard: null, worker: 0, reason: 'test-ended' }]);
    expect(worker.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });

    const later = new FakeSink();
    watch(live, 7, { shard: null, worker: 0 }, later);
    live.receive(7, { type: 'stop', shard: null, worker: 0, stop: STOP });
    live.endProject(1);
    expect(got(later)).toEqual([{ type: 'end', reason: 'off' }]);
    expect(later.closed).toBe(true);
    expect(watching.closed).toBe(true);
    expect(worker.closed).toBe(true);
    expect(live.authorize(7, 'x')).toBeNull();
    // The run page hears the worker left: no Watch, and no Paused, stays on its row.
    expect(published.at(-1)?.state).toEqual({ shard: null, worker: 0, connected: false, paused: null });
  });

  test('keeps a view of the worker’s lane through its test’s end, which it hears, and ends a view of the test', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0, slot: 0 }, () => worker);
    const lane = new FakeSink();
    const test = new FakeSink();
    watch(live, 7, { shard: null, worker: 0, slot: 0 }, lane);
    watch(live, 7, { shard: null, worker: 0 }, test);
    const outcome = { test: 'pays', status: 'failed' as const, ms: 1200 };
    live.receive(7, { type: 'ended', shard: null, worker: 0, slot: 0, outcome });
    expect(got(lane)).toEqual([{ type: 'test-ended', shard: null, worker: 0, slot: 0, outcome }]);
    expect(lane.closed).toBe(false);
    expect(got(test)).toEqual([{ type: 'end', shard: null, worker: 0, slot: 0, reason: 'test-ended', outcome }]);
    expect(worker.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });
    // The lane's next test: its frames reach the view that stayed.
    live.receive(7, { ...frame(0, image(1)), slot: 0, test: 'searches' });
    expect(got(lane).at(-1)).toMatchObject({ type: 'frame', test: 'searches' });
  });

  test('moves a view of the lane to the worker Playwright starts in it again, which hears it is watched', () => {
    vi.useFakeTimers();
    try {
      const { live } = relay();
      const entry = live.authorize(7, live.mintKey(7, 1))!;
      const first = new FakeSink();
      live.connectWorker(entry, { shard: 2, worker: 0, slot: 1 }, () => first);
      const lane = new FakeSink();
      watch(live, 7, { shard: 2, worker: 0, slot: 1 }, lane);
      // The worker leaves after its test failed: the view waits for the lane's next worker.
      first.close();
      expect(got(lane).at(-1)).toEqual({ type: 'refused', shard: 2, worker: 0, slot: 1, message: LANE_RESTARTING });
      const second = new FakeSink();
      live.connectWorker(entry, { shard: 2, worker: 3, slot: 1 }, () => second);
      expect(second.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });
      live.receive(7, { ...frame(3, image(1), 2), slot: 1 });
      expect(got(lane).at(-1)).toMatchObject({ type: 'frame', worker: 3 });

      // No worker comes back in the lane: the full view ends once it waited long enough, and the watch stays.
      second.close();
      vi.advanceTimersByTime(LANE_WAIT_MS);
      expect(got(lane).at(-1)).toEqual({ type: 'end', shard: 2, worker: 3, slot: 1, reason: 'worker-left' });
      expect(lane.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('moves a view of the lane to a new worker in it before the old one’s stream closed', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const first = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0, slot: 0 }, () => first);
    const lane = new FakeSink();
    watch(live, 7, { shard: null, worker: 0, slot: 0 }, lane);
    const second = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 1, slot: 0 }, () => second);
    expect(first.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
    expect(second.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });
    first.close();
    expect(got(lane)).toEqual([]);
  });

  test('sends a lane’s viewer how its test ended after nothing of that test, a frame still waiting dropped', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: null, worker: 0, slot: 0 }, () => new FakeSink());
    const lane = new FakeSink();
    watch(live, 7, { shard: null, worker: 0, slot: 0 }, lane);
    lane.full = true;
    live.receive(7, { ...frame(0, image(1)), slot: 0 });
    live.receive(7, { type: 'ended', shard: null, worker: 0, slot: 0 });
    lane.drain();
    expect(got(lane)).toEqual([{ type: 'test-ended', shard: null, worker: 0, slot: 0, outcome: null }]);
  });

  test('a lane’s viewer that left while it waited is not handed to the lane’s next worker, which hears nobody watches', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const first = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0, slot: 0 }, () => first);
    const lane = new FakeSink();
    watch(live, 7, { shard: null, worker: 0, slot: 0 }, lane);
    first.close();
    lane.close();
    const second = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 1, slot: 0 }, () => second);
    expect(second.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
  });

  test('counts a lane’s waiting viewers toward the run’s bound, and ends them as the run ends', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const first = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0, slot: 0 }, () => first);
    live.connectWorker(entry, { shard: null, worker: 1, slot: 1 }, () => new FakeSink());
    const lane = new FakeSink();
    watch(live, 7, { shard: null, worker: 0, slot: 0 }, lane);
    first.close();
    expect(live.viewersOf(7)).toBe(1);
    for (let i = 1; i < MAX_LIVE_VIEWERS_PER_RUN; i++) {
      expect(watch(live, 7, { shard: null, worker: 1 }, new FakeSink())).toBeNull();
    }
    expect(live.viewersOf(7)).toBe(MAX_LIVE_VIEWERS_PER_RUN);
    expect(watch(live, 7, { shard: null, worker: 1 }, new FakeSink())?.status).toBe(429);
    live.endRun(7);
    expect(got(lane).at(-1)).toEqual({ type: 'end', reason: 'run-ended' });
    expect(lane.closed).toBe(true);
    expect(live.viewersOf(7)).toBe(0);
  });

  test('keeps a lane with the worker that took it when the one it replaced opens its stream again', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const first = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0, slot: 0 }, () => first);
    const lane = new FakeSink();
    watch(live, 7, { shard: null, worker: 0, slot: 0 }, lane);
    const second = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 1, slot: 0 }, () => second);
    const again = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0, slot: 0 }, () => again);
    expect(again.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
    live.receive(7, { ...frame(1, image(1)), slot: 0 });
    expect(got(lane).at(-1)).toMatchObject({ type: 'frame', worker: 1 });
  });

  test('ends the full views of a run its developer stops sharing, each viewer hearing why, before the worker leaves', () => {
    const { live, published } = relay();
    const entry = live.authorize(8, live.mintKey(8, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => worker);
    const watching = new FakeSink();
    watch(live, 8, { shard: null, worker: 0 }, watching);
    live.receive(8, { type: 'stop', shard: null, worker: 0, stop: STOP });
    expect(live.receive(8, { type: 'unshared', shard: null, worker: 0 })).toBeNull();
    expect(got(watching)).toEqual([{ type: 'end', shard: null, worker: 0, reason: 'unshared' }]);
    expect(worker.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
    // The worker closes its stream: the run page hears it left, no Paused left on its row.
    worker.close();
    expect(published.at(-1)?.state).toEqual({ shard: null, worker: 0, connected: false, paused: null });
    expect(live.workersOf(8)).toEqual([]);
  });
});

describe('watch all', () => {
  test('shows every worker’s latest image as a tile, one a second, and the worker in full at its own pace', () => {
    vi.useFakeTimers();
    try {
      const { live } = relay();
      const entry = live.authorize(7, live.mintKey(7, 1))!;
      const workers = [0, 1, 2].map((worker) => {
        const sink = new FakeSink();
        live.connectWorker(entry, { shard: null, worker, slot: worker }, () => sink);
        return sink;
      });
      const page = new FakeSink();
      expect(
        watch(live, 7, { shard: null, worker: 1, slot: 1 }, page, null, {
          tiles: true,
          size: { width: 1280, height: 800 },
        }),
      ).toBeNull();
      // Every worker takes its images to the watch: the one in full at the page's size, the others as tiles.
      expect(workers[0]!.sent.slice(-2)).toEqual([
        { type: 'view', width: LIVE_TILE_WIDTH, height: LIVE_TILE_HEIGHT, fps: LIVE_TILE_FPS },
        { type: 'viewers', count: 1 },
      ]);
      expect(workers[1]!.sent.slice(-2)).toEqual([
        { type: 'view', width: 1280, height: 800, fps: LIVE_FRAME_FPS },
        { type: 'viewers', count: 1 },
      ]);

      for (const n of [1, 2, 3]) {
        live.receive(7, { ...frame(0, image(n)), slot: 0 });
        live.receive(7, { ...frame(1, image(n)), slot: 1 });
      }
      // The worker in full: each frame. A tile: its first at once, the latest of the rest a second later.
      const frames = (worker: number) =>
        got(page).filter((m) => (m as { worker?: number }).worker === worker) as Array<{ image: Uint8Array }>;
      expect(frames(1).map((m) => m.image)).toEqual([image(1), image(2), image(3)]);
      expect(frames(0).map((m) => m.image)).toEqual([image(1)]);
      vi.advanceTimersByTime(1000);
      expect(frames(0).map((m) => m.image)).toEqual([image(1), image(3)]);
      // No call log of a tile goes: the full view's alone.
      live.receive(7, {
        type: 'call-log',
        shard: null,
        worker: 0,
        slot: 0,
        test: 'pays',
        log: {
          id: 'c',
          call: { title: 'Click', file: null, line: null },
          status: 'running',
          lines: [],
          point: null,
          target: null,
          viewport: null,
          ms: 1,
          error: null,
        },
      });
      expect(got(page).some((m) => (m as { type: string }).type === 'call-log')).toBe(false);

      // A worker that leaves takes its waiting tile with it.
      live.receive(7, { ...frame(2, image(1)), slot: 2 });
      live.receive(7, { ...frame(2, image(2)), slot: 2 });
      workers[2]!.close();
      vi.advanceTimersByTime(2000);
      expect(frames(2).map((m) => m.image)).toEqual([image(1)]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('changes what a watch shows on its own stream, each worker hearing what it is asked now', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const workers = [0, 1].map((worker) => {
      const sink = new FakeSink();
      live.connectWorker(entry, { shard: null, worker, slot: worker }, () => sink);
      return sink;
    });
    const page = new FakeSink();
    watch(live, 7, { shard: null, worker: 0, slot: 0 }, page, 3);
    const id = (page.sent[0] as { watch: string }).watch;
    expect(workers[0]!.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });

    // Another lane in full: the first hears nobody watches, the second that it is watched.
    expect(live.changeWatch(7, id, 3, { focus: { shard: null, worker: 1, slot: 1 } })).toBeNull();
    expect(workers[0]!.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
    expect(workers[1]!.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });
    live.receive(7, { ...frame(0, image(1)), slot: 0 });
    live.receive(7, { ...frame(1, image(2)), slot: 1 });
    expect(got(page)).toEqual([expect.objectContaining({ worker: 1, image: image(2) })]);

    // A larger view: the worker hears the size, and nothing else changes.
    live.changeWatch(7, id, 3, { size: { width: 900, height: 600 } });
    expect(workers[1]!.sent.at(-1)).toEqual({ type: 'view', width: 900, height: 600, fps: LIVE_FRAME_FPS });

    // Tiles on, then the full view off: every worker takes tiles alone.
    live.changeWatch(7, id, 3, { tiles: true });
    expect(workers[0]!.sent.slice(-2)).toEqual([
      { type: 'view', width: LIVE_TILE_WIDTH, height: LIVE_TILE_HEIGHT, fps: LIVE_TILE_FPS },
      { type: 'viewers', count: 1 },
    ]);
    live.changeWatch(7, id, 3, { focus: null });
    expect(workers[1]!.sent.at(-1)).toEqual({
      type: 'view',
      width: LIVE_TILE_WIDTH,
      height: LIVE_TILE_HEIGHT,
      fps: LIVE_TILE_FPS,
    });
    live.changeWatch(7, id, 3, { tiles: false });
    expect(workers.map((sink) => sink.sent.at(-1))).toEqual([
      { type: 'viewers', count: 0 },
      { type: 'viewers', count: 0 },
    ]);

    // Refused, the watch stays as it was: another person's, another run's, a worker not in the live view.
    expect(live.changeWatch(7, id, 4, { tiles: true })).toMatchObject({ status: 404 });
    expect(live.changeWatch(8, id, 3, { tiles: true })).toMatchObject({ status: 404 });
    expect(live.changeWatch(7, 'unknown', 3, { tiles: true })).toMatchObject({ status: 404 });
    expect(live.changeWatch(7, id, 3, { focus: { shard: null, worker: 9 } })).toMatchObject({ status: 404 });
    expect(workers.map((sink) => sink.sent.at(-1))).toEqual([
      { type: 'viewers', count: 0 },
      { type: 'viewers', count: 0 },
    ]);
  });

  test('leaves a worker unwatched by a page that left before its watch opened', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0, slot: 0 }, () => worker);
    const gone = new FakeSink();
    gone.closed = true;
    expect(watch(live, 7, { shard: null, worker: 0, slot: 0 }, gone, null, { tiles: true })).toBeNull();
    expect(live.viewersOf(7)).toBe(0);
    expect(worker.sent.filter((m) => (m as { type: string }).type === 'viewers')).toEqual([
      { type: 'viewers', count: 0 },
    ]);
  });

  test('opens with tiles before any worker is in the live view, and every worker that comes hears it', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const page = new FakeSink();
    expect(watch(live, 7, null, page, null, { tiles: true })).toBeNull();
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0, slot: 0 }, () => worker);
    expect(worker.sent.slice(-2)).toEqual([
      { type: 'view', width: LIVE_TILE_WIDTH, height: LIVE_TILE_HEIGHT, fps: LIVE_TILE_FPS },
      { type: 'viewers', count: 1 },
    ]);
    page.close();
    expect(worker.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
    live.endRun(7);
    expect(live.viewersOf(7)).toBe(0);
  });
});
