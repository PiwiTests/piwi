import { describe, expect, test } from 'vitest';
import {
  askToWatchView,
  runLiveViewStatus,
  type AskToWatchInput,
  type RunLiveViewReadiness,
} from '../../app/utils/run-live-view-status';
import type { LiveAskView } from '#shared/live-view';

const run = (over: Partial<RunLiveViewReadiness> = {}): RunLiveViewReadiness => ({
  desktop: false,
  demo: false,
  connected: true,
  state: { enabled: true, keyed: true },
  ci: true,
  workers: 0,
  testsWithoutWorkers: false,
  ...over,
});

describe('live-view readiness', () => {
  test('local preview and simulated progress do not depend on a dashboard key or stream', () => {
    expect(runLiveViewStatus(run({ desktop: true, connected: false, state: null })).kind).toBe('desktop');
    expect(runLiveViewStatus(run({ demo: true, connected: false, state: null })).kind).toBe('demo');
  });

  test('a stream that stayed unopened says it stalled, and an open one never does', () => {
    expect(runLiveViewStatus(run({ connected: false, state: null, stalled: true })).kind).toBe('stalled');
    expect(runLiveViewStatus(run({ stalled: true })).kind).toBe('waiting');
    expect(runLiveViewStatus(run({ desktop: true, connected: false, stalled: true })).kind).toBe('desktop');
  });

  test('does not claim readiness from workers left over from a disconnected stream', () => {
    expect(runLiveViewStatus(run({ connected: false, workers: 2 })).kind).toBe('checking');
    expect(runLiveViewStatus(run({ state: null, workers: 2 })).kind).toBe('checking');
  });

  test('the project’s setting turned off wins over connected workers', () => {
    expect(runLiveViewStatus(run({ state: { enabled: false, keyed: true }, workers: 2 })).kind).toBe('disabled');
  });

  test('enabling a project does not claim an existing run registered without a key', () => {
    expect(runLiveViewStatus(run({ state: { enabled: true, keyed: false } })).kind).toBe('unavailable');
  });

  test('a connected worker makes the run watchable whatever the key last said', () => {
    expect(runLiveViewStatus(run({ state: { enabled: true, keyed: false }, workers: 1 })).kind).toBe('available');
  });

  test('a key without workers explains CI startup and local sharing separately', () => {
    expect(runLiveViewStatus(run()).kind).toBe('waiting');
    expect(runLiveViewStatus(run({ ci: false })).kind).toBe('unshared');
  });

  test('a CI run whose tests run without any worker says none connected, and a local one that it is not shared', () => {
    expect(runLiveViewStatus(run({ testsWithoutWorkers: true })).kind).toBe('no-workers');
    expect(runLiveViewStatus(run({ testsWithoutWorkers: true, ci: false })).kind).toBe('unshared');
    expect(runLiveViewStatus(run({ testsWithoutWorkers: true, state: { enabled: true, keyed: false } })).kind).toBe(
      'unavailable',
    );
  });

  test('a connected worker makes both a CI run and a shared local run available', () => {
    expect(runLiveViewStatus(run({ workers: 1 })).kind).toBe('available');
    expect(runLiveViewStatus(run({ workers: 1, ci: false })).kind).toBe('available');
  });

  test('says a live view turned on from the page starts with the next run, which the running one is not', () => {
    expect(runLiveViewStatus(run({ state: { enabled: true, keyed: false }, turnedOn: true }))).toEqual({
      kind: 'next-run',
      label: 'Live view on from the next run',
    });
    // Turned off again by someone else, it reads off.
    expect(runLiveViewStatus(run({ state: { enabled: false, keyed: false }, turnedOn: true })).kind).toBe('disabled');
    // A run that holds a key, the setting having been off only for a moment, keeps its own status.
    expect(runLiveViewStatus(run({ state: { enabled: true, keyed: true }, turnedOn: true })).kind).toBe('waiting');
  });
});

describe('Ask to watch beside Not shared live', () => {
  const ask = (answer: LiveAskView['answer'], waitMs = 0): LiveAskView => ({ id: 'a1', by: 'Dana', answer, waitMs });
  const view = (over: Partial<AskToWatchInput> = {}) =>
    askToWatchView({ status: 'unshared', canAsk: true, ask: null, askAgainAt: null, now: 1_000_000, ...over });

  test('is offered on a run nobody shares, to a viewer who may ask, and nowhere else', () => {
    expect(view()).toEqual({ note: null, action: 'ask', waitMinutes: null });
    expect(view({ canAsk: false })).toBeNull();
    expect(view({ status: 'available' })).toBeNull();
    expect(view({ status: 'waiting' })).toBeNull();
  });

  test('says the ask waits, then that the developer answered Not now, and when the viewer may ask again', () => {
    expect(view({ ask: ask(null), askAgainAt: 1_000_000 + 4 * 60_000 + 1 })).toEqual({
      note: 'asked',
      action: null,
      waitMinutes: 5,
    });
    expect(view({ ask: ask('not-now'), askAgainAt: 1_000_000 + 60_000 })).toEqual({
      note: 'not-now',
      action: null,
      waitMinutes: 1,
    });
    expect(view({ ask: ask('not-now'), askAgainAt: 1_000_000 })).toEqual({
      note: 'not-now',
      action: 'ask-again',
      waitMinutes: null,
    });
  });

  test('a run shared after an ask and no longer shared offers to ask again once the wait is over', () => {
    expect(view({ ask: ask('shared'), askAgainAt: 999_999 })).toEqual({
      note: null,
      action: 'ask-again',
      waitMinutes: null,
    });
  });

  test('an ask the instance refused as too soon waits, with nothing asked shown', () => {
    expect(view({ askAgainAt: 1_000_000 + 90_000 })).toEqual({ note: null, action: null, waitMinutes: 2 });
  });
});
