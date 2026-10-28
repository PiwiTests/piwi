import { describe, expect, test } from 'vitest';
import { LIVE_VIEW_KEY_PREFIX, type WorkerToInstance } from '@piwitests/core/live-view';
import type { LiveWorkerState } from '#shared/live-view';
import {
  LIVE_KEY_TTL_MS,
  LiveViewRelay,
  MAX_LIVE_VIEWERS_PER_RUN,
  MAX_LIVE_WORKERS_PER_RUN,
  MAX_RELAYED_FPS,
} from '../../server/utils/live-view';
import type { EventStreamSink } from '../../server/utils/event-stream';
import { runEventBus } from '../../server/utils/run-events';

/**
 * The relay between a live run's workers and the people watching them: a key opens its own run's view alone and not
 * after it expired or the run ended; frames reach the viewers of their worker and nobody else, are kept nowhere, the
 * latest alone while a viewer reads slowly; workers, viewers and frames a second are bounded; and a stop reaches the
 * run page.
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
});

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
    live.endProject(2);
    expect(keys.some((key) => live.authorize(3, key))).toBe(false);
    expect(live.authorize(4, elsewhere)).not.toBeNull();
  });

  test('ends with its run, as the run finishes, is cancelled or interrupted', () => {
    const live = new LiveViewRelay(() => undefined);
    const stop = live.followRuns();
    try {
      for (const type of ['run-finished', 'run-cancelled', 'run-finalizing'] as const) {
        const key = live.mintKey(11, 1)!;
        runEventBus.publishGlobal({ type, runId: 11, projectId: 1 });
        expect(live.authorize(11, key), type).toBeNull();
      }
      const key = live.mintKey(11, 1)!;
      runEventBus.publishGlobal({ type: 'run-started', runId: 11, projectId: 1 });
      expect(live.authorize(11, key)).not.toBeNull();
    } finally {
      stop();
    }
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
      { type: 'frame', data: 'BBBB', call: { title: 'Click', file: 'tests/a.spec.ts', line: 4 } },
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

  test('keeps the viewers of a worker that opens its stream again', () => {
    const { live } = relay();
    const entry = live.authorize(7, live.mintKey(7, 1))!;
    const first = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => first);
    const viewer = new FakeSink();
    live.addViewer(7, { shard: null, worker: 0 }, () => viewer);
    const second = new FakeSink();
    live.connectWorker(entry, { shard: null, worker: 0 }, () => second);
    expect(first.closed).toBe(true);
    expect(second.sent).toEqual([{ type: 'viewers', count: 1 }]);
    live.receive(7, frame(0, 'DDDD'));
    expect(viewer.sent).toEqual([expect.objectContaining({ data: 'DDDD' })]);
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
    const { live } = relay();
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
    live.endProject(1);
    expect(later.sent).toEqual([{ type: 'end', reason: 'off' }]);
    expect(worker.closed).toBe(true);
    expect(live.authorize(7, 'x')).toBeNull();
  });
});
