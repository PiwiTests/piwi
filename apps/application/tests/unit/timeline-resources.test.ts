import { describe, test, expect } from 'vitest';
import { timelineResources } from '../../shared/timeline-resources';
import { findingView } from '../../shared/resource-copy';
import { sanitizeResourceReport } from '../../shared/resource-report';
import {
  readingAt,
  resourceFacts,
  resourceReadout,
  timelineResourceRows,
} from '../../app/utils/timeline-resource-rows';
import type { WireExecutionResources, WireResourceReport } from '../../shared/types';

const STARTED = 1_000_000;
const MB = 1024 * 1024;

function report(extra: Partial<WireResourceReport> = {}): WireResourceReport {
  return {
    v: 1,
    findings: [],
    counts: { leaked: 0, idle: 0, piling: 0, handle: 0, probable: 0 },
    profile: null,
    workers: [],
    artifactBytes: {},
    workerHealth: null,
    timeline: {
      startedAt: STARTED,
      cpuPct: [],
      memoryBytes: [],
      pages: [
        {
          worker: 1,
          points: [
            [0, 1],
            [4_000, 3],
            [9_000, 1],
          ],
        },
        { worker: 2, points: [[0, 7]] },
      ],
      workers: [
        {
          worker: 1,
          cpuCores: [
            [1_000, 0.5],
            [2_000, 1.5],
            [3_000, 2],
            [4_000, 1],
            [5_000, 0.2],
            [6_000, 0.1],
          ],
          memoryBytes: [
            [0, 100 * MB],
            [5_000, 300 * MB],
            [10_000, 200 * MB],
          ],
        },
      ],
    },
    ...extra,
  };
}

const cost: WireExecutionResources = {
  workerCpuMs: 300,
  roles: {
    renderer: { cpuMs: 900, runWaitMs: 420.4, peakRssMb: 120, processes: 2 },
    browser: { cpuMs: 200, runWaitMs: 10, peakRssMb: 90, processes: 1 },
  },
  loopUtilization: 0.2,
  loopDelayP99Ms: 4,
  involuntarySwitches: 10,
  heapUsedMb: 80,
  openAtStart: { contexts: 2, pages: 2 },
  leftOpen: 0,
};

describe('timelineResources', () => {
  test("slices the test's worker onto the timeline's clock, keeping a reading on each side of it", () => {
    const resources = timelineResources({
      parts: [report()],
      shardIndex: null,
      workerIndex: 1,
      origin: STARTED + 2_500,
      end: STARTED + 4_500,
      cost,
    });
    expect(resources?.cpuCores).toEqual([
      [-500, 1.5],
      [500, 2],
      [1_500, 1],
      [2_500, 0.2],
    ]);
    expect(resources?.memoryBytes).toEqual([
      [-2_500, 100 * MB],
      [2_500, 300 * MB],
    ]);
    expect(resources?.openPages).toEqual([
      [-2_500, 1],
      [1_500, 3],
      [6_500, 1],
    ]);
    expect(resources).toMatchObject({ openAtStart: 2, runWaitMs: 430 });
  });

  test('holds a level set before the axis across it', () => {
    const resources = timelineResources({
      parts: [report()],
      shardIndex: null,
      workerIndex: 2,
      origin: STARTED + 2_000,
      end: STARTED + 3_000,
      cost: null,
    });
    expect(resources?.openPages).toEqual([
      [-2_000, 7],
      [1_000, 7],
    ]);
    expect(resources?.cpuCores).toEqual([]);
  });

  test("reads the execution's shard of a sharded run, and nothing without any measure", () => {
    const parts = [report({ shardIndex: 1, timeline: null }), report({ shardIndex: 2 })];
    expect(
      timelineResources({ parts, shardIndex: 2, workerIndex: 1, origin: STARTED, end: STARTED + 1_000, cost: null })
        ?.cpuCores.length,
    ).toBeGreaterThan(0);
    expect(
      timelineResources({ parts, shardIndex: 1, workerIndex: 1, origin: STARTED, end: STARTED + 1_000, cost: null }),
    ).toBeNull();
  });
});

describe('timelineResourceRows', () => {
  const resources = timelineResources({
    parts: [report()],
    shardIndex: null,
    workerIndex: 1,
    origin: STARTED + 2_500,
    end: STARTED + 4_500,
    cost,
  });

  test('draws CPU, memory and pages, each on its own scale', () => {
    const rows = timelineResourceRows(resources);
    expect(rows.map((row) => [row.kind, row.yMax, row.step])).toEqual([
      ['cpu', 2, false],
      ['memory', 300 * MB, false],
      ['pages', 3, true],
    ]);
    expect(timelineResourceRows(null)).toEqual([]);
  });

  test('reads each row at a moment: the interval it falls in, or the level held', () => {
    const [cpu, , pages] = timelineResourceRows(resources);
    expect(readingAt(cpu!, 0)).toBe(2);
    expect(readingAt(pages!, 0)).toBe(1);
    expect(readingAt(pages!, 2_000)).toBe(3);
    expect(resourceReadout(timelineResourceRows(resources), 0)).toBe('2 cores · 300 MB · 1 open page');
  });

  test('says what the test found open and how long its browsers waited', () => {
    expect(resourceFacts(resources)).toEqual([
      '2 pages earlier tests left open in its worker when it started',
      'its browsers waited 430 ms for a CPU',
    ]);
  });
});

describe('the new findings, as stored and read', () => {
  test('keeps a worker piling up and a child process left running', () => {
    const stored = sanitizeResourceReport({
      ...report(),
      findings: [
        {
          verdict: 'piling',
          kind: 'worker',
          where: 'worker process',
          tests: 40,
          count: 1,
          growth: { what: 'heapMb', from: 143, to: 1852, tests: 40 },
        },
        {
          verdict: 'handle',
          kind: 'handle',
          where: 'ChildProcess',
          site: 'tests/mock.spec.ts:12',
          tests: 1,
          count: 1,
          detail: '"starts the mock" (tests/mock.spec.ts)',
        },
      ],
    });
    const [heap, child] = stored!.findings;
    expect(findingView(heap!)).toMatchObject({
      label: 'Piling up worker heap',
      facts: ['143 → 1852 MB after garbage collection over 40 tests'],
    });
    expect(findingView(child!)).toMatchObject({ label: 'Left running process', site: 'tests/mock.spec.ts:12' });
  });
});
