import { describe, test, expect } from 'vitest';
import { liveResourcesByWorker, liveResourcesForCase, liveResourcesLabel } from '../../app/utils/live-worker-resources';
import type { TestCaseResult } from '../../types/api';
import type { RunResourceTimelinePart } from '../../shared/handlers/run-resources';

/** A running test's row shows what its worker uses right now, from the live parts. */

const MB = 1024 * 1024;

function part(shardIndex: number | null, worker: number, extra: Partial<RunResourceTimelinePart['timeline']> = {}) {
  return {
    shardIndex,
    memoryCapacityBytes: null,
    memoryKind: 'pss',
    timeline: {
      startedAt: 1,
      cpuPct: [],
      memoryBytes: [],
      pages: [
        {
          worker,
          points: [
            [100, 1],
            [900, 3],
          ],
        },
      ],
      workers: [
        {
          worker,
          cpuCores: [
            [500, 0.4],
            [1000, 1.26],
          ],
          memoryBytes: [[1000, 640 * MB]],
        },
      ],
      ...extra,
    },
  } as RunResourceTimelinePart;
}

const running = (workerIndex: number, shardIndex: number | null = null) =>
  ({ status: 'running', workerIndex, shardIndex }) as TestCaseResult;

describe('live worker resources', () => {
  test('a running row shows its worker’s last cores, memory and open pages', () => {
    const byWorker = liveResourcesByWorker([part(null, 2)]);
    const values = liveResourcesForCase(byWorker, running(2), true);
    expect(values).toEqual({ cpuCores: 1.26, memoryBytes: 640 * MB, memoryKind: 'pss', openPages: 3 });
    expect(liveResourcesLabel(values!)).toBe('1.3 cores · 640 MB · 3 pages');
  });

  test('a finished row, a row without a worker and a worker not measured yet show nothing', () => {
    const byWorker = liveResourcesByWorker([part(null, 2)]);
    expect(liveResourcesForCase(byWorker, { ...running(2), status: 'passed' }, true)).toBeNull();
    expect(liveResourcesForCase(byWorker, { status: 'running', workerIndex: null } as TestCaseResult, true)).toBeNull();
    expect(liveResourcesForCase(byWorker, running(5), true)).toBeNull();
    expect(liveResourcesForCase(liveResourcesByWorker(null), running(2), true)).toBeNull();
  });

  test('a sharded run matches the row’s shard, and one reporter matches by worker alone', () => {
    const byWorker = liveResourcesByWorker([part(1, 0), part(2, 0, { workers: [] })]);
    expect(liveResourcesForCase(byWorker, running(0, 1), false)?.cpuCores).toBe(1.26);
    expect(liveResourcesForCase(byWorker, running(0, 2), false)?.cpuCores).toBeNull();
    expect(liveResourcesForCase(byWorker, running(0), false)).toBeNull();
    expect(liveResourcesForCase(liveResourcesByWorker([part(3, 0)]), running(0), true)?.openPages).toBe(3);
  });

  test('the label leaves out what was not measured', () => {
    expect(liveResourcesLabel({ cpuCores: null, memoryBytes: null, memoryKind: null, openPages: 1 })).toBe('1 page');
    expect(liveResourcesLabel({ cpuCores: 1, memoryBytes: null, memoryKind: null, openPages: null })).toBe('1 core');
    expect(liveResourcesLabel({ cpuCores: null, memoryBytes: null, memoryKind: null, openPages: null })).toBe('');
  });
});
