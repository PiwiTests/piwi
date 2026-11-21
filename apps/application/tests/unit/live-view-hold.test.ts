import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { LiveWorkerId } from '@piwitests/core/live-view';
import type { LiveWorkerState } from '#shared/live-view';
import { LiveViewRelay, TELL_MS } from '../../server/utils/live-view';
import type { EventStreamSink } from '../../server/utils/event-stream';

/**
 * Holding a failing CI test for its controllers, on the instance's relay: a worker that says it can hold hears its
 * project's hold as its stream opens and as a project admin changes it, and whether a controller (`run:control`)
 * shows it in full (`view`'s `controller`), tiles and a Viewer's watch never counting; its held stop reaches the run
 * page with the names of the controllers watching; and **Let it go** reaches its stream from a watch of a controller
 * that shows it in full while it holds, and from nothing else.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const told = () => vi.advanceTimersByTime(TELL_MS);

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
const HELD = {
  reason: 'held' as const,
  call: { title: 'Failed: expect(locator).toHaveText', file: 'tests/a.spec.ts', line: 9 },
  test: 'pays',
  until: 1_000_000 + 300_000,
};

function relay() {
  const published: Array<{ runId: number; state: LiveWorkerState }> = [];
  const live = new LiveViewRelay(
    (runId, state) => published.push({ runId, state }),
    () => 1_000_000,
  );
  return { live, published };
}

/** A worker of run 7 (project 1) that can hold, or not, on a sink of its own. */
function connect(live: LiveViewRelay, hold: { ms: number | null } | null, id: LiveWorkerId = WORKER): FakeSink {
  const sink = new FakeSink();
  const entry = live.authorize(7, live.mintKey(7, 1)!)!;
  expect(live.connectWorker(entry, id, () => sink, [], hold)).toBeNull();
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

const views = (sink: FakeSink) =>
  sink.sent.filter((m): m is { type: 'view'; controller?: true } => (m as { type: string }).type === 'view');
const of = (sink: FakeSink, type: string) => sink.sent.filter((m) => (m as { type: string }).type === type);

describe('the project’s hold, on a worker’s stream', () => {
  test('goes to a worker that can hold as its stream opens, null while the setting is off', () => {
    const { live } = relay();
    expect(of(connect(live, { ms: 300_000 }), 'hold')).toEqual([{ type: 'hold', ms: 300_000 }]);
    expect(of(connect(live, { ms: null }, { shard: null, worker: 1, slot: 1 }), 'hold')).toEqual([
      { type: 'hold', ms: null },
    ]);
    // An older reporter, or a worker outside CI, hears nothing of it.
    expect(of(connect(live, null, { shard: null, worker: 2, slot: 2 }), 'hold')).toEqual([]);
  });

  test('changes as a project admin changes it, for the project’s workers that can hold alone', () => {
    const { live } = relay();
    const holds = connect(live, { ms: null });
    const older = connect(live, null, { shard: null, worker: 1, slot: 1 });
    live.setHold(1, 60_000);
    live.setHold(2, 900_000);
    expect(of(holds, 'hold')).toEqual([
      { type: 'hold', ms: null },
      { type: 'hold', ms: 60_000 },
    ]);
    expect(of(older, 'hold')).toEqual([]);
    // A worker that connects later hears the setting as it stands now.
    expect(of(connect(live, { ms: null }, { shard: null, worker: 3, slot: 3 }), 'hold')).toEqual([
      { type: 'hold', ms: 60_000 },
    ]);
  });
});

describe('the run’s live view ending', () => {
  for (const [why, end] of [
    ['the project turns its live view off', (live: LiveViewRelay) => live.endProject(1)],
    ['the run ends', (live: LiveViewRelay) => live.endRun(7)],
    ['the run is interrupted', (live: LiveViewRelay) => live.interruptRun(7)],
  ] as const) {
    test(`tells a worker that can hold that nothing holds any more as ${why}, before its stream closes`, () => {
      const { live } = relay();
      const holds = connect(live, { ms: 300_000 });
      const older = connect(live, null, { shard: null, worker: 1, slot: 1 });
      watch(live, { focus: WORKER }, ANA);
      live.receive(7, { type: 'stop', ...WORKER, stop: HELD });
      end(live);
      expect(holds.closed).toBe(true);
      expect(holds.sent.at(-1)).toEqual({ type: 'hold', ms: null });
      expect(of(older, 'hold')).toEqual([]);
    });
  }
});

describe('a controller watching', () => {
  test('is said while a controller’s watch shows the worker in full, never for tiles nor a Viewer', () => {
    const { live } = relay();
    const sink = connect(live, { ms: 300_000 });
    told();
    watch(live, { tiles: true }, ANA);
    told();
    watch(live, { focus: WORKER }, VIEWER);
    told();
    expect(views(sink).some((view) => view.controller)).toBe(false);
    const ana = watch(live, { focus: WORKER }, ANA);
    told();
    expect(views(sink).at(-1)).toMatchObject({ full: true, controller: true });
    live.changeWatch(7, ana, ANA.person, { focus: null });
    told();
    expect(views(sink).at(-1)).not.toHaveProperty('controller');
  });

  test('counts no more once a change of the watch says its person may not control the run now', () => {
    const { live } = relay();
    const sink = connect(live, { ms: 300_000 });
    const ana = watch(live, { focus: WORKER }, ANA);
    watch(live, { focus: WORKER }, VIEWER);
    told();
    expect(views(sink).at(-1)).toMatchObject({ controller: true });
    live.changeWatch(7, ana, ANA.person, { size: { width: 900, height: 600 }, controller: false });
    told();
    expect(views(sink).at(-1)).toMatchObject({ full: true });
    expect(views(sink).at(-1)).not.toHaveProperty('controller');
  });
});

describe('a held stop', () => {
  test('reaches the run page with the names of the controllers watching, and the workers say who can hold', () => {
    const { live, published } = relay();
    connect(live, { ms: 300_000 });
    watch(live, { focus: WORKER }, ANA);
    watch(live, { focus: WORKER }, BO);
    watch(live, { focus: WORKER }, VIEWER);
    expect(live.receive(7, { type: 'stop', ...WORKER, stop: HELD })).toBeNull();
    expect(published.at(-1)?.state).toMatchObject({ paused: HELD, heldFor: ['Ana', 'Bo'], holds: true });
    expect(live.workersOf(7)).toEqual([expect.objectContaining({ paused: HELD, heldFor: ['Ana', 'Bo'], holds: true })]);
    expect(live.receive(7, { type: 'stop', ...WORKER, stop: null })).toBeNull();
    expect(published.at(-1)?.state).toMatchObject({ paused: null, heldFor: [] });
  });
});

describe('Let it go', () => {
  test('reaches the held worker’s stream from a controller’s watch that shows it in full', () => {
    const { live } = relay();
    const sink = connect(live, { ms: 300_000 });
    const ana = watch(live, { focus: WORKER }, ANA);
    live.receive(7, { type: 'stop', ...WORKER, stop: HELD });
    expect(live.letGo(7, ana, ANA.person, WORKER)).toEqual({ ok: true, worker: WORKER });
    expect(of(sink, 'let-go')).toEqual([{ type: 'let-go' }]);
  });

  test('is refused for another person’s watch, a Viewer’s, one that shows another worker, and a worker not held', () => {
    const { live } = relay();
    const sink = connect(live, { ms: 300_000 });
    const other: LiveWorkerId = { shard: null, worker: 1, slot: 1 };
    connect(live, { ms: 300_000 }, other);
    const ana = watch(live, { focus: WORKER }, ANA);
    const sam = watch(live, { focus: WORKER }, VIEWER);
    const elsewhere = watch(live, { focus: other }, BO);
    // Not held yet.
    expect(live.letGo(7, ana, ANA.person, WORKER)).toMatchObject({ status: 409 });
    live.receive(7, { type: 'stop', ...WORKER, stop: HELD });
    expect(live.letGo(7, ana, BO.person, WORKER)).toMatchObject({ status: 404 });
    expect(live.letGo(7, 'w'.repeat(22), ANA.person, WORKER)).toMatchObject({ status: 404 });
    expect(live.letGo(8, ana, ANA.person, WORKER)).toMatchObject({ status: 404 });
    expect(live.letGo(7, sam, VIEWER.person, WORKER)).toMatchObject({ status: 403 });
    expect(live.letGo(7, elsewhere, BO.person, WORKER)).toMatchObject({ status: 409 });
    // A stop of another kind is no hold.
    live.receive(7, { type: 'stop', ...WORKER, stop: { ...HELD, reason: 'failure', until: undefined } });
    expect(live.letGo(7, ana, ANA.person, WORKER)).toMatchObject({ status: 409 });
    expect(of(sink, 'let-go')).toEqual([]);
  });

  test('is refused for a worker that cannot hold, whatever it says', () => {
    const { live } = relay();
    const sink = connect(live, null);
    const ana = watch(live, { focus: WORKER }, ANA);
    live.receive(7, { type: 'stop', ...WORKER, stop: HELD });
    expect(live.letGo(7, ana, ANA.person, WORKER)).toMatchObject({ status: 409 });
    expect(of(sink, 'let-go')).toEqual([]);
  });
});
