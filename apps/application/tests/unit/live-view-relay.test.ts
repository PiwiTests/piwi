import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
  MAX_LIVE_TILE_FRAME,
  MAX_RELAYED_FPS,
  MAX_RELAYED_PAGE_EVENTS,
  MAX_RELAYED_SNAPSHOTS,
  MAX_RELAYED_THUMBS,
  MAX_RELAYED_TILE_FPS,
  MAX_WATCH_BYTES_PER_SECOND,
  MAX_WATCH_CHANGES_PER_SECOND,
  TELL_MS,
  TILE_TOO_LARGE,
  WATCH_STALL_MS,
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
 * frames a second and the run's bytes of images a second are bounded, frames nobody receives charged to nothing; a
 * watch's changes a second, its bytes of images a second and how long its stream stays backed up are bounded, a tile
 * carries a small image alone, and a worker hears what its watches ask `TELL_MS` apart at most; a stop reaches the run
 * page and survives the worker's new stream; and the run page hears each worker leave, whatever ends it.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the tellings of what each worker's watches ask go: they go `TELL_MS` apart at most. */
const told = () => vi.advanceTimersByTime(TELL_MS);

/** What the instance asks of a worker's images, the layers its full views ask beside them, and whether one inspects. */
const view = (width: number, height: number, fps: number, full: boolean, layers: string[] = [], inspect = false) => ({
  type: 'view',
  width,
  height,
  fps,
  full,
  layers,
  inspect,
});

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

describe('the layers of a worker', () => {
  const AT = 1_800_000_000_000;
  const event = (worker: number): LiveRelayMessage => ({
    type: 'page-event',
    shard: null,
    worker,
    event: { kind: 'page-error', text: 'boom' },
    at: AT,
    test: 'pays',
  });
  const text = (worker: number): LiveRelayMessage => ({
    type: 'text',
    shard: null,
    worker,
    text: { call: null, source: 'snapshot', text: '- heading "Shop"', cut: false, at: AT },
    test: 'pays',
  });
  const thumb = (worker: number, n: number): LiveRelayMessage => ({
    type: 'thumb',
    shard: null,
    worker,
    thumb: { call: `pw:api@${n}`, title: 'Click', index: n, width: 320, height: 200, at: AT },
    image: image(n),
    test: 'pays',
  });

  test('go to the full views that asked for each alone, the worker hearing what they ask together', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => worker);
    const [events, texts, none, tiles] = [new FakeSink(), new FakeSink(), new FakeSink(), new FakeSink()];
    const focus = { shard: null, worker: 0 };
    watch(live, 7, focus, events, null, { layers: ['events', 'calls', 'filmstrip'] });
    watch(live, 7, focus, texts, null, { layers: ['text'] });
    watch(live, 7, focus, none);
    watch(live, 7, null, tiles, null, { tiles: true, layers: ['events', 'text', 'filmstrip'] });
    told();
    expect(worker.sent.filter((m) => (m as { type: string }).type === 'view').at(-1)).toEqual(
      view(640, 400, LIVE_FRAME_FPS, true, ['events', 'text', 'filmstrip']),
    );

    expect(live.receive(7, event(0))).toBeNull();
    expect(live.receive(7, text(0))).toBeNull();
    expect(live.receive(7, thumb(0, 1))).toBeNull();
    expect(got(events)).toEqual([{ ...event(0) }, { ...thumb(0, 1) }]);
    expect(got(texts)).toEqual([{ ...text(0) }]);
    expect(got(none)).toEqual([]);
    // A tile shows a worker's images alone, never its layers.
    expect(got(tiles).filter((m) => (m as { type: string }).type !== 'refused')).toEqual([]);
    // An image of the filmstrip is charged to the run's bytes as a frame is: past them, a frame is refused.
    const rest = new Uint8Array(MAX_LIVE_BYTES_PER_RUN - image(1).length);
    expect(live.receive(7, { ...thumb(0, 2), image: rest } as LiveRelayMessage)).toBeNull();
    expect(live.receive(7, frame(0, image(3)))).toMatchObject({ status: 429 });
    expect(live.countsFor(7)).toMatchObject({ frames: 0 });
  });

  test('send a page event while an image waits for the watch’s bytes, and the filmstrip’s images in their order once it may', () => {
    let now = 1_000_000;
    const { live } = relay(() => now);
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink());
    const page = new FakeSink();
    watch(live, 7, { shard: null, worker: 0 }, page, null, { layers: ['events', 'filmstrip'] });
    const heavy = (n: number) => {
      const bytes = new Uint8Array(MAX_WATCH_BYTES_PER_SECOND / 2).fill(n);
      bytes.set([0xff, 0xd8, 0xff, 0xe0, n]);
      return bytes;
    };
    for (const n of [1, 2, 3]) live.receive(7, frame(0, heavy(n)));
    // The watch's bytes of this second are spent, and the third frame waits: an event goes at once all the same.
    live.receive(7, event(0));
    live.receive(7, thumb(0, 4));
    live.receive(7, thumb(0, 5));
    const heard = () =>
      got(page).map((m) => {
        const message = m as { type: string; image?: Uint8Array };
        return message.image ? `${message.type} ${message.image[4]}` : message.type;
      });
    expect(heard()).toEqual(['frame 1', 'frame 2', 'page-event']);
    now += 1000;
    vi.advanceTimersByTime(250);
    expect(heard()).toEqual(['frame 1', 'frame 2', 'page-event', 'frame 3', 'thumb 4', 'thumb 5']);
  });

  test('count the page events a backed up watch could not take, and say how many as it reads again', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink());
    const page = new FakeSink();
    watch(live, 7, { shard: null, worker: 0 }, page, null, { layers: ['events'] });
    page.full = true;
    for (let i = 0; i < 3; i++) live.receive(7, event(0));
    expect(got(page)).toEqual([]);
    page.drain();
    live.receive(7, event(0));
    expect(got(page)).toEqual([
      { type: 'page-event', shard: null, worker: 0, event: { kind: 'dropped', count: 3 }, at: AT, test: 'pays' },
      { ...event(0) },
    ]);
  });

  test('send the strip again to a watch that takes the filmstrip anew, and not for its events or its text', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => worker);
    const [first, second] = [new FakeSink(), new FakeSink()];
    watch(live, 7, { shard: null, worker: 0 }, first, null, { layers: ['events', 'text', 'filmstrip'] });
    watch(live, 7, { shard: null, worker: 0 }, second);
    told();
    const id = (second.sent[0] as { watch: string }).watch;
    const resends = () => worker.sent.filter((m) => (m as { type: string }).type === 'resend').length;
    const before = resends();
    live.changeWatch(7, id, null, { layers: ['events'] });
    told();
    vi.advanceTimersByTime(1000);
    live.changeWatch(7, id, null, { layers: ['events', 'text'] });
    told();
    expect(resends()).toBe(before);
    live.changeWatch(7, id, null, { layers: ['events', 'text', 'filmstrip'] });
    told();
    expect(resends()).toBe(before + 1);
  });

  test('let a text waiting for a backed up watch go once the watch no longer takes the text', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink());
    const page = new FakeSink();
    watch(live, 7, { shard: null, worker: 0 }, page, null, { layers: ['text', 'filmstrip'] });
    const id = (page.sent[0] as { watch: string }).watch;
    page.full = true;
    live.receive(7, text(0));
    live.receive(7, thumb(0, 1));
    live.changeWatch(7, id, null, { layers: [] });
    page.drain();
    expect(got(page)).toEqual([]);
  });

  test('ask the worker for the page’s text as a watch that takes it asks, and send a watch that takes a layer anew the strip again', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => worker);
    const [first, second] = [new FakeSink(), new FakeSink()];
    watch(live, 7, { shard: null, worker: 0 }, first, null, { layers: ['filmstrip'] });
    watch(live, 7, { shard: null, worker: 0 }, second);
    told();
    const id = (second.sent[0] as { watch: string }).watch;
    // A text asked by a watch that takes no text asks nothing.
    expect(live.changeWatch(7, id, null, { text: true }).shown).toMatchObject({ layers: [] });
    expect(worker.sent.some((m) => (m as { type: string }).type === 'text')).toBe(false);
    const changed = live.changeWatch(7, id, null, { layers: ['text', 'filmstrip'], text: true });
    expect(changed.shown).toMatchObject({ layers: ['text', 'filmstrip'] });
    told();
    expect(worker.sent.filter((m) => (m as { type: string }).type === 'text')).toEqual([{ type: 'text' }]);
    // The union did not change for the filmstrip, but this watch takes it anew: the worker sends what it kept again.
    expect(worker.sent.at(-1)).toEqual({ type: 'resend' });
  });

  test('are bounded a second for each worker, and kept for nobody', () => {
    let now = 1_000_000;
    const { live } = relay(() => now);
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink());
    const viewer = new FakeSink();
    watch(live, 7, { shard: null, worker: 0 }, viewer, null, { layers: ['events', 'filmstrip'] });
    for (let i = 0; i < MAX_RELAYED_PAGE_EVENTS; i++) expect(live.receive(7, event(0))).toBeNull();
    expect(live.receive(7, event(0))).toMatchObject({ status: 429 });
    for (let i = 0; i < MAX_RELAYED_THUMBS; i++) expect(live.receive(7, thumb(0, i + 1))).toBeNull();
    expect(live.receive(7, thumb(0, 99))).toMatchObject({ status: 429 });
    // A viewer whose stream is backed up gets no event nor image meanwhile: the image waits, the event is counted.
    viewer.full = true;
    const before = got(viewer).length;
    now += 1000;
    expect(live.receive(7, event(0))).toBeNull();
    expect(live.receive(7, thumb(0, 100))).toBeNull();
    expect(got(viewer)).toHaveLength(before);
    viewer.drain();
    expect(got(viewer).slice(before)).toEqual([
      { ...thumb(0, 100) },
      { type: 'page-event', shard: null, worker: 0, event: { kind: 'dropped', count: 1 }, at: AT, test: 'pays' },
    ]);
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
      view(LIVE_FRAME_WIDTH, LIVE_FRAME_HEIGHT, LIVE_FRAME_FPS, false),
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
    told();
    expect(workers[0]!.sent.slice(-2)).toEqual([view(1000, 640, LIVE_FRAME_FPS, true), { type: 'viewers', count: 1 }]);
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
    told();
    expect(workers[0]!.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
    expect(live.viewersOf(7)).toBe(0);
  });

  test('tells a worker what its watches ask once for the changes that come together', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => worker);
    told();
    const before = worker.sent.length;
    // Several watches open, one changes its size and another leaves: the worker hears what they ask now, once.
    const sinks = [new FakeSink(), new FakeSink(), new FakeSink()];
    for (const sink of sinks) watch(live, 7, { shard: null, worker: 0 }, sink);
    const id = (sinks[0]!.sent[0] as { watch: string }).watch;
    live.changeWatch(7, id, null, { size: { width: 900, height: 600 } });
    sinks[2]!.close();
    // The first change goes at once.
    expect(worker.sent.slice(before)).toEqual([view(640, 400, LIVE_FRAME_FPS, true), { type: 'viewers', count: 1 }]);
    told();
    expect(worker.sent.slice(before + 2)).toEqual([
      view(900, 600, LIVE_FRAME_FPS, true),
      { type: 'viewers', count: 2 },
    ]);
    told();
    expect(worker.sent).toHaveLength(before + 4);
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
    for (let worker = 0; worker < 4; worker++) {
      live.connectWorker(entry, { shard: null, worker }, () => new FakeSink());
      watch(live, 7, { shard: null, worker }, new FakeSink());
    }
    const heavy = new Uint8Array(MAX_LIVE_BYTES_PER_RUN / 4).fill(1);
    for (let worker = 0; worker < 4; worker++) expect(live.receive(7, frame(worker, heavy))).toBeNull();
    expect(live.receive(7, frame(0, image(1)))).toMatchObject({ status: 429, message: expect.stringMatching(/MB/) });
    // Why no image shows is no image: it goes.
    expect(live.receive(7, { type: 'frame', shard: null, worker: 1, refused: 'No page yet.' })).toBeNull();
    now += 1000;
    expect(live.receive(7, frame(0, image(1)))).toBeNull();
  });

  test('charges the run nothing for a frame nobody receives: of a worker nobody watches, or past a tile’s pace or size', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    for (let worker = 0; worker < 3; worker++) live.connectWorker(entry, { shard: null, worker }, () => new FakeSink());
    // Nobody watches worker 0: a frame of the run's whole rate goes nowhere, and takes none of it.
    expect(live.receive(7, frame(0, new Uint8Array(MAX_LIVE_BYTES_PER_RUN).fill(1)))).toBeNull();
    expect(live.receive(7, frame(0, new Uint8Array(MAX_LIVE_BYTES_PER_RUN).fill(1)))).toBeNull();
    const page = new FakeSink();
    watch(live, 7, null, page, null, { tiles: true });
    // A worker only tiles show: frames past a tile's pace, as an older reporter sends four a second, go nowhere.
    const tile = new Uint8Array(MAX_LIVE_TILE_FRAME).fill(2);
    tile.set([0xff, 0xd8, 0xff]);
    for (let i = 0; i < MAX_RELAYED_FPS; i++) expect(live.receive(7, frame(1, tile))).toBeNull();
    // A frame larger than a tile carries goes nowhere either: the tile says why.
    expect(live.receive(7, frame(2, new Uint8Array(MAX_LIVE_TILE_FRAME + 1).fill(3)))).toBeNull();
    const shown = got(page) as Array<{ type: string; worker: number; message?: string }>;
    expect(shown.filter((m) => m.worker === 1 && m.type === 'frame')).toHaveLength(1);
    expect(shown.filter((m) => m.worker === 2)).toEqual([
      { type: 'refused', shard: null, worker: 2, message: TILE_TOO_LARGE },
    ]);
    // What the run was charged: the tiles taken at their pace alone.
    const viewer = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 3 }, () => new FakeSink());
    watch(live, 7, { shard: null, worker: 3 }, viewer);
    const rest = MAX_LIVE_BYTES_PER_RUN - MAX_RELAYED_TILE_FPS * tile.length;
    expect(live.receive(7, frame(3, new Uint8Array(rest).fill(4)))).toBeNull();
    expect(live.receive(7, frame(3, image(1)))).toMatchObject({ status: 429 });
    // Every frame taken is counted, whoever received it.
    expect(live.countsFor(7).frames).toBe(2 + MAX_RELAYED_FPS + 1 + 1);
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
      view(LIVE_FRAME_WIDTH, LIVE_FRAME_HEIGHT, LIVE_FRAME_FPS, true),
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
    told();
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
    told();
    expect(worker.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });
    live.receive(7, { type: 'ended', shard: null, worker: 0 });
    expect(got(watching)).toEqual([{ type: 'end', shard: null, worker: 0, reason: 'test-ended' }]);
    told();
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
    told();
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
    told();
    expect(first.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });
    const second = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 1, slot: 0 }, () => second);
    told();
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
    told();
    expect(worker.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });
    live.receive(8, { type: 'stop', shard: null, worker: 0, stop: STOP });
    expect(live.receive(8, { type: 'unshared', shard: null, worker: 0 })).toBeNull();
    expect(got(watching)).toEqual([{ type: 'end', shard: null, worker: 0, reason: 'unshared' }]);
    told();
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
      told();
      expect(workers[0]!.sent.slice(-2)).toEqual([
        view(LIVE_TILE_WIDTH, LIVE_TILE_HEIGHT, LIVE_TILE_FPS, false),
        { type: 'viewers', count: 1 },
      ]);
      expect(workers[1]!.sent.slice(-2)).toEqual([
        view(1280, 800, LIVE_FRAME_FPS, true),
        { type: 'viewers', count: 1 },
      ]);

      for (const n of [1, 2, 3]) {
        live.receive(7, { ...frame(0, image(n)), slot: 0 });
        live.receive(7, { ...frame(1, image(n)), slot: 1 });
      }
      // The worker in full: each frame. A tile: its first at once, the latest of the rest a second later; a frame of
      // a worker only tiles show, past a tile's pace, goes nowhere.
      const frames = (worker: number) =>
        got(page).filter((m) => (m as { worker?: number }).worker === worker) as Array<{ image: Uint8Array }>;
      expect(frames(1).map((m) => m.image)).toEqual([image(1), image(2), image(3)]);
      expect(frames(0).map((m) => m.image)).toEqual([image(1)]);
      vi.advanceTimersByTime(1000);
      expect(frames(0).map((m) => m.image)).toEqual([image(1), image(2)]);
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
    told();
    expect(workers[0]!.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });

    // Another lane in full: the first hears nobody watches, the second that it is watched.
    expect(live.changeWatch(7, id, 3, { focus: { shard: null, worker: 1, slot: 1 } })).toEqual({
      refused: null,
      shown: {
        focus: { shard: null, worker: 1, slot: 1 },
        tiles: false,
        width: 640,
        height: 400,
        layers: [],
        inspect: false,
      },
    });
    told();
    expect(workers[0]!.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
    expect(workers[1]!.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });
    live.receive(7, { ...frame(0, image(1)), slot: 0 });
    live.receive(7, { ...frame(1, image(2)), slot: 1 });
    expect(got(page)).toEqual([expect.objectContaining({ worker: 1, image: image(2) })]);

    // A larger view: the worker hears the size, and nothing else changes.
    told();
    live.changeWatch(7, id, 3, { size: { width: 900, height: 600 } });
    expect(workers[1]!.sent.at(-1)).toEqual(view(900, 600, LIVE_FRAME_FPS, true));

    // Tiles on, then the full view off: every worker takes tiles alone.
    told();
    live.changeWatch(7, id, 3, { tiles: true });
    told();
    expect(workers[0]!.sent.slice(-2)).toEqual([
      view(LIVE_TILE_WIDTH, LIVE_TILE_HEIGHT, LIVE_TILE_FPS, false),
      { type: 'viewers', count: 1 },
    ]);
    told();
    expect(live.changeWatch(7, id, 3, { focus: null }).shown).toEqual({
      focus: null,
      tiles: true,
      width: 900,
      height: 600,
      layers: [],
      inspect: false,
    });
    told();
    expect(workers[1]!.sent.at(-1)).toEqual(view(LIVE_TILE_WIDTH, LIVE_TILE_HEIGHT, LIVE_TILE_FPS, false));
    told();
    live.changeWatch(7, id, 3, { tiles: false });
    told();
    expect(workers.map((sink) => sink.sent.at(-1))).toEqual([
      { type: 'viewers', count: 0 },
      { type: 'viewers', count: 0 },
    ]);

    // Refused, the watch stays as it was and says nothing of it: another person's, another run's, an unknown one.
    told();
    for (const [runId, watchId, person] of [
      [7, id, 4],
      [8, id, 3],
      [7, 'unknown', 3],
    ] as const) {
      expect(live.changeWatch(runId, watchId, person, { tiles: true })).toEqual({
        refused: { status: 404, message: 'No such watch of this run.' },
        shown: null,
      });
    }
    told();
    expect(workers.map((sink) => sink.sent.at(-1))).toEqual([
      { type: 'viewers', count: 0 },
      { type: 'viewers', count: 0 },
    ]);
  });

  test('refuses a full view of a worker not in the live view, applying the rest and saying what the watch shows', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0, slot: 0 }, () => worker);
    const page = new FakeSink();
    watch(live, 7, { shard: null, worker: 0, slot: 0 }, page);
    const id = (page.sent[0] as { watch: string }).watch;
    told();
    expect(
      live.changeWatch(7, id, null, {
        focus: { shard: null, worker: 9 },
        tiles: true,
        size: { width: 800, height: 500 },
      }),
    ).toEqual({
      refused: { status: 404, message: 'This worker is not in the live view of the run.' },
      shown: { focus: null, tiles: true, width: 800, height: 500, layers: [], inspect: false },
    });
    // The worker shown before takes a tile now, for the same watch.
    told();
    expect(worker.sent.at(-1)).toEqual(view(LIVE_TILE_WIDTH, LIVE_TILE_HEIGHT, LIVE_TILE_FPS, false));
    expect(worker.sent.filter((m) => (m as { type: string }).type === 'viewers').at(-1)).toEqual({
      type: 'viewers',
      count: 1,
    });
  });

  test('takes a watch’s changes a few times a second at most', () => {
    let now = 1_000_000;
    const { live } = relay(() => now);
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink());
    const page = new FakeSink();
    watch(live, 7, null, page, null, { tiles: true });
    const id = (page.sent[0] as { watch: string }).watch;
    for (let i = 0; i < MAX_WATCH_CHANGES_PER_SECOND; i++) {
      expect(live.changeWatch(7, id, null, { tiles: i % 2 === 1 }).refused).toBeNull();
    }
    expect(live.changeWatch(7, id, null, { tiles: true })).toEqual({
      refused: { status: 429, message: expect.stringMatching(/a second at most/) },
      shown: null,
    });
    now += 1000;
    expect(live.changeWatch(7, id, null, { tiles: true }).refused).toBeNull();
  });

  test('asks a worker for its latest image and call log again as a watch that showed it as a tile shows it in full', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0, slot: 0 }, () => worker);
    // Someone watches the worker in full; another page shows it as a tile.
    watch(live, 7, { shard: null, worker: 0, slot: 0 }, new FakeSink());
    const page = new FakeSink();
    watch(live, 7, null, page, null, { tiles: true });
    const id = (page.sent[0] as { watch: string }).watch;
    told();
    expect(worker.sent.slice(-2)).toEqual([view(640, 400, LIVE_FRAME_FPS, true), { type: 'viewers', count: 2 }]);
    // The tile becomes a full view: neither the count nor what they ask changes, so the worker is asked again.
    told();
    const before = worker.sent.length;
    live.changeWatch(7, id, null, { focus: { shard: null, worker: 0, slot: 0 } });
    told();
    expect(worker.sent.slice(before)).toEqual([{ type: 'resend' }]);
    // A watch that comes changes the count, which the worker hears as a further viewer: nothing more is asked.
    told();
    const more = worker.sent.length;
    watch(live, 7, { shard: null, worker: 0, slot: 0 }, new FakeSink());
    told();
    expect(worker.sent.slice(more)).toEqual([{ type: 'viewers', count: 3 }]);
  });

  test('waits for a lane whose worker starts again as a watch asks for it, as the lane’s followers do', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const first = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0, slot: 0 }, () => first);
    const page = new FakeSink();
    watch(live, 7, null, page, null, { tiles: true });
    const id = (page.sent[0] as { watch: string }).watch;
    // Nobody followed the lane as its worker left: a watch that asks for it now waits too.
    first.close();
    const waiting = {
      refused: null,
      shown: {
        focus: { shard: null, worker: 0, slot: 0 },
        tiles: true,
        width: 640,
        height: 400,
        layers: [],
        inspect: false,
      },
    };
    expect(live.changeWatch(7, id, null, { focus: { shard: null, worker: 0, slot: 0 } })).toEqual(waiting);
    const opened = new FakeSink();
    expect(watch(live, 7, { shard: null, worker: 0, slot: 0 }, opened)).toBeNull();
    const restarting = { type: 'refused', shard: null, worker: 0, slot: 0, message: LANE_RESTARTING };
    expect(got(page).at(-1)).toEqual(restarting);
    expect(got(opened)).toEqual([restarting]);
    // The worker Playwright starts in the lane takes both, and hears it is watched.
    const second = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 4, slot: 0 }, () => second);
    expect(second.sent.at(-1)).toEqual({ type: 'viewers', count: 2 });
    live.receive(7, { ...frame(4, image(1)), slot: 0 });
    expect(got(opened).at(-1)).toMatchObject({ type: 'frame', worker: 4 });
    expect(got(page).at(-1)).toMatchObject({ type: 'frame', worker: 4 });
    // A worker of no lane, or a lane nobody held, is not waited for.
    expect(watch(live, 7, { shard: null, worker: 0 }, new FakeSink())).toMatchObject({ status: 404 });
    expect(watch(live, 7, { shard: null, worker: 0, slot: 5 }, new FakeSink())).toMatchObject({ status: 404 });
  });

  test('refuses a watch of a run that ended, as the run ends while its route opens the watch', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink());
    live.endRun(7);
    let opened = false;
    const open = () => {
      opened = true;
      return new FakeSink();
    };
    expect(live.openWatch(7, 1, { focus: null, tiles: true }, open)).toEqual({
      status: 410,
      message: 'The run is no longer live.',
    });
    expect(opened).toBe(false);
    expect(live.viewersOf(7)).toBe(0);
    // A project that turned its live view off may turn it on again: its runs take watches then.
    live.endProject(1);
    expect(live.openWatch(9, 1, { focus: null, tiles: true }, open)).toBeNull();
  });

  test('sends a watch its bytes of images a second at most, the latest waiting for the next second', () => {
    let now = 1_000_000;
    const { live } = relay(() => now);
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink());
    const page = new FakeSink();
    watch(live, 7, { shard: null, worker: 0 }, page);
    const heavy = (n: number) => {
      const bytes = new Uint8Array(MAX_WATCH_BYTES_PER_SECOND / 2).fill(n);
      bytes.set([0xff, 0xd8, 0xff]);
      return bytes;
    };
    for (const n of [1, 2, 3, 4]) live.receive(7, frame(0, heavy(n)));
    const images = () => got(page).map((m) => (m as { image: Uint8Array }).image[3]);
    expect(images()).toEqual([1, 2]);
    now += 1000;
    vi.advanceTimersByTime(250);
    expect(images()).toEqual([1, 2, 4]);
  });

  test('a tile carries an image of a tile’s size alone, saying why a larger one does not show', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink());
    watch(live, 7, { shard: null, worker: 0 }, new FakeSink());
    const page = new FakeSink();
    watch(live, 7, null, page, null, { tiles: true });
    const large = new Uint8Array(MAX_LIVE_TILE_FRAME + 1).fill(1);
    large.set([0xff, 0xd8, 0xff]);
    expect(live.receive(7, frame(0, large))).toBeNull();
    expect(got(page)).toEqual([{ type: 'refused', shard: null, worker: 0, message: TILE_TOO_LARGE }]);
    vi.advanceTimersByTime(1000);
    live.receive(7, frame(0, image(1)));
    expect(got(page).at(-1)).toMatchObject({ type: 'frame', image: image(1) });
  });

  test('ends a watch whose stream stays backed up, which its page reads no more', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => worker);
    const slow = new FakeSink();
    watch(live, 7, { shard: null, worker: 0 }, slow);
    slow.full = true;
    live.receive(7, frame(0, image(1)));
    vi.advanceTimersByTime(WATCH_STALL_MS - 1);
    expect(slow.closed).toBe(false);
    // One that reads again in time stays.
    slow.drain();
    expect(got(slow)).toEqual([expect.objectContaining({ image: image(1) })]);
    vi.advanceTimersByTime(WATCH_STALL_MS);
    expect(slow.closed).toBe(false);
    slow.full = true;
    live.receive(7, frame(0, image(2)));
    vi.advanceTimersByTime(WATCH_STALL_MS);
    expect(slow.closed).toBe(true);
    expect(live.viewersOf(7)).toBe(0);
    told();
    expect(worker.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
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
      view(LIVE_TILE_WIDTH, LIVE_TILE_HEIGHT, LIVE_TILE_FPS, false),
      { type: 'viewers', count: 1 },
    ]);
    page.close();
    told();
    expect(worker.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
    live.endRun(7);
    expect(live.viewersOf(7)).toBe(0);
  });
});

describe('Inspect', () => {
  const AT = 1_800_000_000_000;
  /** A snapshot of worker `worker`'s page, as the route reads it: a full one of the main frame unless said. */
  const snapshot = (
    worker: number,
    call: string,
    phase: 'before' | 'action' | 'after',
    options: { main?: boolean; full?: boolean; bytes?: number; slot?: number } = {},
  ): LiveRelayMessage => ({
    type: 'snapshot',
    shard: null,
    worker,
    ...(options.slot === undefined ? {} : { slot: options.slot }),
    snapshot: {
      call,
      title: `Click ${call}`,
      phase,
      page: 'page@1',
      frame: options.main === false ? 'frame@2' : 'frame@1',
      main: options.main ?? true,
      full: options.full ?? true,
      index: options.full === false ? 1 : 0,
      at: AT,
      resources: [{ url: 'https://shop.test/app.css', sha1: `${'a'.repeat(40)}.css` }],
    },
    data: new TextEncoder().encode(
      JSON.stringify({ html: ['HTML', {}, ['BODY', {}, options.bytes ? 'x'.repeat(options.bytes) : call]] }),
    ),
    test: 'pays',
  });
  /** What a watch hears of that snapshot: its header, without its JSON nor the resources it names. */
  const notice = (worker: number, call: string, phase: string, slot?: number) => ({
    type: 'snapshot',
    shard: null,
    worker,
    ...(slot === undefined ? {} : { slot }),
    call,
    title: `Click ${call}`,
    phase,
    page: 'page@1',
    frame: 'frame@1',
    main: true,
    full: true,
    index: 0,
    at: AT,
    test: 'pays',
  });
  const notices = (sink: FakeSink) => got(sink).filter((m) => (m as { type: string }).type === 'snapshot');
  const lastView = (worker: FakeSink) => worker.sent.filter((m) => (m as { type: string }).type === 'view').at(-1);

  test('tells a worker whether a full view inspects it, and the watches that inspect it of each snapshot alone', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => worker);
    const [inspecting, watching] = [new FakeSink(), new FakeSink()];
    const focus = { shard: null, worker: 0 };
    watch(live, 7, focus, watching);
    told();
    expect(lastView(worker)).toEqual(view(640, 400, LIVE_FRAME_FPS, true));
    watch(live, 7, focus, inspecting, null, { inspect: true });
    told();
    expect(lastView(worker)).toEqual(view(640, 400, LIVE_FRAME_FPS, true, [], true));

    expect(live.receive(7, snapshot(0, 'call@1', 'before'))).toBeNull();
    // Another frame's snapshot is not told, nor kept; the same moment again is told once.
    expect(live.receive(7, snapshot(0, 'call@1', 'before', { main: false }))).toBeNull();
    expect(live.receive(7, snapshot(0, 'call@1', 'before'))).toBeNull();
    expect(notices(inspecting)).toEqual([notice(0, 'call@1', 'before')]);
    expect(notices(watching)).toEqual([]);
    // Why the worker sends no snapshot reaches the watches that inspect it.
    live.receive(7, {
      type: 'snapshot',
      shard: null,
      worker: 0,
      refused: 'This project masks elements.',
      test: 'pays',
    });
    expect(notices(inspecting).at(-1)).toEqual({
      type: 'snapshot',
      shard: null,
      worker: 0,
      refused: 'This project masks elements.',
      test: 'pays',
    });

    // The last watch that inspects it closes Inspect: the worker hears so.
    const id = (inspecting.sent[0] as { watch: string }).watch;
    expect(live.changeWatch(7, id, null, { inspect: false }).shown).toMatchObject({ inspect: false });
    told();
    expect(lastView(worker)).toEqual(view(640, 400, LIVE_FRAME_FPS, true));
  });

  test('tells a watch that opens Inspect, or follows its lane to a new worker, the snapshots kept of that worker', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: null, worker: 0, slot: 0 }, () => new FakeSink());
    live.receive(7, snapshot(0, 'call@1', 'before', { slot: 0 }));
    live.receive(7, snapshot(0, 'call@1', 'after', { slot: 0, full: false }));
    const page = new FakeSink();
    watch(live, 7, { shard: null, worker: 0, slot: 0 }, page);
    expect(notices(page)).toEqual([]);
    const id = (page.sent[0] as { watch: string }).watch;
    live.changeWatch(7, id, null, { inspect: true });
    expect(notices(page)).toEqual([
      notice(0, 'call@1', 'before', 0),
      { ...notice(0, 'call@1', 'after', 0), full: false, index: 1 },
    ]);
    // The lane's worker starts again, and has sent a snapshot before the watch came to it.
    const next = live.authorize(7, live.mintKey(7, 1))!;
    live.receive(7, snapshot(0, 'call@1', 'before', { slot: 0 }));
    live.connectWorker(next, { shard: null, worker: 1, slot: 0 }, () => new FakeSink());
    live.receive(7, snapshot(1, 'call@9', 'before', { slot: 0 }));
    expect(notices(page).at(-1)).toEqual(notice(1, 'call@9', 'before', 0));
  });

  test('holds back the notices of a backed up watch, in their order', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink());
    const page = new FakeSink();
    watch(live, 7, { shard: null, worker: 0 }, page, null, { inspect: true });
    page.full = true;
    for (const call of ['call@1', 'call@2', 'call@3']) live.receive(7, snapshot(0, call, 'before'));
    expect(notices(page)).toEqual([]);
    page.drain();
    expect(notices(page).map((m) => (m as { call: string }).call)).toEqual(['call@1', 'call@2', 'call@3']);
  });

  test('bounds a worker’s snapshots a second, and charges them and the resources to the run’s bytes', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink());
    live.connectWorker(entry, { shard: null, worker: 1 }, () => new FakeSink());
    for (let i = 0; i < MAX_RELAYED_SNAPSHOTS; i++) {
      expect(live.receive(7, snapshot(0, `call@${i}`, 'before'))).toBeNull();
    }
    expect(live.receive(7, snapshot(0, 'call@99', 'before'))).toMatchObject({ status: 429 });
    const resource: LiveRelayMessage = {
      type: 'resource',
      shard: null,
      worker: 1,
      resource: { sha1: `${'b'.repeat(40)}.png`, contentType: 'image/png' },
      data: new Uint8Array(MAX_LIVE_BYTES_PER_RUN - 2000),
    };
    expect(live.receive(7, resource)).toBeNull();
    expect(live.receive(7, snapshot(1, 'call@1', 'before', { bytes: 4096 }))).toMatchObject({ status: 429 });
  });

  test('serves what it keeps to its own person’s watch with Inspect open alone, and drops it with the run', async () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink());
    const [inspecting, watching] = [new FakeSink(), new FakeSink()];
    watch(live, 7, { shard: null, worker: 0 }, inspecting, 3, { inspect: true });
    watch(live, 7, { shard: null, worker: 0 }, watching, 3);
    const id = (sink: FakeSink) => (sink.sent[0] as { watch: string }).watch;
    live.receive(7, snapshot(0, 'call@1', 'after'));
    const kept = live.inspectOf(7, id(inspecting), 3);
    if ('status' in kept) throw new Error(kept.message);
    expect(await kept.render(':0', 'call@1', 'after')).toMatchObject({
      html: '<html><body>call@1</body></html>',
    });
    expect(live.inspectOf(7, id(inspecting), 4)).toMatchObject({ status: 404 });
    expect(live.inspectOf(8, id(inspecting), 3)).toMatchObject({ status: 404 });
    expect(live.inspectOf(7, id(watching), 3)).toMatchObject({ status: 409 });
    live.endRun(7);
    expect(live.inspectOf(7, id(inspecting), 3)).toMatchObject({ status: 410 });
  });
});
