import { describe, test, expect } from 'vitest';
import { collectStepMetrics, pauseSpans, pausedOverlap, unpausedDuration } from '../src/step-analysis';

const T = 1_700_000_000_000;

describe('pauseSpans', () => {
  test('reads the stops among a test’s step events, and nothing else', () => {
    expect(
      pauseSpans([
        { title: 'Before Hooks', category: 'hook', startedAt: T, duration: 50, status: 'passed' },
        { title: "Click getByRole('button')", category: 'pause', startedAt: T + 100, duration: 4000, status: 'step' },
        { title: 'broken', category: 'pause', startedAt: 'soon', duration: 1 },
        null,
      ]),
    ).toEqual([expect.objectContaining({ startedAt: T + 100, duration: 4000 })]);
    expect(pauseSpans(null)).toEqual([]);
    expect(pauseSpans({ category: 'pause' })).toEqual([]);
  });
});

describe('pausedOverlap', () => {
  const pauses = [
    { startedAt: T + 1000, duration: 2000 },
    // Two contexts stopped at once count once.
    { startedAt: T + 2500, duration: 1000 },
    { startedAt: T + 9000, duration: 500 },
  ];

  test('counts the time a span ran while the test stood stopped, overlapping stops once', () => {
    expect(pausedOverlap(T, 10_000, pauses)).toBe(3000);
    expect(pausedOverlap(T + 2000, 1000, pauses)).toBe(1000);
    expect(pausedOverlap(new Date(T + 3200), 1000, pauses)).toBe(300);
    expect(pausedOverlap(T + 4000, 4000, pauses)).toBe(0);
  });

  test('is zero without a start, a duration or a stop', () => {
    expect(pausedOverlap(undefined, 10_000, pauses)).toBe(0);
    expect(pausedOverlap(T, -1, pauses)).toBe(0);
    expect(pausedOverlap(T, 10_000, [])).toBe(0);
  });

  test('leaves a step its own time, and no less than nothing', () => {
    expect(unpausedDuration({ startTime: T + 900, duration: 2150 }, pauses)).toBe(100);
    expect(unpausedDuration({ startTime: T + 1000, duration: 2000 }, pauses)).toBe(0);
    expect(unpausedDuration({ duration: 2000 }, pauses)).toBe(2000);
  });
});

describe('collectStepMetrics with stops', () => {
  // A click held 4 s at a breakpoint, and a wait that ran across the stop.
  const steps = [
    { title: 'Navigate', category: 'pw:api', startTime: new Date(T), duration: 300, params: { url: '/a' }, steps: [] },
    { title: 'Click', category: 'pw:api', startTime: new Date(T + 300), duration: 4050, steps: [] },
    { title: 'Wait for timeout', category: 'pw:api', startTime: new Date(T + 200), duration: 4500, steps: [] },
  ];
  const pauses = [{ startedAt: T + 310, duration: 4000 }];

  test('keeps each step’s measured duration and leaves the stopped time out of every figure', () => {
    const metrics = collectStepMetrics(steps, null, pauses);
    expect(metrics.steps.map((s) => s.duration)).toEqual([300, 4050, 4500]);
    expect(metrics.slowestStep).toEqual({ title: 'Wait for timeout', duration: 500 });
    expect(metrics.waitTotalDuration).toBe(500);
    expect(metrics.navigationTotalDuration).toBe(300);
    expect(metrics.totalStepDuration).toBe(300 + 50 + 500);
  });

  test('reads the measured durations without stops', () => {
    const metrics = collectStepMetrics(steps);
    expect(metrics.slowestStep).toEqual({ title: 'Wait for timeout', duration: 4500 });
    expect(metrics.waitTotalDuration).toBe(4500);
  });
});
