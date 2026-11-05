import { describe, test, expect, afterEach, vi } from 'vitest';
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
