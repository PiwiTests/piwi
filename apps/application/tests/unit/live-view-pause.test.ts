import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { LiveWorkerId } from '@piwitests/core/live-view';
import type { LiveWorkerState } from '#shared/live-view';
import { LiveViewRelay } from '../../server/utils/live-view';
import type { EventStreamSink } from '../../server/utils/event-stream';

/**
 * Pausing a CI test for its controllers, on the instance's relay: a worker that says it can pause hears beside its
 * project's hold whether its controllers may pause a CI test (`pause`), as its stream opens and as a project admin
 * changes it; **Pause**, **Resume** and **End the test** reach its stream alone, from a controller's watch that shows
 * it in full, Pause while its test is not stopped and the other two while it is paused; its paused stop reaches the
 * run page with the name of who paused it, and the workers say who can pause.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

class FakeSink implements EventStreamSink {
  sent: unknown[] = [];
  closed = false;
  private closers: Array<() => void> = [];
  send(message: unknown): void {
    if (!this.closed) this.sent.push(message);
  }
  backedUp(): boolean {
    return false;
  }
  onDrain(): void {}
  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closers.push(listener);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const close of this.closers.splice(0)) close();
  }
}

const WORKER: LiveWorkerId = { shard: null, worker: 0, slot: 0 };
const PAUSED = {
  reason: 'pause' as const,
  call: { title: "Click getByRole('button')", file: 'tests/a.spec.ts', line: 9 },
  test: 'pays',
  until: 1_000_000 + 300_000,
};
const HELD = { ...PAUSED, reason: 'held' as const };

function relay() {
  const published: Array<{ runId: number; state: LiveWorkerState }> = [];
  const live = new LiveViewRelay(
    (runId, state) => published.push({ runId, state }),
    () => 1_000_000,
  );
  return { live, published };
}

/** A worker of run 7 (project 1) that can hold and pause, or hold alone, or neither, on a sink of its own. */
function connect(
  live: LiveViewRelay,
  hold: { ms: number | null; pause: boolean } | null,
  pauses = true,
  id: LiveWorkerId = WORKER,
): FakeSink {
  const sink = new FakeSink();
  const entry = live.authorize(7, live.mintKey(7, 1)!)!;
  expect(live.connectWorker(entry, id, () => sink, [], hold, pauses)).toBeNull();
  return sink;
}

/** A page's watch of run 7, as `who` opens it. */
function watch(
  live: LiveViewRelay,
  ask: { focus?: LiveWorkerId | null; tiles?: boolean },
  who: { person: number | null; controller: boolean; name: string | null },
): string {
  const sink = new FakeSink();
  expect(
    live.openWatch(7, 1, { focus: ask.focus ?? null, tiles: ask.tiles ?? false }, () => sink, who.person, who),
  ).toBeNull();
  return (sink.sent[0] as { watch: string }).watch;
}

const ANA = { person: 1, controller: true, name: 'Ana' };
const BO = { person: 2, controller: true, name: 'Bo' };
const VIEWER = { person: 3, controller: false, name: 'Sam' };

const of = (sink: FakeSink, type: string) => sink.sent.filter((m) => (m as { type: string }).type === type);

const OTHER: LiveWorkerId = { shard: null, worker: 1, slot: 1 };
const ON = { ms: 300_000, pause: true };

describe('the project’s pause setting, on a worker’s stream', () => {
  test('goes beside the hold to a worker that can pause, and only while both settings are on', () => {
    const { live } = relay();
    expect(of(connect(live, ON), 'hold')).toEqual([{ type: 'hold', ms: 300_000, pause: true }]);
    expect(of(connect(live, { ms: 300_000, pause: false }, true, OTHER), 'hold')).toEqual([
      { type: 'hold', ms: 300_000 },
    ]);
    expect(of(connect(live, { ms: null, pause: true }, true, { shard: null, worker: 2, slot: 2 }), 'hold')).toEqual([
      { type: 'hold', ms: null },
    ]);
    // A reporter that holds and cannot pause hears the hold alone.
    expect(of(connect(live, ON, false, { shard: null, worker: 3, slot: 3 }), 'hold')).toEqual([
      { type: 'hold', ms: 300_000 },
    ]);
  });

  test('changes as a project admin changes it, and a worker that connects later hears it as it stands', () => {
    const { live } = relay();
    const pauses = connect(live, { ms: 300_000, pause: false });
    const holds = connect(live, ON, false, OTHER);
    live.setHold(1, 60_000, true);
    live.setHold(1, null, true);
    expect(of(pauses, 'hold')).toEqual([
      { type: 'hold', ms: 300_000 },
      { type: 'hold', ms: 60_000, pause: true },
      { type: 'hold', ms: null },
    ]);
    expect(of(holds, 'hold').at(-2)).toEqual({ type: 'hold', ms: 60_000 });
    live.setHold(1, 120_000, true);
    expect(of(connect(live, { ms: null, pause: false }, true, { shard: null, worker: 4, slot: 4 }), 'hold')).toEqual([
      { type: 'hold', ms: 120_000, pause: true },
    ]);
  });
});

describe('the workers the run page hears of', () => {
  test('say they can pause while their reporter can and the project lets its controllers, and as that changes', () => {
    const { live, published } = relay();
    connect(live, { ms: 300_000, pause: false });
    expect(live.workersOf(7)[0]).not.toHaveProperty('pauses');
    live.setHold(1, 300_000, true);
    expect(published.at(-1)?.state).toMatchObject({ pauses: true });
    expect(live.workersOf(7)[0]).toMatchObject({ pauses: true });
    live.setHold(1, null, true);
    expect(published.at(-1)?.state).not.toHaveProperty('pauses');
  });
});

describe('Pause, Resume and End the test', () => {
  test('reach the watched worker’s stream alone, and its paused stop names who paused it', () => {
    const { live, published } = relay();
    const sink = connect(live, ON);
    const other = connect(live, ON, true, OTHER);
    const ana = watch(live, { focus: WORKER }, ANA);
    watch(live, { focus: WORKER }, BO);
    expect(live.control(7, ana, ANA.person, WORKER, 'pause')).toEqual({ ok: true, worker: WORKER });
    expect(of(sink, 'pause')).toEqual([{ type: 'pause' }]);
    live.receive(7, { type: 'stop', ...WORKER, stop: PAUSED });
    expect(published.at(-1)?.state).toMatchObject({ paused: PAUSED, pauses: true, pausedBy: 'Ana' });
    expect(live.workersOf(7)[0]).toMatchObject({ pauses: true, pausedBy: 'Ana' });
    expect(live.control(7, ana, ANA.person, WORKER, 'resume')).toEqual({ ok: true, worker: WORKER });
    live.receive(7, { type: 'stop', ...WORKER, stop: null });
    expect(published.at(-1)?.state).not.toHaveProperty('pausedBy');
    live.control(7, ana, ANA.person, WORKER, 'pause');
    live.receive(7, { type: 'stop', ...WORKER, stop: PAUSED });
    expect(live.control(7, ana, ANA.person, WORKER, 'end')).toEqual({ ok: true, worker: WORKER });
    expect(sink.sent.filter((m) => ['pause', 'resume', 'end-test'].includes((m as { type: string }).type))).toEqual([
      { type: 'pause' },
      { type: 'resume' },
      { type: 'pause' },
      { type: 'end-test', by: 'Ana' },
    ]);
    expect(of(other, 'pause')).toEqual([]);
  });

  test('keep who paused a worker through a stream that opens again', () => {
    const { live, published } = relay();
    connect(live, ON);
    const ana = watch(live, { focus: WORKER }, ANA);
    live.control(7, ana, ANA.person, WORKER, 'pause');
    live.receive(7, { type: 'stop', ...WORKER, stop: PAUSED });
    connect(live, ON);
    expect(published.at(-1)?.state).toMatchObject({ paused: PAUSED, pausedBy: 'Ana' });
  });

  test('are refused for another person’s watch, a Viewer’s, one that shows another worker, and out of turn', () => {
    const { live } = relay();
    const sink = connect(live, ON);
    connect(live, ON, true, OTHER);
    const ana = watch(live, { focus: WORKER }, ANA);
    const sam = watch(live, { focus: WORKER }, VIEWER);
    const elsewhere = watch(live, { focus: OTHER }, BO);
    expect(live.control(7, ana, BO.person, WORKER, 'pause')).toMatchObject({ status: 404 });
    expect(live.control(8, ana, ANA.person, WORKER, 'pause')).toMatchObject({ status: 404 });
    expect(live.control(7, sam, VIEWER.person, WORKER, 'pause')).toMatchObject({
      status: 403,
      message: 'You may watch this run, not control it.',
    });
    expect(live.control(7, elsewhere, BO.person, WORKER, 'pause')).toMatchObject({ status: 409 });
    // Not paused: nothing to resume or end.
    expect(live.control(7, ana, ANA.person, WORKER, 'resume')).toMatchObject({ status: 409 });
    expect(live.control(7, ana, ANA.person, WORKER, 'end')).toMatchObject({ status: 409 });
    // Held at its failure, or paused already: no Pause.
    live.receive(7, { type: 'stop', ...WORKER, stop: HELD });
    expect(live.control(7, ana, ANA.person, WORKER, 'pause')).toMatchObject({ status: 409 });
    expect(live.control(7, ana, ANA.person, WORKER, 'resume')).toMatchObject({ status: 409 });
    live.receive(7, { type: 'stop', ...WORKER, stop: PAUSED });
    expect(live.control(7, ana, ANA.person, WORKER, 'pause')).toMatchObject({ status: 409 });
    expect(sink.sent.filter((m) => ['pause', 'resume', 'end-test'].includes((m as { type: string }).type))).toEqual([]);
  });

  test('are refused for a worker whose reporter cannot pause, saying so', () => {
    const { live } = relay();
    const sink = connect(live, ON, false);
    const ana = watch(live, { focus: WORKER }, ANA);
    expect(live.control(7, ana, ANA.person, WORKER, 'pause')).toMatchObject({
      status: 409,
      message: expect.stringMatching(/update @piwitests\/reporter/),
    });
    expect(of(sink, 'pause')).toEqual([]);
    expect(live.workersOf(7)[0]).not.toHaveProperty('pauses');
  });
});

describe('a Pause the worker has not taken yet', () => {
  test('is one at a time: a second controller’s is refused naming who asked, and the first asker names the pause', () => {
    const { live, published } = relay();
    const sink = connect(live, ON);
    const ana = watch(live, { focus: WORKER }, ANA);
    const bo = watch(live, { focus: WORKER }, BO);
    expect(live.control(7, ana, ANA.person, WORKER, 'pause')).toEqual({ ok: true, worker: WORKER });
    expect(published.at(-1)?.state).toMatchObject({ pauseAsked: { by: 'Ana' } });
    expect(live.control(7, bo, BO.person, WORKER, 'pause')).toEqual({
      status: 409,
      message: 'A Pause is already asked by Ana.',
    });
    expect(of(sink, 'pause')).toHaveLength(1);
    live.receive(7, { type: 'pause-asked', ...WORKER, waiting: true });
    live.receive(7, { type: 'stop', ...WORKER, stop: PAUSED });
    expect(published.at(-1)?.state).toMatchObject({ paused: PAUSED, pausedBy: 'Ana' });
    expect(published.at(-1)?.state).not.toHaveProperty('pauseAsked');
  });

  test('is cancelled by Resume, and the worker’s drop of one says why, Pause offered again', () => {
    const { live, published } = relay();
    const sink = connect(live, ON);
    const ana = watch(live, { focus: WORKER }, ANA);
    live.control(7, ana, ANA.person, WORKER, 'pause');
    expect(live.control(7, ana, ANA.person, WORKER, 'resume')).toEqual({ ok: true, worker: WORKER });
    expect(of(sink, 'resume')).toEqual([{ type: 'resume' }]);
    live.receive(7, { type: 'pause-asked', ...WORKER, waiting: false, why: 'Resume came before the test paused.' });
    expect(published.at(-1)?.state).toMatchObject({ pauseDropped: 'Resume came before the test paused.' });
    expect(published.at(-1)?.state).not.toHaveProperty('pauseAsked');
    expect(live.control(7, ana, ANA.person, WORKER, 'pause')).toEqual({ ok: true, worker: WORKER });
    expect(published.at(-1)?.state).not.toHaveProperty('pauseDropped');
  });

  test('End the test names who ended it to the worker', () => {
    const { live } = relay();
    const sink = connect(live, ON);
    const ana = watch(live, { focus: WORKER }, ANA);
    live.control(7, ana, ANA.person, WORKER, 'pause');
    live.receive(7, { type: 'stop', ...WORKER, stop: PAUSED });
    live.control(7, ana, ANA.person, WORKER, 'end');
    expect(of(sink, 'end-test')).toEqual([{ type: 'end-test', by: 'Ana' }]);
  });
});
