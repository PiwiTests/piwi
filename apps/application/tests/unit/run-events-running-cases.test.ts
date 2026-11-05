import { describe, test, expect, afterEach } from 'vitest';
import { MAX_KEPT_LIVE_STEPS } from '../../server/utils/map-step-events';
import { runEventBus } from '../../server/utils/run-events';

// The singleton bus is shared across tests, so each test uses its own run IDs
// and clears them afterwards.
const usedRunIds = new Set<number>();

function track(runId: number): number {
  usedRunIds.add(runId);
  return runId;
}

afterEach(() => {
  for (const id of usedRunIds) runEventBus.cleanup(id);
  usedRunIds.clear();
});

describe('runEventBus running cases', () => {
  test('records begin payloads and returns them for catch-up', () => {
    const runId = track(9001);
    expect(runEventBus.getRunningCases(runId)).toEqual([]);

    const a = { title: 'a', location: 'a.spec.ts:1:1' };
    const b = { title: 'b', location: 'b.spec.ts:2:1' };
    runEventBus.recordRunningCase(runId, 'a', a);
    runEventBus.recordRunningCase(runId, 'b', b);

    expect(runEventBus.getRunningCases(runId)).toEqual([a, b]);
  });

  test('clearing a running case drops it once it completes', () => {
    const runId = track(9002);
    runEventBus.recordRunningCase(runId, 'a', { title: 'a' });
    runEventBus.recordRunningCase(runId, 'b', { title: 'b' });

    runEventBus.clearRunningCase(runId, 'a');

    expect(runEventBus.getRunningCases(runId)).toEqual([{ title: 'b' }]);
  });

  test('recording the same key twice keeps a single, latest entry', () => {
    const runId = track(9003);
    runEventBus.recordRunningCase(runId, 'a', { title: 'a', startedAt: 1 });
    runEventBus.recordRunningCase(runId, 'a', { title: 'a', startedAt: 2 });

    expect(runEventBus.getRunningCases(runId)).toEqual([{ title: 'a', startedAt: 2 }]);
  });

  test('running cases are isolated per run', () => {
    const runA = track(9004);
    const runB = track(9005);
    runEventBus.recordRunningCase(runA, 'x', { title: 'x' });

    expect(runEventBus.getRunningCases(runB)).toEqual([]);
    expect(runEventBus.getRunningCases(runA)).toEqual([{ title: 'x' }]);
  });

  test('clearing an unknown case or run is a no-op', () => {
    const runId = track(9006);
    expect(() => runEventBus.clearRunningCase(runId, 'missing')).not.toThrow();
    expect(runEventBus.getRunningCases(runId)).toEqual([]);
  });

  test('cleanup drops every running case for the run', () => {
    const runId = track(9007);
    runEventBus.recordRunningCase(runId, 'a', { title: 'a' });
    runEventBus.recordRunningCase(runId, 'b', { title: 'b' });

    runEventBus.cleanup(runId);

    expect(runEventBus.getRunningCases(runId)).toEqual([]);
  });
});

describe('runEventBus live steps', () => {
  const step = (
    type: 'step-begin' | 'step-end',
    title: string,
    workerIndex: number | null,
    shardIndex: number | null,
  ) => ({
    type,
    data: { title, parentTitle: 'the test', workerIndex, shardIndex },
  });

  test('keeps the latest step of each worker, by shard and worker, for the catch-up', () => {
    const runId = track(9101);
    runEventBus.recordLiveStep(runId, step('step-begin', 'Navigate', 0, 1));
    runEventBus.recordLiveStep(runId, step('step-end', 'Navigate', 0, 1));
    runEventBus.recordLiveStep(runId, step('step-begin', 'Click', 0, 1));
    runEventBus.recordLiveStep(runId, step('step-begin', 'Fill', 0, 2));
    expect(runEventBus.getLiveSteps(runId).map((s) => `${s.data.shardIndex}:${s.data.title}`)).toEqual([
      '1:Click',
      '2:Fill',
    ]);
  });

  test('keeps no step without a worker, nor a suite-level hook', () => {
    const runId = track(9102);
    runEventBus.recordLiveStep(runId, step('step-begin', 'Click', null, null));
    runEventBus.recordLiveStep(runId, { type: 'test-begin', data: { title: 'beforeAll', workerIndex: 0 } });
    expect(runEventBus.getLiveSteps(runId)).toEqual([]);
  });

  test('forgets a worker’s step once its test completes, and only that test’s', () => {
    const runId = track(9104);
    runEventBus.recordLiveStep(runId, step('step-begin', 'Click', 0, 1));
    runEventBus.recordLiveStep(runId, step('step-begin', 'Fill', 1, 1));
    runEventBus.clearLiveStep(runId, { title: 'another test', workerIndex: 1, shardIndex: 1 });
    runEventBus.clearLiveStep(runId, { title: 'the test', workerIndex: 0, shardIndex: 2 });
    runEventBus.clearLiveStep(runId, { title: 'the test', workerIndex: 0, shardIndex: 1 });
    expect(runEventBus.getLiveSteps(runId).map((s) => s.data.title)).toEqual(['Fill']);
  });

  test('forgets a run’s steps when it answers that nobody watches, and keeps them while someone does', () => {
    const runId = track(9105);
    runEventBus.recordLiveStep(runId, step('step-begin', 'Click', 0, null));
    const unsubscribe = runEventBus.subscribe(runId, () => {});
    expect(runEventBus.answerWatched(runId)).toBe(true);
    expect(runEventBus.getLiveSteps(runId)).toHaveLength(1);
    unsubscribe();
    expect(runEventBus.answerWatched(runId)).toBe(false);
    expect(runEventBus.getLiveSteps(runId)).toEqual([]);
  });

  test('keeps a step for at most MAX_KEPT_LIVE_STEPS workers of a run, and the latest of each', () => {
    const runId = track(9106);
    for (let worker = 0; worker <= MAX_KEPT_LIVE_STEPS; worker++) {
      runEventBus.recordLiveStep(runId, step('step-begin', 'Click', worker, null));
    }
    runEventBus.recordLiveStep(runId, step('step-begin', 'Fill', 0, null));
    const steps = runEventBus.getLiveSteps(runId);
    expect(steps).toHaveLength(MAX_KEPT_LIVE_STEPS);
    expect(steps[0]!.data.title).toBe('Fill');
  });

  test('forgets a run’s steps on its cleanup', () => {
    const runId = track(9103);
    runEventBus.recordLiveStep(runId, step('step-begin', 'Click', 0, null));
    runEventBus.cleanup(runId);
    expect(runEventBus.getLiveSteps(runId)).toEqual([]);
  });
});
