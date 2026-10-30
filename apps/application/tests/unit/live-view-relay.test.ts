import { describe, expect, test } from 'vitest';
import { LIVE_VIEW_KEY_PREFIX, type WorkerToInstance } from '@piwitests/core/live-view';
import type { LiveWorkerState } from '#shared/live-view';
import {
  LIVE_KEY_TTL_MS,
  LiveViewRelay,
  MAX_LIVE_KEYS,
  MAX_LIVE_KEYS_PER_PROJECT,
  MAX_LIVE_VIEWERS_PER_PERSON,
  MAX_LIVE_VIEWERS_PER_RUN,
  MAX_LIVE_WORKERS_PER_RUN,
  MAX_RELAYED_FPS,
} from '../../server/utils/live-view';
import type { EventStreamSink } from '../../server/utils/event-stream';
import { runEventBus } from '../../server/utils/run-events';

/**
 * The relay between a live run's workers and the people watching them: a key opens its own run's view alone and not
 * after it expired or the run ended, survives the run's interruption, and no project's keys push another's out;
 * frames reach the viewers of their worker and nobody else, are kept nowhere, the latest alone while a viewer reads
 * slowly; workers, viewers (per run and per person) and frames a second are bounded; a stop reaches the run page and
 * survives the worker's new stream; and the run page hears each worker leave, whatever ends it.
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

const frame = (worker: number, data = '/9j/', shard: number | null = null): WorkerToInstance => ({
  type: 'frame',
  shard,
  worker,
  data,
  call: { title: 'Click', file: 'tests/a.spec.ts', line: 4 },
  test: 'pays',
});

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
      live.addViewer(12, { shard: null, worker: 0 }, () => viewer);
      runEventBus.publishGlobal({ type: 'run-finished', runId: 12, projectId: 1, status: 'interrupted' });
      expect(worker.closed).toBe(true);
      expect(viewer.sent).toEqual([{ type: 'end', reason: 'run-ended' }]);
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
  test('tells a worker how many watch it, and relays its frames to its viewers alone', () => {
    const { live, published } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const workers = [new FakeSink(), new FakeSink()];
    expect(live.connectWorker(entry, { shard: null, worker: 0 }, () => workers[0]!)).toBeNull();
    expect(live.connectWorker(entry, { shard: null, worker: 1 }, () => workers[1]!)).toBeNull();
    expect(workers[0]!.sent).toEqual([{ type: 'viewers', count: 0 }]);
    expect(published.map((p) => p.state)).toEqual([
      { shard: null, worker: 0, connected: true, paused: null },
      { shard: null, worker: 1, connected: true, paused: null },
    ]);

    // Nobody watches: a frame goes nowhere, and is not kept for a viewer that comes later.
    expect(live.receive(7, frame(0, 'AAAA'))).toBeNull();
    const viewer = new FakeSink();
    expect(live.addViewer(7, { shard: null, worker: 0 }, () => viewer)).toBeNull();
    expect(workers[0]!.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });
    expect(viewer.sent).toEqual([]);

    live.receive(7, frame(0, 'BBBB'));
    live.receive(7, frame(1, 'CCCC'));
    expect(viewer.sent).toEqual([
      { type: 'frame', data: 'BBBB', call: { title: 'Click', file: 'tests/a.spec.ts', line: 4 }, test: 'pays' },
    ]);
    expect(live.countsFor(7)).toMatchObject({ frames: 3 });

    viewer.close();
    expect(workers[0]!.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
  });

  test('gives a viewer that reads slowly the latest frame alone, once it drains', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    live.connectWorker(entry, { shard: 2, worker: 0 }, () => new FakeSink());
    const viewer = new FakeSink();
    live.addViewer(7, { shard: 2, worker: 0 }, () => viewer);
    viewer.full = true;
    for (const data of ['AAAA', 'BBBB', 'CCCC']) live.receive(7, frame(0, data, 2));
    expect(viewer.sent).toEqual([]);
    viewer.drain();
    expect(viewer.sent).toEqual([expect.objectContaining({ type: 'frame', data: 'CCCC' })]);
    viewer.drain();
    expect(viewer.sent).toHaveLength(1);
  });

  test('relays a worker’s call log to its viewers alone, at its own rate, a slow viewer keeping its frame too', () => {
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
    const callLog = (worker: number): WorkerToInstance => ({
      type: 'call-log',
      shard: null,
      worker,
      log,
      test: 'pays',
    });
    const viewer = new FakeSink();
    live.addViewer(7, { shard: null, worker: 0 }, () => viewer);
    expect(live.receive(7, callLog(0))).toBeNull();
    expect(live.receive(7, callLog(1))).toBeNull();
    expect(viewer.sent).toEqual([{ type: 'call-log', log, test: 'pays' }]);

    // A viewer that reads slowly gets the latest frame and the latest call log once it drains: neither pushes the other out.
    viewer.full = true;
    live.receive(7, frame(0, 'AAAA'));
    live.receive(7, callLog(0));
    viewer.drain();
    expect(viewer.sent.slice(1).map((m) => (m as { type: string }).type)).toEqual(['frame', 'call-log']);

    // A message that comes while older ones still wait goes after them: never a stale one after it.
    viewer.full = true;
    live.receive(7, { ...callLog(0), log: { ...log, status: 'passed' } } as WorkerToInstance);
    viewer.full = false;
    live.receive(7, callLog(0));
    expect(viewer.sent).toHaveLength(3);
    viewer.drain();
    expect(viewer.sent.slice(3)).toEqual([{ type: 'call-log', log, test: 'pays' }]);
    viewer.sent.splice(3);

    // Why no image shows takes the image's place: the latest of the two alone reaches a slow viewer.
    viewer.full = true;
    live.receive(7, frame(0, 'AAAA'));
    live.receive(7, { type: 'frame', shard: null, worker: 0, refused: 'The page is too heavy.' });
    live.receive(7, frame(0, 'BBBB'));
    viewer.drain();
    expect(viewer.sent.slice(3)).toEqual([expect.objectContaining({ type: 'frame', data: 'BBBB' })]);

    // Past the rate of call logs, one more is refused; frames have their own.
    let refused = null;
    for (let i = 0; i < 20 && !refused; i++) refused = live.receive(7, callLog(1));
    expect(refused).toMatchObject({ status: 429 });
    expect(live.receive(7, frame(1, 'BBBB'))).toBeNull();
  });

  test('refuses a worker past the bound, a viewer past the bound, and frames past the rate', () => {
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

    for (let i = 0; i < MAX_LIVE_VIEWERS_PER_RUN; i++) {
      expect(live.addViewer(7, { shard: null, worker: i % 3 }, () => new FakeSink())).toBeNull();
    }
    expect(live.addViewer(7, { shard: null, worker: 5 }, () => new FakeSink())).toMatchObject({ status: 429 });
    expect(live.addViewer(7, { shard: null, worker: 999 }, () => new FakeSink())).toMatchObject({ status: 404 });
    expect(live.addViewer(8, { shard: null, worker: 0 }, () => new FakeSink())).toMatchObject({ status: 404 });

    for (let i = 0; i < MAX_RELAYED_FPS; i++) expect(live.receive(7, frame(4))).toBeNull();
    expect(live.receive(7, frame(4))).toMatchObject({ status: 429 });
    expect(live.receive(7, frame(999))).toMatchObject({ status: 409 });
  });

  test('keeps the viewers and the stop of a worker that opens its stream again', () => {
    const { live, published } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const first = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => first);
    live.receive(7, { type: 'stop', shard: null, worker: 0, stop: STOP });
    const viewer = new FakeSink();
    live.addViewer(7, { shard: null, worker: 0 }, () => viewer);
    const second = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => second);
    expect(first.closed).toBe(true);
    expect(second.sent).toEqual([{ type: 'viewers', count: 1 }]);
    expect(live.workersOf(7)).toEqual([{ shard: null, worker: 0, connected: true, paused: STOP }]);
    expect(published.at(-1)?.state).toEqual({ shard: null, worker: 0, connected: true, paused: STOP });
    live.receive(7, frame(0, 'DDDD'));
    expect(viewer.sent).toEqual([expect.objectContaining({ data: 'DDDD' })]);

    // Its stream drops and opens again: still paused.
    second.close();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => new FakeSink());
    expect(live.workersOf(7)[0]?.paused).toBeNull();
  });

  test('gives one person 4 viewers of a run at most, a further one replacing their oldest', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => worker);
    live.connectWorker(entry, { shard: null, worker: 1 }, () => new FakeSink());
    const mine = Array.from({ length: MAX_LIVE_VIEWERS_PER_PERSON }, () => new FakeSink());
    for (const [i, sink] of mine.entries()) {
      expect(live.addViewer(7, { shard: null, worker: i % 2 }, () => sink, 3)).toBeNull();
    }
    const fifth = new FakeSink();
    expect(live.addViewer(7, { shard: null, worker: 1 }, () => fifth, 3)).toBeNull();
    expect(mine[0]!.sent).toEqual([{ type: 'end', reason: 'replaced' }]);
    expect(mine[0]!.closed).toBe(true);
    expect(worker.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });
    expect(mine.slice(1).every((sink) => !sink.closed)).toBe(true);

    // The run's other seats stay for other people; a person unknown (authentication off) takes any.
    for (const person of [4, 5, null]) {
      for (let i = 0; i < MAX_LIVE_VIEWERS_PER_PERSON; i++) {
        expect(live.addViewer(7, { shard: null, worker: 0 }, () => new FakeSink(), person)).toBeNull();
      }
    }
    expect(MAX_LIVE_VIEWERS_PER_PERSON * 4).toBe(MAX_LIVE_VIEWERS_PER_RUN);
    expect(live.addViewer(7, { shard: null, worker: 0 }, () => new FakeSink(), 6)).toMatchObject({ status: 429 });
    // Past the run's seats, a person at their share still replaces their own oldest.
    expect(live.addViewer(7, { shard: null, worker: 0 }, () => new FakeSink(), 3)).toBeNull();
    expect(mine[1]!.closed).toBe(true);
  });

  test('says a worker is paused at its call, then running, then gone, and ends its viewers as it leaves', () => {
    const { live, published } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 3 }, () => worker);
    const stop = {
      reason: 'page-pause' as const,
      call: { title: 'Pause', file: 'tests/a.spec.ts', line: 9 },
      test: 'pays',
    };
    live.receive(7, { type: 'stop', shard: null, worker: 3, stop });
    expect(live.workersOf(7)).toEqual([{ shard: null, worker: 3, connected: true, paused: stop }]);
    live.receive(7, { type: 'stop', shard: null, worker: 3, stop: null });
    const viewer = new FakeSink();
    live.addViewer(7, { shard: null, worker: 3 }, () => viewer);
    worker.close();
    expect(viewer.sent).toEqual([{ type: 'end', reason: 'worker-left' }]);
    expect(viewer.closed).toBe(true);
    expect(published.slice(1).map((p) => p.state.paused ?? p.state.connected)).toEqual([stop, true, false]);
    expect(live.workersOf(7)).toEqual([]);
  });

  test('ends the view as the test watched ends, and every view as the run ends or the project turns it off', () => {
    const { live, published } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => worker);
    const watching = new FakeSink();
    live.addViewer(7, { shard: null, worker: 0 }, () => watching);
    live.receive(7, { type: 'ended', shard: null, worker: 0 });
    expect(watching.sent).toEqual([{ type: 'end', reason: 'test-ended' }]);
    expect(worker.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });

    const later = new FakeSink();
    live.addViewer(7, { shard: null, worker: 0 }, () => later);
    live.receive(7, { type: 'stop', shard: null, worker: 0, stop: STOP });
    live.endProject(1);
    expect(later.sent).toEqual([{ type: 'end', reason: 'off' }]);
    expect(worker.closed).toBe(true);
    expect(live.authorize(7, 'x')).toBeNull();
    // The run page hears the worker left: no Watch, and no Paused, stays on its row.
    expect(published.at(-1)?.state).toEqual({ shard: null, worker: 0, connected: false, paused: null });
  });

  test('ends the views of a run its developer stops sharing, each viewer hearing why, before the worker leaves', () => {
    const { live, published } = relay();
    const entry = live.authorize(8, live.mintKey(8, 1))!;
    const worker = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => worker);
    const watching = new FakeSink();
    live.addViewer(8, { shard: null, worker: 0 }, () => watching);
    live.receive(8, { type: 'stop', shard: null, worker: 0, stop: STOP });
    expect(live.receive(8, { type: 'unshared', shard: null, worker: 0 })).toBeNull();
    expect(watching.sent).toEqual([{ type: 'end', reason: 'unshared' }]);
    expect(watching.closed).toBe(true);
    expect(worker.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
    // The worker closes its stream: the run page hears it left, no Paused left on its row.
    worker.close();
    expect(published.at(-1)?.state).toEqual({ shard: null, worker: 0, connected: false, paused: null });
    expect(live.workersOf(8)).toEqual([]);
  });
});
