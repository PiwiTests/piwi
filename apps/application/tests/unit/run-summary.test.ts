import { describe, expect, test } from 'vitest';
import { runSummaryText } from '../../app/utils/run-summary';

const run = {
  id: 42,
  status: 'failed',
  label: 'nightly',
  project: 'shop',
  duration: 25 * 60_000,
  total: 120,
  passed: 110,
  failed: 6,
  skipped: 4,
  fixme: 1,
  flaky: 2,
  didNotRun: 0,
};

describe('runSummaryText', () => {
  test('says how long the run took in human units', () => {
    expect(runSummaryText(run)).toContain('Duration: 25 minutes');
    expect(runSummaryText({ ...run, duration: 90 * 60_000 + 30_000 })).toContain('Duration: 1 hour 30 minutes');
  });

  test('carries the outcome and the counts', () => {
    expect(runSummaryText(run)).toBe(
      [
        '*Run #42* — nightly',
        'Status: ❌ failed | Project: shop',
        'Tests: 120 total · 110 passed · 6 failed · 4 skipped (1 fixme) · 2 passed on retry',
        'Duration: 25 minutes',
      ].join('\n'),
    );
  });
});
