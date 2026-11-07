import { describe, test, expect } from 'vitest';
import {
  MAX_TAIL_LEVELS,
  buildSpanTails,
  leftOpenAcross,
  leftOpenPages,
  minSteps,
  tailAt,
  tailsPath,
} from '../../app/utils/resource-spans';
import type { WorkerRow } from '../../app/composables/useTimelineModel';
import type { RunResourceTimelinePart } from '../../shared/handlers/run-resources';
import type { WireResourceSpan } from '../../shared/types';

const row = (shardIndex: number | null, slot: number, processes: number[], baseLane: number): WorkerRow => ({
  shardIndex,
  slot,
  processes,
  baseLane,
  laneSpan: 1,
});

const span = (worker: number, from: number, to: number, extra: Partial<WireResourceSpan> = {}): WireResourceSpan => ({
  worker,
  verdict: 'leaked',
  kind: 'context',
  where: 'tests/cart.spec.ts:4',
  from,
  to,
  pages: 1,
  ...extra,
});

const part = (shardIndex: number | null, spans: WireResourceSpan[]): RunResourceTimelinePart => ({
  shardIndex,
  memoryCapacityBytes: null,
  memoryKind: null,
  timeline: { startedAt: 9_000, cpuPct: [], memoryBytes: [], pages: [], spans },
});

describe('buildSpanTails', () => {
  test('puts each span under the row of the worker that held it, on the timeline’s clock', () => {
    const rows = buildSpanTails(
      [
        part(null, [
          span(0, 1000, 5000, { untilWorkerEnd: true, scope: 'test', lastUse: 'tests/cart.spec.ts:6' }),
          span(2, 7000, 8000, { verdict: 'lingering', kind: 'page' }),
          span(1, 2000, 3000),
          span(9, 0, 1),
        ]),
      ],
      [row(null, 0, [0, 2], 0), row(null, 1, [1], 1)],
      10_000,
      false,
    );
    expect(rows.map((r) => [r.lane, r.levels, r.tails.length])).toEqual([
      [0, 1, 2],
      [1, 1, 1],
    ]);
    expect(rows[0]!.tails[0]).toMatchObject({
      verdict: 'leaked',
      kind: 'context',
      start: 0,
      end: 4000,
      untilWorkerEnd: true,
      scope: 'test',
      lastUse: 'tests/cart.spec.ts:6',
      rowName: 'Worker 1',
      level: 0,
    });
    expect(rows[0]!.tails[1]).toMatchObject({ verdict: 'lingering', start: 6000, end: 7000, level: 0 });
  });

  test('stacks overlapping tails on sub-lines, at most three, sharing the line that frees first past them', () => {
    const [only] = buildSpanTails(
      [part(1, [span(0, 0, 9000), span(0, 1000, 2000), span(0, 1500, 9000), span(0, 1600, 3000), span(0, 2500, 4000)])],
      [row(1, 0, [0], 0)],
      9_000,
      true,
    );
    expect(only!.levels).toBe(MAX_TAIL_LEVELS);
    expect(only!.tails.map((t) => [t.start, t.level])).toEqual([
      [0, 0],
      [1000, 1],
      [1500, 2],
      [1600, 1],
      [2500, 1],
    ]);
    expect(only!.tails[0]!.rowName).toBe('S1 W1');
  });
});

describe('the pages left open, and the tail under the pointer', () => {
  const [tails] = buildSpanTails(
    [
      part(null, [
        span(0, 1000, 5000, { pages: 2 }),
        span(0, 2000, 3000),
        span(0, 2500, 2600, { verdict: 'lingering', kind: 'page' }),
      ]),
    ],
    [row(null, 0, [0], 0)],
    9_000,
    false,
  );

  test('counts the leaks’ pages over time, the lingering ones left out', () => {
    expect(leftOpenPages(tails!.tails)).toEqual([
      [1000, 2],
      [2000, 3],
      [3000, 2],
      [5000, 0],
    ]);
    expect(leftOpenAcross([tails!, { lane: 1, levels: 1, tails: [] }])).toEqual(leftOpenPages(tails!.tails));
  });

  test('finds the tail on a sub-line at a moment, the shortest when several cover it', () => {
    expect(tailAt(tails!, 2550, 1)?.verdict).toBe('leaked');
    expect(tailAt(tails!, 2550, 2)?.verdict).toBe('lingering');
    expect(tailAt(tails!, 6000, 0)).toBeNull();
  });

  test('draws each verdict’s tails at their sub-lines', () => {
    expect(tailsPath(tails!.tails, 'lingering', 4, 6)).toBe('M2500,12H2600V16H2500Z');
    expect(tailsPath(tails!.tails, 'leaked', 4, 6)).toBe('M1000,0H5000V4H1000ZM2000,6H3000V10H2000Z');
  });
});

describe('minSteps', () => {
  test('holds the pages left open to the pages open, at every change of either', () => {
    expect(
      minSteps(
        [
          [1000, 3],
          [5000, 0],
        ],
        [
          [0, 1],
          [2000, 4],
          [4000, 2],
          [6000, 0],
        ],
      ),
    ).toEqual([
      [0, 0],
      [1000, 1],
      [2000, 3],
      [4000, 2],
      [5000, 0],
    ]);
    expect(minSteps([], [[0, 1]])).toEqual([]);
  });
});
