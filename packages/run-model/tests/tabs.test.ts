import { describe, expect, it } from 'vitest';
import type { HubWorker } from '@piwitests/core/run-hub';
import { shownLaneOf } from '../src/tabs';
import { stop, worker } from './fixtures';

describe('the worker a run’s tabs show', () => {
  const stopped = (w: number, since: string) =>
    worker({ worker: w, parallelIndex: w, state: 'stopped', stop: stop(since) });
  const running = (w: number) => worker({ worker: w, parallelIndex: w });

  it('keeps the worker shown while it stands at a stop or is watched, a new stop taking the tab once', () => {
    const first = { before: null };
    expect(shownLaneOf([running(0), running(1)], first)).toBe(0);
    expect(shownLaneOf([running(0), stopped(1, 's1')], first)).toBe(1);
    expect(shownLaneOf([], first)).toBeNull();
    // The person's choice, a running worker, stays while no stop comes.
    expect(shownLaneOf([running(0), running(1)], { before: 1 })).toBe(1);
    // A stop takes the tab from a running worker as it comes.
    expect(shownLaneOf([running(0), stopped(1, 's1')], { before: 0 })).toBe(1);
    // Never from a stop being answered, nor from a page being watched.
    expect(shownLaneOf([stopped(0, 's0'), stopped(1, 's1')], { before: 0 })).toBe(0);
    const watched = (w: HubWorker) => w.worker === 0;
    expect(shownLaneOf([running(0), stopped(1, 's1')], { before: 0, watched })).toBe(0);
    // A stop that came while another one was shown has had its turn: a Step there, running a moment, keeps its tab.
    const known = new Set(['s0']);
    expect(shownLaneOf([stopped(0, 's0'), running(1)], { before: 1, known })).toBe(1);
    // A running worker chosen while others stand at stops keeps the tab, until a new stop comes.
    const three = [stopped(0, 's1'), stopped(1, 's2'), running(2)];
    expect(shownLaneOf(three, { before: 2, known: new Set(['s1', 's2']) })).toBe(2);
    const standing = new Set(['s1', 's2']);
    expect(shownLaneOf([stopped(0, 's1'), stopped(1, 's3'), running(2)], { before: 2, known: standing })).toBe(1);
    // Resumed or ended there, the next stopped worker takes the tab, or it stays where it was.
    expect(shownLaneOf([stopped(0, 's0'), running(1)], { before: 1, known, advance: true })).toBe(0);
    expect(shownLaneOf([running(0), running(1)], { before: 1, advance: true })).toBe(1);
    // The worker Playwright starts in a lane's place keeps its tab; a lane gone falls back to the first.
    expect(shownLaneOf([running(0), worker({ worker: 5, parallelIndex: 1 })], { before: 1 })).toBe(1);
    expect(shownLaneOf([running(0), running(1)], { before: 7 })).toBe(0);
  });
});
