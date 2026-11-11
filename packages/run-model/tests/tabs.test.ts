import { describe, expect, it } from 'vitest';
import type { HubWorker } from '@piwitests/core/run-hub';
import { shownLaneOf, tabsAdvanced, tabsAfter, tabsChosen } from '../src/tabs';
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

describe('a run’s worker tabs as its workers stand', () => {
  const stopped = (w: number, since: string) =>
    worker({ worker: w, parallelIndex: w, state: 'stopped', stop: stop(since) });
  const running = (w: number) => worker({ worker: w, parallelIndex: w });
  const none = () => false;

  it('are none for a run of one worker, and show the first stopped one as they come', () => {
    expect(tabsAfter(null, [stopped(0, 's1')], none)).toBeNull();
    expect(tabsAfter(null, [running(1), stopped(0, 's1')], none)).toEqual({ shown: 0, known: ['s1'], advance: null });
    expect(tabsAfter(null, [running(0), running(1)], none)).toEqual({ shown: 0, known: [], advance: null });
  });

  it('let a new stop take the tab from a worker that is neither stopped nor watched, once', () => {
    const first = tabsAfter(null, [running(0), running(1)], none)!;
    const stoppedNow = tabsAfter(first, [running(0), stopped(1, 's1')], none)!;
    expect(stoppedNow.shown).toBe(1);
    // The person goes back to the running one: the stop, known, takes it no more.
    const chosen = tabsChosen(stoppedNow, 0);
    expect(tabsAfter(chosen, [running(0), stopped(1, 's1')], none)!.shown).toBe(0);
    // A worker watched keeps its tab, as one at a stop does.
    expect(tabsAfter(first, [running(0), stopped(1, 's2')], (w: HubWorker) => w.worker === 0)!.shown).toBe(0);
    const answering = tabsAfter(null, [stopped(0, 's0'), running(1)], none)!;
    expect(tabsAfter(answering, [stopped(0, 's0'), stopped(1, 's3')], none)!.shown).toBe(0);
  });

  it('move to the next stopped test once the one shown was resumed or ended there and left its stop', () => {
    const both = tabsAfter(null, [stopped(0, 's0'), stopped(1, 's1')], none)!;
    expect(both.shown).toBe(0);
    // Resumed on a worker not shown: nothing moves.
    expect(tabsAdvanced(both, 1, 's1')).toBe(both);
    expect(tabsAdvanced(both, 0, null)).toBe(both);
    const resumed = tabsAdvanced(both, 0, 's0');
    expect(resumed.advance).toBe('s0');
    // Still at that stop: the tab stays, waiting.
    expect(tabsAfter(resumed, [stopped(0, 's0'), stopped(1, 's1')], none)).toEqual(resumed);
    // Gone on: the next stopped test takes the tab, and the advance is spent.
    expect(tabsAfter(resumed, [running(0), stopped(1, 's1')], none)).toEqual({
      shown: 1,
      known: ['s1'],
      advance: null,
    });
    // None stopped: the tab stays where it was.
    expect(tabsAfter({ shown: 1, known: [], advance: 's1' }, [running(0), running(1)], none)!.shown).toBe(1);
    // Choosing a tab spends the advance.
    expect(tabsChosen(resumed, 1)).toEqual({ shown: 1, known: ['s0', 's1'], advance: null });
  });
});
