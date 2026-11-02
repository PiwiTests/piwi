import { describe, test, expect } from 'vitest';
import {
  CASE_STATUS_SERIES,
  RUN_STATUS_SERIES,
  barGeometry,
  dayTickIndices,
  formatTickDate,
  legendOf,
  niceTicks,
  stackSegments,
  timeToOrdinalX,
} from '../../app/utils/chart';

describe('niceTicks', () => {
  test('spans 0 to the first round step multiple clearing max', () => {
    expect(niceTicks(10)).toEqual([0, 5, 10]);
    expect(niceTicks(8)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(1234)).toEqual([0, 500, 1000, 1500]);
  });

  test('handles zero, negative and non-finite maxima', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(-5)).toEqual([0, 1]);
    expect(niceTicks(Number.NaN)).toEqual([0, 1]);
  });

  test('exact multiples do not grow an extra tick', () => {
    expect(niceTicks(20)).toEqual([0, 5, 10, 15, 20]);
  });
});

describe('dayTickIndices', () => {
  const day = (d: number, h = 0) => new Date(2026, 6, d, h);

  test('labels the first point and each day change', () => {
    const dates = [day(1, 9), day(1, 15), day(2, 9), day(2, 11), day(3, 8)];
    expect(dayTickIndices(dates, 6)).toEqual([0, 2, 4]);
  });

  test('thins day starts down to the tick budget', () => {
    const dates = Array.from({ length: 10 }, (_, i) => day(i + 1));
    expect(dayTickIndices(dates, 5).length).toBeLessThanOrEqual(5);
    expect(dayTickIndices(dates, 5)[0]).toBe(0);
  });

  test('empty input and zero budget yield no ticks', () => {
    expect(dayTickIndices([], 5)).toEqual([]);
    expect(dayTickIndices([day(1)], 0)).toEqual([]);
  });
});

describe('timeToOrdinalX', () => {
  const dates = [new Date(1000), new Date(2000), new Date(4000)];
  const centers = [10, 30, 50];

  test('interpolates between the neighboring centers', () => {
    expect(timeToOrdinalX(dates, centers, 1500)).toBe(20);
    expect(timeToOrdinalX(dates, centers, 3000)).toBe(40);
  });

  test('maps exact point times to their centers', () => {
    expect(timeToOrdinalX(dates, centers, 1000)).toBe(10);
    expect(timeToOrdinalX(dates, centers, 4000)).toBe(50);
  });

  test('returns null outside the plotted range', () => {
    expect(timeToOrdinalX(dates, centers, 500)).toBeNull();
    expect(timeToOrdinalX(dates, centers, 5000)).toBeNull();
  });

  test('handles a single point', () => {
    expect(timeToOrdinalX([new Date(1000)], [25], 1000)).toBe(25);
    expect(timeToOrdinalX([new Date(1000)], [25], 1001)).toBeNull();
  });

  test('returns null when there is nothing to map onto', () => {
    expect(timeToOrdinalX([], [], 1000)).toBeNull();
    expect(timeToOrdinalX(dates, [10, 30], 1500)).toBeNull();
  });
});

describe('legendOf', () => {
  test('keeps series order and drops everything but color and label', () => {
    expect(legendOf(CASE_STATUS_SERIES)).toEqual([
      { color: 'var(--color-status-passed)', label: 'Passed' },
      { color: 'var(--color-status-flaky)', label: 'Passed on retry' },
      { color: 'var(--color-status-failed)', label: 'Failed' },
      { color: 'var(--color-status-skipped)', label: 'Skipped' },
      { color: 'var(--color-status-didnotrun)', label: "Didn't run" },
      { color: 'var(--color-status-interrupted)', label: 'Interrupted' },
    ]);
  });

  test('run-status series stack with failed on the baseline', () => {
    expect(RUN_STATUS_SERIES.map((s) => s.key)).toEqual(['failed', 'flaky', 'skipped', 'fixme', 'didNotRun', 'passed']);
  });

  test('run-status series take the test outcome palette colors', () => {
    expect(RUN_STATUS_SERIES.map((s) => s.color)).toEqual([
      'var(--color-status-failed)',
      'var(--color-status-flaky)',
      'var(--color-status-skipped)',
      'var(--color-status-fixme)',
      'var(--color-status-didnotrun)',
      'var(--color-status-passed)',
    ]);
  });
});

describe('formatTickDate', () => {
  test('renders a short month and day', () => {
    expect(formatTickDate(new Date(2026, 6, 29))).toBe('Jul 29');
  });
});

describe('barGeometry', () => {
  test('splits the plot into equal slots with centered bars', () => {
    const geo = barGeometry(10, 300);
    expect(geo.slotWidth).toBe(30);
    expect(geo.centerOf(0)).toBe(15);
    expect(geo.centerOf(9)).toBe(285);
    expect(geo.xOf(0) + geo.barWidth / 2).toBeCloseTo(15);
  });

  test('caps the bar width for sparse data', () => {
    expect(barGeometry(2, 600).barWidth).toBe(24);
  });

  test('keeps bars visible when slots get tight', () => {
    expect(barGeometry(200, 300).barWidth).toBe(2);
  });
});

describe('stackSegments', () => {
  const yScale = (v: number) => 100 - v;

  test('stacks bottom-up in series order', () => {
    const segments = stackSegments(
      [
        { color: 'red', value: 20 },
        { color: 'green', value: 30 },
      ],
      100,
      yScale,
    );
    expect(segments).toEqual([
      { color: 'red', y: 80, height: 20 },
      { color: 'green', y: 50, height: 30 },
    ]);
  });

  test('skips zero values entirely', () => {
    const segments = stackSegments(
      [
        { color: 'red', value: 0 },
        { color: 'green', value: 50 },
      ],
      100,
      yScale,
    );
    expect(segments).toEqual([{ color: 'green', y: 50, height: 50 }]);
  });

  test('bumps tiny non-zero values to a visible minimum, taking it from the tallest', () => {
    const scale = (v: number) => 100 - v / 10;
    const segments = stackSegments(
      [
        { color: 'red', value: 5 },
        { color: 'green', value: 995 },
      ],
      100,
      scale,
    );
    expect(segments[0]).toEqual({ color: 'red', y: 98, height: 2 });
    expect(segments[1]?.height).toBeCloseTo(98);
    expect(segments.reduce((sum, s) => sum + s.height, 0)).toBeCloseTo(100);
  });
});
