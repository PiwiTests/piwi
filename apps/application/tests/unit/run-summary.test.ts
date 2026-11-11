import { describe, expect, test } from 'vitest';
import { runSummaryText, runVerdictText } from '../../app/utils/run-summary';

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
  interrupted: 0,
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

  test('names the tests ended at a stop among the skipped, never as passed', () => {
    expect(runSummaryText({ ...run, endedAtStop: 2 })).toContain(
      'Tests: 120 total · 110 passed · 6 failed · 4 skipped (1 fixme, 2 ended at a stop) · 2 passed on retry',
    );
    expect(runSummaryText({ ...run, fixme: 0, endedAtStop: 1 })).toContain('4 skipped (1 ended at a stop)');
  });

  test('names the tests an interruption cut short, apart from every outcome', () => {
    const cut = {
      ...run,
      total: 3,
      passed: 1,
      failed: 0,
      skipped: 0,
      fixme: 0,
      flaky: 0,
      didNotRun: 1,
      interrupted: 1,
    };
    expect(runSummaryText(cut)).toContain(
      "Tests: 3 total · 1 passed · 0 failed · 0 skipped · 1 didn't run · 1 interrupted",
    );
    expect(runSummaryText(run)).not.toContain('interrupted');
  });
});

describe('runVerdictText', () => {
  test('says how a run that ended came out, with its failures out of its tests', () => {
    expect(runVerdictText({ status: 'passed', total: 1, failed: 0 })).toBe('The run passed: 1 test.');
    expect(runVerdictText({ status: 'failed', total: 12, failed: 3 })).toBe('The run failed: 3 of 12 tests failed.');
    expect(runVerdictText({ status: 'failed', total: 12, failed: 0 })).toBe('The run failed.');
    expect(runVerdictText({ status: 'interrupted', total: 4, failed: 0 })).toBe('The run was interrupted.');
    expect(runVerdictText({ status: 'something-new', total: 4, failed: 0 })).toBe('The run ended.');
  });
});
