import { describe, test, expect, afterEach, vi } from 'vitest';
import { MAX_KEPT_LIVE_STEPS } from '../../server/utils/map-step-events';
import { runEventBus } from '../../server/utils/run-events';
import type { StreamEventPayload } from '#shared/types';

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
    parentTitle = 'the test',
  ): StreamEventPayload => ({
    type,
    title,
    parentTitle,
    stepCategory: 'pw:api',
    location: 'tests/a.spec.ts:3:5',
    workerIndex,
    shardIndex,
  });
  const complete = (title: string, workerIndex: number, shardIndex: number | null): StreamEventPayload => ({
    type: 'complete',
    title,
    location: 'tests/a.spec.ts:1:1',
    status: 'passed',
    workerIndex,
    shardIndex,
  });
  const titles = (runId: number) => runEventBus.getLiveSteps(runId).map((s) => s.data.title);

  test('keeps the latest step of each worker, by shard and worker, for the catch-up', () => {
    const runId = track(9101);
    runEventBus.noteLiveSteps(
      runId,
      [
        step('step-begin', 'Navigate', 0, 1),
        step('step-end', 'Navigate', 0, 1),
        step('step-begin', 'Click', 0, 1),
        step('step-begin', 'Fill', 0, 2),
      ],
      'tok',
    );
    expect(runEventBus.getLiveSteps(runId).map((s) => `${s.data.shardIndex}:${s.data.title}`)).toEqual([
      '1:Click',
      '2:Fill',
    ]);
  });

  test('keeps no step without a worker', () => {
    const runId = track(9102);
    runEventBus.noteLiveSteps(runId, [step('step-begin', 'Click', null, null)], 'tok');
    expect(runEventBus.getLiveSteps(runId)).toEqual([]);
  });

  test('forgets a worker’s step once its test completes, in batch order, and only that test’s', () => {
    const runId = track(9104);
    runEventBus.noteLiveSteps(
      runId,
      [
        step('step-begin', 'Click', 0, 1),
        step('step-begin', 'Fill', 1, 1),
        complete('another test', 1, 1),
        complete('the test', 0, 2),
        complete('the test', 0, 1),
        // The worker's next test has the same title: its step comes after the completion and stays.
        step('step-begin', 'Navigate', 0, 1),
      ],
      'tok',
    );
    expect(titles(runId)).toEqual(['Fill', 'Navigate']);
  });

  test('forgets the step a reporter sent without its shard when its sharded test completes', () => {
    const runId = track(9107);
    runEventBus.noteLiveSteps(runId, [step('step-begin', 'Click', 0, null), complete('the test', 0, 2)], 'tok');
    expect(runEventBus.getLiveSteps(runId)).toEqual([]);
  });

  test('told that nobody watches, a reporter’s steps go, and another reporter’s stay', () => {
    const runId = track(9105);
    runEventBus.noteLiveSteps(runId, [step('step-begin', 'Click', 0, 1)], 'shard-1');
    runEventBus.noteLiveSteps(runId, [step('step-begin', 'Fill', 0, 2)], 'shard-2');
    const unsubscribe = runEventBus.subscribe(runId, () => {});
    expect(runEventBus.answerWatched(runId, 'shard-1')).toBe(true);
    expect(titles(runId)).toEqual(['Click', 'Fill']);
    unsubscribe();
    expect(runEventBus.answerWatched(runId, 'shard-1')).toBe(false);
    expect(titles(runId)).toEqual(['Fill']);
  });

  test('keeps a step for at most MAX_KEPT_LIVE_STEPS workers of a run, the latest to step', () => {
    const runId = track(9106);
    const many = Array.from({ length: MAX_KEPT_LIVE_STEPS }, (_, worker) => step('step-begin', 'Click', worker, null));
    runEventBus.noteLiveSteps(runId, many, 'tok');
    // Worker 0 steps again, then a new worker comes: worker 1, which stepped longest ago, goes.
    runEventBus.noteLiveSteps(runId, [step('step-begin', 'Fill', 0, null)], 'tok');
    runEventBus.noteLiveSteps(runId, [step('step-begin', 'Wait', MAX_KEPT_LIVE_STEPS, null)], 'tok');
    const steps = runEventBus.getLiveSteps(runId);
    expect(steps).toHaveLength(MAX_KEPT_LIVE_STEPS);
    expect(steps.some((s) => s.data.workerIndex === 1)).toBe(false);
    expect(steps.find((s) => s.data.workerIndex === 0)?.data.title).toBe('Fill');
    expect(steps.at(-1)?.data.title).toBe('Wait');
  });

  test('forgets a run’s steps on its cleanup', () => {
    const runId = track(9103);
    runEventBus.noteLiveSteps(runId, [step('step-begin', 'Click', 0, null)], 'tok');
    runEventBus.cleanup(runId);
    expect(runEventBus.getLiveSteps(runId)).toEqual([]);
  });
});

describe('runEventBus last global event', () => {
  test('says when the last run event of a project the caller may read went out', () => {
    runEventBus.publishGlobal({ type: 'run-started', runId: 9201, projectId: 9201 });
    const readable = runEventBus.lastGlobalEvent((projectId) => projectId === 9201);
    expect(readable).toEqual(expect.any(Number));
    expect(runEventBus.lastGlobalEvent((projectId) => projectId === 9202)).toBeNull();
  });

  test('says the latest of the projects the caller may read, never one of another project', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      runEventBus.publishGlobal({ type: 'run-started', runId: 9211, projectId: 9211 });
      vi.setSystemTime(2_000_000);
      runEventBus.publishGlobal({ type: 'run-started', runId: 9212, projectId: 9212 });
      vi.setSystemTime(3_000_000);
      runEventBus.publishGlobal({ type: 'run-started', runId: 9213, projectId: 9213 });
      expect(runEventBus.lastGlobalEvent((projectId) => projectId === 9211 || projectId === 9212)).toBe(2_000_000);
      expect(runEventBus.lastGlobalEvent((projectId) => projectId === 9211)).toBe(1_000_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
