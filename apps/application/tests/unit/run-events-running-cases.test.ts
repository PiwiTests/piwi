import { describe, test, expect, afterEach } from 'vitest';
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

  test('forgets a run’s steps on its cleanup', () => {
    const runId = track(9103);
    runEventBus.recordLiveStep(runId, step('step-begin', 'Click', 0, null));
    runEventBus.cleanup(runId);
    expect(runEventBus.getLiveSteps(runId)).toEqual([]);
  });
});
