import { describe, expect, test } from 'vitest';
import { ASK_TO_WATCH_MS, parseLiveAsk } from '@piwitests/core/live-view';
import {
  LiveAsks,
  MAX_ASKS_PER_RUN,
  askRefusal,
  viewerAskEvent,
  viewerLiveView,
  type LiveAskEvent,
} from '../../server/utils/live-asks';
import { runEventBus } from '../../server/utils/run-events';

/**
 * Ask to watch on the instance: a person asks once per `ASK_TO_WATCH_MS` on one run, the run's reporter takes each ask
 * once, the developer's Not now comes back for an ask of that run alone, a worker that streams answers every ask that
 * waits as shared, each change goes to the person who asked alone, and the asks end with their run or their project's
 * settings.
 */

function asks() {
  let now = 1_000_000;
  const published: Array<{ runId: number; event: LiveAskEvent }> = [];
  const registry = new LiveAsks(
    (runId, event) => published.push({ runId, event }),
    () => now,
  );
  return { registry, published, advance: (ms: number) => (now += ms) };
}

describe('asking to watch a run', () => {
  test('takes one ask per person and run in each window, the next one replacing the last', () => {
    const { registry, advance } = asks();
    const first = registry.ask(7, 1, 3, 'Dana');
    expect(first).toMatchObject({ ok: true, ask: { by: 'Dana', answer: null, waitMs: ASK_TO_WATCH_MS } });
    if (!first.ok) throw new Error('refused');
    expect(parseLiveAsk({ id: first.ask.id, by: 'x' })).not.toBeNull();

    advance(60_000);
    expect(registry.ask(7, 1, 3, 'Dana')).toEqual({ ok: false, waitMs: ASK_TO_WATCH_MS - 60_000 });
    // Another person, or the same person on another run, asks at once.
    expect(registry.ask(7, 1, 4, 'Lee').ok).toBe(true);
    expect(registry.ask(8, 1, 3, 'Dana').ok).toBe(true);

    advance(ASK_TO_WATCH_MS);
    const again = registry.ask(7, 1, 3, 'Dana');
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error('refused');
    expect(again.ask.id).not.toBe(first.ask.id);
    expect(registry.viewOf(7, 3)?.id).toBe(again.ask.id);
  });

  test('names the person on one line, and someone when the name is empty', () => {
    const { registry } = asks();
    const named = registry.ask(7, 1, 3, ' Dana\nLee ');
    expect(named.ok && named.ask.by).toBe('Dana Lee');
    const unnamed = registry.ask(7, 1, 4, '\u0007');
    expect(unnamed.ok && unnamed.ask.by).toBe('A teammate');
  });

  test('keeps the latest asks of a run, past its bound', () => {
    const { registry } = asks();
    for (let person = 1; person <= MAX_ASKS_PER_RUN + 1; person++) registry.ask(7, 1, person, `P${person}`);
    expect(registry.viewOf(7, 1)).toBeNull();
    expect(registry.viewOf(7, 2)).not.toBeNull();
    expect(registry.viewOf(7, MAX_ASKS_PER_RUN + 1)).not.toBeNull();
  });
});

describe('handing an ask to the run, and its answer', () => {
  test('hands each ask over once, the oldest first, and none of another run', () => {
    const { registry } = asks();
    registry.ask(7, 1, 3, 'Dana');
    registry.ask(7, 1, 4, 'Lee');
    registry.ask(8, 1, 5, 'Sam');
    expect(registry.handOver(7)).toMatchObject({ by: 'Dana' });
    expect(registry.handOverAnswer(7)).toEqual({ ask: expect.objectContaining({ by: 'Lee' }) });
    expect(registry.handOver(7)).toBeNull();
    expect(registry.handOverAnswer(7)).toEqual({});
    expect(registry.handOver(8)).toMatchObject({ by: 'Sam' });
  });

  test('takes the developer’s Not now for an ask of that run alone, once, and tells the person who asked', () => {
    const { registry, published } = asks();
    const ask = registry.ask(7, 1, 3, 'Dana');
    if (!ask.ok) throw new Error('refused');
    registry.handOver(7);
    published.length = 0;

    expect(registry.answer(8, { id: ask.ask.id, answer: 'not-now' })).toBeNull();
    expect(registry.answer(7, { id: ask.ask.id, answer: 'yes' })).toBeNull();
    expect(registry.answer(7, undefined)).toBeNull();
    expect(registry.answer(7, { id: ask.ask.id, answer: 'not-now' })).toEqual({ id: ask.ask.id, answer: 'not-now' });
    expect(registry.answer(7, { id: ask.ask.id, answer: 'not-now' })).toBeNull();
    expect(registry.viewOf(7, 3)?.answer).toBe('not-now');
    expect(published).toEqual([{ runId: 7, event: expect.objectContaining({ userId: 3, answer: 'not-now' }) }]);
  });

  test('an answered ask is never handed over', () => {
    const { registry } = asks();
    const ask = registry.ask(7, 1, 3, 'Dana');
    if (!ask.ok) throw new Error('refused');
    registry.answer(7, { id: ask.ask.id, answer: 'not-now' });
    expect(registry.handOver(7)).toBeNull();
  });

  test('a worker that streams answers each ask that waits as shared, and leaves Not now as it is', () => {
    const { registry, published } = asks();
    const dana = registry.ask(7, 1, 3, 'Dana');
    const lee = registry.ask(7, 1, 4, 'Lee');
    if (!dana.ok || !lee.ok) throw new Error('refused');
    registry.answer(7, { id: lee.ask.id, answer: 'not-now' });
    published.length = 0;
    registry.shareRun(7);
    expect(registry.viewOf(7, 3)?.answer).toBe('shared');
    expect(registry.viewOf(7, 4)?.answer).toBe('not-now');
    expect(published.map(({ event }) => [event.userId, event.answer])).toEqual([[3, 'shared']]);
    expect(registry.handOver(7)).toBeNull();
  });
});

describe('the end of a run’s asks', () => {
  test('drops them as the run ends, and with its project’s settings', () => {
    const { registry } = asks();
    const stop = registry.followRuns();
    try {
      registry.ask(7, 1, 3, 'Dana');
      registry.ask(8, 1, 3, 'Dana');
      registry.ask(9, 2, 3, 'Dana');
      runEventBus.publishGlobal({ type: 'run-finished', runId: 7, projectId: 1, status: 'passed' });
      expect(registry.viewOf(7, 3)).toBeNull();
      expect(registry.handOver(7)).toBeNull();
      expect(registry.viewOf(8, 3)).not.toBeNull();
      registry.endProject(1);
      expect(registry.viewOf(8, 3)).toBeNull();
      expect(registry.viewOf(9, 3)).not.toBeNull();
      registry.endRun(9);
      expect(registry.viewOf(9, 3)).toBeNull();
    } finally {
      stop();
    }
  });
});

describe('who may ask, and what each viewer hears', () => {
  const run = { status: 'running', metadata: { piwiOrigin: { kind: 'editor' } }, keyed: true };
  const project = { liveView: true, askToWatch: true };

  test('a running run outside CI that holds a key, in a project with the live view and Ask to watch on', () => {
    expect(askRefusal({ ...run, ...project })).toBeNull();
    expect(askRefusal({ ...run, ...project, liveView: false })).toMatch(/live view is off/);
    expect(askRefusal({ ...run, ...project, askToWatch: false })).toMatch(/does not take asks/);
    expect(askRefusal({ ...run, ...project, status: 'finalizing' })).toMatch(/not running/);
    expect(askRefusal({ ...run, ...project, metadata: { ci: { provider: 'github' } } })).toMatch(/CI run/);
    expect(askRefusal({ ...run, ...project, keyed: false })).toMatch(/no live view key/);
  });

  test('a signed-in viewer may ask a run that takes asks, and hears their own ask alone', () => {
    const { registry } = asks();
    const ask = registry.ask(7, 1, 3, 'Dana');
    if (!ask.ok) throw new Error('refused');
    const state = { keyed: true, enabled: true, askable: true };
    expect(viewerLiveView(state, 7, 3, registry)).toEqual({
      keyed: true,
      enabled: true,
      canAsk: true,
      ask: ask.ask,
    });
    expect(viewerLiveView(state, 7, 4, registry)).toMatchObject({ canAsk: true, ask: null });
    expect(viewerLiveView(state, 7, null, registry)).toMatchObject({ canAsk: false, ask: null });
    expect(viewerLiveView({ ...state, askable: false }, 7, 3, registry)).toMatchObject({ canAsk: false });

    const event: LiveAskEvent = { ...ask.ask, userId: 3 };
    expect(viewerAskEvent(event, 3)).toEqual(ask.ask);
    expect(viewerAskEvent(event, 4)).toBeNull();
    expect(viewerAskEvent(event, null)).toBeNull();
  });
});
