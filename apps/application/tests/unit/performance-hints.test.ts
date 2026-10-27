import { describe, test, expect } from 'vitest';
import { getPerformanceHints } from '../../app/utils/performance-hints';

describe('getPerformanceHints', () => {
  test('returns [] for a falsy test case', () => {
    expect(getPerformanceHints(null as never)).toEqual([]);
  });

  test('returns [] when there is nothing noteworthy', () => {
    expect(getPerformanceHints({ status: 'passed', retries: 0, steps: [] })).toEqual([]);
  });

  test('flags a slow navigation step (> 3s), picking the slowest one', () => {
    const hints = getPerformanceHints({
      steps: [
        { title: 'page.goto fast', duration: 1000, category: 'navigation' },
        { title: 'page.goto slow', duration: 5000, category: 'navigation' },
      ],
    });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ type: 'warning', message: 'Slow navigation detected' });
    expect(hints[0]!.details).toContain('page.goto slow');
    expect(hints[0]!.details).toContain('5.0s');
  });

  test('reads a step’s own time, its time paused at a breakpoint left out', () => {
    const T = 1_700_000_000_000;
    const steps = [
      { title: 'Navigate', duration: 4_200, category: 'navigation', startTime: T },
      { title: 'Expect "toBeVisible"', duration: 7_300, category: 'assertion', startTime: T + 4_300 },
    ];
    const pauses = [
      { startedAt: T + 50, duration: 4_100 },
      { startedAt: T + 4_350, duration: 6_300 },
    ];
    expect(getPerformanceHints({ steps, pauses })).toEqual([]);
    const slow = getPerformanceHints({ steps, pauses: [{ startedAt: T + 4_350, duration: 3_000 }] });
    expect(slow.map((h) => h.details)).toEqual([
      expect.stringMatching(/^"Navigate" took 4\.2s\. /),
      expect.stringMatching(/^"Expect "toBeVisible"" took 4\.3s, not counting 3\.0s paused at a breakpoint\. /),
    ]);
  });

  test('flags a test with more than 20 steps', () => {
    const steps = Array.from({ length: 21 }, (_, i) => ({ title: `step ${i}`, duration: 10, category: 'action' }));
    const hints = getPerformanceHints({ steps });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ type: 'info', message: 'Many sequential actions' });
    expect(hints[0]!.details).toContain('21 steps');
  });

  test('flags a passed test that needed retries (flaky)', () => {
    const hints = getPerformanceHints({ status: 'passed', retries: 2, steps: [] });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ type: 'warning', message: 'Flaky test — passed after retries' });
    expect(hints[0]!.details).toContain('2 retries');
  });

  test('does not flag retries on a failed test', () => {
    expect(getPerformanceHints({ status: 'failed', retries: 2, steps: [] })).toEqual([]);
  });

  test('flags a slow assertion (> 2s), picking the slowest one', () => {
    const hints = getPerformanceHints({
      steps: [
        { title: 'expect visible', duration: 500, category: 'assertion' },
        { title: 'expect count', duration: 3000, category: 'assertion' },
      ],
    });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ type: 'info', message: 'Slow assertions detected' });
    expect(hints[0]!.details).toContain('expect count');
  });

  test('can surface multiple hints at once', () => {
    const hints = getPerformanceHints({
      status: 'passed',
      retries: 1,
      steps: [{ title: 'page.goto', duration: 4000, category: 'navigation' }],
    });
    expect(hints.map((h) => h.message).sort()).toEqual([
      'Flaky test — passed after retries',
      'Slow navigation detected',
    ]);
  });
});
