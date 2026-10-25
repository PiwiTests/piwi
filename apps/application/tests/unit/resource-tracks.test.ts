import { describe, test, expect } from 'vitest';
import {
  ALL_RESOURCE_TRACKS,
  availableWorkerMetrics,
  buildResourceBands,
  buildWorkerStrips,
  formatTrackValue,
  layOutTimelineRows,
  shownTracks,
  spansPath,
  stripReading,
  sumSteps,
  trackPaths,
  valueAt,
} from '../../app/utils/resource-tracks';
import type { TimelineItem, WorkerRow } from '../../app/composables/useTimelineModel';
import type { RunExecutionCost, RunResourceTimelinePart } from '../../shared/handlers/run-resources';

const GB = 1024 ** 3;

const row = (shardIndex: number | null, slot: number, processes: number[], baseLane: number): WorkerRow => ({
  shardIndex,
  slot,
  processes,
  baseLane,
  laneSpan: 1,
});

const part = (shardIndex: number | null, extra: Partial<RunResourceTimelinePart> = {}): RunResourceTimelinePart => ({
  shardIndex,
  memoryCapacityBytes: 16 * GB,
  memoryKind: 'pss',
  timeline: {
    startedAt: 9_000,
    cpuPct: [
      [1000, 40],
      [3000, 80],
    ],
    memoryBytes: [
      [0, 2 * GB],
      [5000, 4 * GB],
    ],
    pages: [
      {
        worker: 0,
        points: [
          [1000, 1],
          [2000, 2],
          [6000, 0],
        ],
      },
      // A second process on worker 0's lane, after the first one ended.
      {
        worker: 2,
        points: [
          [7000, 1],
          [8000, 0],
        ],
      },
      {
        worker: 1,
        points: [
          [1500, 1],
          [3000, 0],
        ],
      },
    ],
  },
  ...extra,
});

describe('sumSteps', () => {
  test('adds step series at each change of any of them', () => {
    expect(
      sumSteps([
        [
          [0, 1],
          [10, 2],
        ],
        [
          [5, 3],
          [10, 0],
        ],
      ]),
    ).toEqual([
      [0, 1],
      [5, 4],
      [10, 2],
    ]);
  });
});

describe('buildResourceBands', () => {
  test('puts a reporter’s series on the timeline’s clock, its pages by lane', () => {
    const [band] = buildResourceBands([part(null)], [row(null, 0, [0, 2], 0), row(null, 1, [1], 1)], 10_000, false);
    expect(band).toMatchObject({ key: 'resources-all', prefix: null, firstLane: 0, memoryKind: 'pss' });
    // The reporter's clock starts a second before the first test.
    expect(band!.tracks.cpu!.points).toEqual([
      [0, 40],
      [2000, 80],
    ]);
    expect(band!.tracks.memory).toMatchObject({ yMax: 4 * GB, atCapacity: false, scaleLabel: 'peak 4.0 GB' });
    expect(band!.workers).toEqual([
      {
        name: 'Worker 0',
        lane: 0,
        points: [
          [0, 1],
          [1000, 2],
          [5000, 0],
          [6000, 1],
          [7000, 0],
        ],
      },
      {
        name: 'Worker 1',
        lane: 1,
        points: [
          [500, 1],
          [2000, 0],
        ],
      },
    ]);
    expect(band!.tracks.pages).toMatchObject({ yMax: 3, step: true, scaleLabel: 'peak 3' });
    expect(band!.tracks.pages!.points).toEqual([
      [0, 1],
      [500, 2],
      [1000, 3],
      [2000, 2],
      [5000, 0],
      [6000, 1],
      [7000, 0],
    ]);
  });

  test('draws memory against the container’s limit when the run came close to it', () => {
    const [band] = buildResourceBands(
      [part(null, { memoryCapacityBytes: 5 * GB })],
      [row(null, 0, [0], 0)],
      9_000,
      false,
    );
    expect(band!.tracks.memory).toMatchObject({ yMax: 5 * GB, atCapacity: true, scaleLabel: 'limit 5.0 GB' });
  });

  test('places each shard’s band above its own rows, and leaves out a shard with none', () => {
    const rows = [row(1, 0, [0], 0), row(1, 1, [1], 1), row(2, 0, [0], 2), row(2, 1, [1, 2], 3)];
    const bands = buildResourceBands([part(2), part(1), part(3)], rows, 9_000, true);
    expect(bands.map((b) => [b.key, b.firstLane, b.prefix])).toEqual([
      ['resources-1', 0, 'S1'],
      ['resources-2', 2, 'S2'],
    ]);
    expect(bands[1]!.workers.map((w) => w.name)).toEqual(['S2 W0', 'S2 W1']);
  });

  test('pairs a single reporter with a single shard of rows whatever their numbers', () => {
    expect(buildResourceBands([part(null)], [row(3, 0, [0], 0)], 9_000, false)).toHaveLength(1);
  });

  test('leaves out the tracks a reporter could not measure', () => {
    const [band] = buildResourceBands(
      [part(null, { timeline: { startedAt: 9_000, cpuPct: [], memoryBytes: [], pages: part(null).timeline.pages } })],
      [row(null, 0, [0], 0)],
      9_000,
      false,
    );
    expect(band!.tracks.cpu).toBeNull();
    expect(band!.tracks.memory).toBeNull();
    expect(shownTracks(band!, ALL_RESOURCE_TRACKS).map((t) => t.kind)).toEqual(['pages']);
    expect(shownTracks(band!, { ...ALL_RESOURCE_TRACKS, pages: false })).toEqual([]);
  });
});

describe('valueAt', () => {
  const points: Array<[number, number]> = [
    [1000, 10],
    [3000, 30],
  ];

  test('holds a step series’ level, zero before it starts', () => {
    expect(valueAt(points, 500, true)).toBe(0);
    expect(valueAt(points, 2999, true)).toBe(10);
    expect(valueAt(points, 9000, true)).toBe(30);
  });

  test('reads a sampled series’ nearest reading, and nothing far from any', () => {
    expect(valueAt(points, 1900, false)).toBe(10);
    expect(valueAt(points, 2100, false)).toBe(30);
    expect(valueAt(points, 20_000, false)).toBeNull();
    expect(valueAt([], 0, false)).toBeNull();
  });
});

describe('trackPaths', () => {
  test('draws a reading as a line and a level as steps, x in ms', () => {
    const base = { kind: 'cpu' as const, yMax: 100, atCapacity: false, scaleLabel: '100%' };
    expect(
      trackPaths(
        {
          ...base,
          step: false,
          points: [
            [0, 0],
            [1000, 50],
            [2000, 150],
          ],
        },
        20,
      ),
    ).toEqual({ line: 'M0,20L1000,10L2000,0', area: 'M0,20L0,20L1000,10L2000,0L2000,20Z' });
    expect(
      trackPaths(
        {
          ...base,
          step: true,
          points: [
            [0, 50],
            [1000, 100],
          ],
        },
        20,
      ).line,
    ).toBe('M0,10H1000V0');
  });
});

describe('formatTrackValue', () => {
  test('reads each track in its unit', () => {
    expect(formatTrackValue('cpu', 63.4)).toBe('63%');
    expect(formatTrackValue('memory', 2.5 * GB)).toBe('2.5 GB');
    expect(formatTrackValue('pages', 4)).toBe('4 open');
  });
});

describe('the strip under each worker', () => {
  const rows = [row(null, 0, [0, 2], 0), row(null, 1, [1], 1)];
  const [band] = buildResourceBands([part(null)], rows, 10_000, false);
  const bar = (executionId: number, rowIndex: number, start: number, duration: number): TimelineItem => ({
    key: `t${executionId}`,
    kind: 'test',
    testCaseId: executionId,
    title: `test ${executionId}`,
    status: 'passed',
    workerIndex: rowIndex,
    start,
    duration,
    rowIndex,
  });
  const tests = [bar(1, 0, 0, 2000), bar(2, 0, 2000, 4000), bar(3, 1, 0, 1000)];
  const costs: RunExecutionCost[] = [
    { executionId: 1, cpuMs: 3000, runWaitMs: 500, peakRssMb: 200 },
    { executionId: 2, cpuMs: 2000, runWaitMs: null, peakRssMb: 300 },
    { executionId: 3, cpuMs: 500, runWaitMs: 0, peakRssMb: null },
  ];
  const input = { rows, bands: [band!], tests, costs, sharded: false };

  test('offers only the metrics the run measured', () => {
    expect(availableWorkerMetrics([band!], costs)).toEqual(['pages', 'cpu', 'wait', 'memory']);
    expect(availableWorkerMetrics([], [{ executionId: 1, cpuMs: 1, runWaitMs: null, peakRssMb: null }])).toEqual([
      'cpu',
    ]);
  });

  test('draws each worker’s open pages on one scale', () => {
    const set = buildWorkerStrips('pages', input)!;
    expect(set).toMatchObject({ yMax: 2, scaleLabel: '2 pages' });
    expect(set.strips.map((strip) => [strip.name, strip.mode, strip.points.length])).toEqual([
      ['Worker 0', 'step', 5],
      ['Worker 1', 'step', 2],
    ]);
    expect(stripReading(set, set.strips[0]!, 1500)).toBe('2 open');
  });

  test('draws what each test cost across its bar', () => {
    const cpu = buildWorkerStrips('cpu', input)!;
    expect(cpu).toMatchObject({ yMax: 1.5, scaleLabel: '1.5 cores' });
    expect(cpu.strips.map((strip) => strip.mode)).toEqual(['spans', 'spans']);
    expect(cpu.strips[0]!.spans).toEqual([
      { start: 0, end: 2000, value: 1.5, title: 'test 1' },
      { start: 2000, end: 6000, value: 0.5, title: 'test 2' },
    ]);
    expect(stripReading(cpu, cpu.strips[0]!, 3000)).toBe('0.5 cores for “test 2”');
    expect(stripReading(cpu, cpu.strips[1]!, 3000)).toBeNull();

    // A test whose platform could not tell the wait is left out, not drawn at zero.
    const wait = buildWorkerStrips('wait', input)!;
    expect(wait.strips[0]!.spans.map((span) => span.value)).toEqual([25]);
    expect(wait.strips[1]!.spans.map((span) => span.value)).toEqual([0]);
    expect(stripReading(wait, wait.strips[0]!, 100)).toBe('25% of “test 1” waiting for a CPU');

    const memory = buildWorkerStrips('memory', input)!;
    expect(memory).toMatchObject({ scaleLabel: '300 MB' });
    expect(stripReading(memory, memory.strips[0]!, 2500)).toBe('300 MB, the largest browser process of “test 2”');
  });

  test('measures a test against the duration Playwright reported, not its hooks', () => {
    const longBar = { ...bar(1, 0, 0, 6000), reportedDuration: 2000 };
    const set = buildWorkerStrips('cpu', { ...input, tests: [longBar] })!;
    expect(set.strips[0]!.spans[0]).toMatchObject({ end: 6000, value: 1.5 });
  });

  test('measures a test that stood paused at the pause bar against its own time, which Playwright reports', () => {
    const pausedBar = { ...bar(1, 0, 0, 6000), reportedDuration: 2000, pausedMs: 4000 };
    const set = buildWorkerStrips('cpu', { ...input, tests: [pausedBar] })!;
    expect(set.strips[0]!.spans[0]).toMatchObject({ end: 6000, value: 1.5 });
  });

  test('draws the sampler’s readings of a worker’s processes, and per-test values where it read none', () => {
    const sampledPart = part(null, {
      timeline: {
        ...part(null).timeline,
        // Worker 0 ran as two processes, 0 then 2, one after another.
        workers: [
          {
            worker: 0,
            cpuCores: [
              [1000, 0.8],
              [2000, 1.6],
            ],
            memoryBytes: [[1000, 600 * 1024 ** 2]],
          },
          { worker: 2, cpuCores: [[7500, 0.4]], memoryBytes: [[7500, 800 * 1024 ** 2]] },
        ],
      },
    });
    const [sampledBand] = buildResourceBands([sampledPart], rows, 10_000, false);
    expect(sampledBand!.sampled).toEqual([
      {
        lane: 0,
        cpuCores: [
          [0, 0.8],
          [1000, 1.6],
          [6500, 0.4],
        ],
        memoryBytes: [
          [0, 600 * 1024 ** 2],
          [6500, 800 * 1024 ** 2],
        ],
      },
    ]);
    const cpu = buildWorkerStrips('cpu', { ...input, bands: [sampledBand!] })!;
    expect(cpu.strips.map((strip) => strip.mode)).toEqual(['line', 'spans']);
    expect(cpu.strips[0]!.spans).toEqual([]);
    expect(cpu.yMax).toBe(1.6);
    expect(stripReading(cpu, cpu.strips[0]!, 900)).toBe('1.6 cores, the worker and its browsers');
    const memory = buildWorkerStrips('memory', { ...input, bands: [sampledBand!] })!;
    expect(stripReading(memory, memory.strips[0]!, 6000)).toBe('800 MB, the worker and its browsers (PSS)');
    expect(availableWorkerMetrics([sampledBand!], [])).toEqual(['pages', 'cpu', 'memory']);
  });

  test('is null for a metric no row has', () => {
    expect(buildWorkerStrips('memory', { ...input, costs: [] })).toBeNull();
    expect(buildWorkerStrips('pages', { ...input, bands: [] })).toBeNull();
  });

  test('draws a bar per test from the baseline', () => {
    expect(spansPath([{ start: 0, end: 10, value: 1, title: 'a' }], 2, 10)).toBe('M0,10V5H10V10Z');
  });
});

describe('layOutTimelineRows', () => {
  const rows = [row(1, 0, [0], 0), { ...row(1, 1, [1], 1), laneSpan: 2 }, row(2, 0, [0], 3)];
  const sizes = { stripHeight: 12, rowHeight: 32, rowGap: 8, axisHeight: 28 };

  test('stacks the rows under the axis, each band right above its shard’s first row', () => {
    const layout = layOutTimelineRows(rows, {
      ...sizes,
      bandHeights: new Map([
        [0, 50],
        [3, 40],
      ]),
      strips: false,
    });
    expect(layout.laneTop).toEqual([78, 110, 142, 214]);
    expect([...layout.bandTop.entries()]).toEqual([
      [0, 28],
      [3, 174],
    ]);
    expect(layout.rows.map((r) => [r.sectionTop, r.top, r.bottom, r.stripTop])).toEqual([
      [28, 78, 110, null],
      [110, 110, 174, null],
      [174, 214, 246, null],
    ]);
    expect(layout.height).toBe(246);
  });

  test('puts a strip under each row’s lanes, after its expanded steps', () => {
    const layout = layOutTimelineRows(rows, { ...sizes, bandHeights: new Map(), strips: true });
    expect(layout.rows.map((r) => [r.top, r.stripTop, r.bottom])).toEqual([
      [28, 54, 72],
      [72, 130, 148],
      [148, 174, 192],
    ]);
    expect(layout.height).toBe(192);
  });
});
