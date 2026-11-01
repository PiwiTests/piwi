import { describe, test, expect } from 'vitest';
import {
  countFailedFromTally,
  distinctRunCountsFromAttempts,
  flakyFinalAttempts,
  isFlakyExecution,
  normalizeTestCaseStatus,
  summarizeRunCases,
  sumFailedAndTimedOut,
  testOutcomes,
  withAttemptHistory,
} from '#shared/utils/test-counts';

describe('countFailedFromTally', () => {
  test('sums failed, timedOut (camelCase), and timedout (lowercase)', () => {
    expect(countFailedFromTally({ failed: 2, timedOut: 3, timedout: 1, passed: 5, skipped: 1 })).toBe(6);
  });

  test('handles only camelCase timedOut', () => {
    expect(countFailedFromTally({ failed: 1, timedOut: 2 })).toBe(3);
  });

  test('handles only lowercase timedout', () => {
    expect(countFailedFromTally({ failed: 1, timedout: 2 })).toBe(3);
  });

  test('returns 0 when no failed-ish entries', () => {
    expect(countFailedFromTally({ passed: 5, skipped: 1 })).toBe(0);
  });

  test('returns 0 for empty or null input', () => {
    expect(countFailedFromTally({})).toBe(0);
    expect(countFailedFromTally(null)).toBe(0);
    expect(countFailedFromTally(undefined)).toBe(0);
  });

  test('ignores zero/negative values', () => {
    expect(countFailedFromTally({ failed: 0, timedOut: 0 })).toBe(0);
  });
});

describe('sumFailedAndTimedOut', () => {
  test('sums both fields', () => {
    expect(sumFailedAndTimedOut(3, 2)).toBe(5);
  });

  test('treats undefined timedOutTests as 0', () => {
    expect(sumFailedAndTimedOut(3, undefined)).toBe(3);
  });

  test('treats undefined failedTests as 0', () => {
    expect(sumFailedAndTimedOut(undefined, 2)).toBe(2);
  });

  test('returns 0 when both are undefined/null', () => {
    expect(sumFailedAndTimedOut(undefined, undefined)).toBe(0);
    expect(sumFailedAndTimedOut(null, null)).toBe(0);
  });

  test('ignores zero/negative values', () => {
    expect(sumFailedAndTimedOut(0, 0)).toBe(0);
    expect(sumFailedAndTimedOut(-1, 5)).toBe(5);
  });
});

describe('summarizeRunCases', () => {
  test('counts a passed-on-retry (flaky) case as passed and flaky, never as failed', () => {
    const s = summarizeRunCases([
      { status: 'passed', retries: 0 },
      { status: 'passed', retries: 2 }, // flaky: passed after retries
    ]);
    expect(s.passed).toBe(2);
    expect(s.flaky).toBe(1);
    expect(s.failed).toBe(0);
  });

  test('counts a retry as flaky only when its history holds an earlier failed attempt', () => {
    const s = summarizeRunCases([
      {
        status: 'passed',
        retries: 1,
        attempts: [
          { retry: 0, status: 'failed' },
          { retry: 1, status: 'passed' },
        ],
      },
      // A describe.serial sibling re-run when its group was retried.
      {
        status: 'passed',
        retries: 1,
        attempts: [
          { retry: 0, status: 'passed' },
          { retry: 1, status: 'passed' },
        ],
      },
      // Did not run behind the group's failure, then passed on the retry.
      {
        status: 'passed',
        retries: 1,
        attempts: [
          { retry: 0, status: 'didnotrun' },
          { retry: 1, status: 'passed' },
        ],
      },
    ]);
    expect(s).toMatchObject({ total: 3, passed: 3, flaky: 1 });
  });

  test('folds timed-out into failed (both spellings)', () => {
    const s = summarizeRunCases([{ status: 'failed' }, { status: 'timedOut' }, { status: 'timedout' }]);
    expect(s.failed).toBe(3);
  });

  test('tallies a mid-flight run so every bucket reconciles with the total', () => {
    // A running run: passed (incl. flaky), failed, skipped, didn't run, and
    // still-running cases — one entry per test, as the live view de-duplicates.
    const cases = [
      ...Array.from({ length: 150 }, () => ({ status: 'passed', retries: 0 })),
      ...Array.from({ length: 3 }, () => ({ status: 'passed', retries: 1 })), // flaky
      ...Array.from({ length: 15 }, () => ({ status: 'failed' })),
      ...Array.from({ length: 10 }, () => ({ status: 'skipped' })),
      ...Array.from({ length: 28 }, () => ({ status: 'didnotrun' })),
      ...Array.from({ length: 3 }, () => ({ status: 'running' })),
    ];
    const s = summarizeRunCases(cases);
    expect(s).toEqual({
      total: 209,
      passed: 153,
      failed: 15,
      skipped: 10,
      didNotRun: 28,
      flaky: 3,
      fixme: 0,
      running: 3,
    });
    expect(s.passed + s.failed + s.skipped + s.didNotRun + s.running).toBe(s.total);
  });

  test('counts a test.fixme() skip as skipped and fixme, and ignores fixme on other statuses', () => {
    const s = summarizeRunCases([
      { status: 'skipped', testAnnotations: [{ type: 'skip' }] },
      { status: 'skipped', testAnnotations: [{ type: 'fixme' }] },
      { status: 'skipped', testAnnotations: null },
      { status: 'failed', testAnnotations: [{ type: 'fixme' }] },
    ]);
    expect(s.skipped).toBe(3);
    expect(s.fixme).toBe(1);
    expect(s.failed).toBe(1);
  });

  test('treats a missing retries field as zero (not flaky)', () => {
    const s = summarizeRunCases([{ status: 'passed' }, { status: 'passed', retries: null }]);
    expect(s.passed).toBe(2);
    expect(s.flaky).toBe(0);
  });

  test('returns an all-zero summary for no cases', () => {
    expect(summarizeRunCases([])).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      didNotRun: 0,
      flaky: 0,
      fixme: 0,
      running: 0,
    });
  });
});

describe('distinctRunCountsFromAttempts', () => {
  test('collapses retry rows to the final attempt per (test, browser)', () => {
    const counts = distinctRunCountsFromAttempts([
      { testCaseId: 1, browserName: 'chromium', retries: 0, status: 'failed' },
      { testCaseId: 1, browserName: 'chromium', retries: 1, status: 'passed' },
      { testCaseId: 2, browserName: 'chromium', retries: 0, status: 'failed' },
    ]);
    // Test 1 flaked (failed then passed), test 2 is a hard failure.
    expect(counts).toEqual({
      totalTests: 2,
      passedTests: 1,
      failedTests: 1,
      skippedTests: 0,
      didNotRunTests: 0,
      flakyTests: 1,
    });
  });

  test('folds timed-out into failedTests', () => {
    const counts = distinctRunCountsFromAttempts([
      { testCaseId: 1, browserName: '', retries: 0, status: 'timedout' },
      { testCaseId: 2, browserName: '', retries: 0, status: 'failed' },
    ]);
    expect(counts.failedTests).toBe(2);
    expect(counts.totalTests).toBe(2);
  });

  test('keeps the same test in different browsers separate', () => {
    const counts = distinctRunCountsFromAttempts([
      { testCaseId: 1, browserName: 'chromium', retries: 0, status: 'passed' },
      { testCaseId: 1, browserName: 'firefox', retries: 0, status: 'passed' },
    ]);
    expect(counts.totalTests).toBe(2);
    expect(counts.passedTests).toBe(2);
  });

  test("a flaky test's failed attempt is not counted as a failure (3 hard + 4 flaky, not 7 failed)", () => {
    // Per-attempt rows as the streaming events endpoint persists them: 3 tests
    // that only ever failed, and 4 that failed once then passed on retry. Seven
    // rows carry status 'failed', so a naive per-attempt tally reports 7
    // failures — but only 3 tests actually failed.
    const rows = [
      { testCaseId: 1, browserName: 'chromium', retries: 0, status: 'failed' },
      { testCaseId: 2, browserName: 'chromium', retries: 0, status: 'failed' },
      { testCaseId: 3, browserName: 'chromium', retries: 0, status: 'failed' },
      { testCaseId: 4, browserName: 'chromium', retries: 0, status: 'failed' },
      { testCaseId: 4, browserName: 'chromium', retries: 1, status: 'passed' },
      { testCaseId: 5, browserName: 'chromium', retries: 0, status: 'failed' },
      { testCaseId: 5, browserName: 'chromium', retries: 1, status: 'passed' },
      { testCaseId: 6, browserName: 'chromium', retries: 0, status: 'failed' },
      { testCaseId: 6, browserName: 'chromium', retries: 1, status: 'passed' },
      { testCaseId: 7, browserName: 'chromium', retries: 0, status: 'failed' },
      { testCaseId: 7, browserName: 'chromium', retries: 1, status: 'passed' },
    ];
    expect(rows.filter((r) => r.status === 'failed').length).toBe(7);

    const counts = distinctRunCountsFromAttempts(rows);
    expect(counts.totalTests).toBe(7);
    expect(counts.failedTests).toBe(3);
    expect(counts.passedTests).toBe(4);
    expect(counts.flakyTests).toBe(4);
    // The buckets reconcile per test, ignoring the extra attempt rows.
    expect(counts.passedTests + counts.failedTests + counts.skippedTests + counts.didNotRunTests).toBe(
      counts.totalTests,
    );
  });
});

describe('flaky results', () => {
  // A describe.serial group where `checkout` fails once: Playwright retries the whole group.
  const serialGroup = [
    { testCaseId: 1, browserName: 'chromium', repeatEachIndex: 0, retries: 0, status: 'passed' }, // login
    { testCaseId: 1, browserName: 'chromium', repeatEachIndex: 0, retries: 1, status: 'passed' },
    { testCaseId: 2, browserName: 'chromium', repeatEachIndex: 0, retries: 0, status: 'failed' }, // checkout
    { testCaseId: 2, browserName: 'chromium', repeatEachIndex: 0, retries: 1, status: 'passed' },
    { testCaseId: 3, browserName: 'chromium', repeatEachIndex: 0, retries: 0, status: 'didnotrun' }, // receipt
    { testCaseId: 3, browserName: 'chromium', repeatEachIndex: 0, retries: 1, status: 'passed' },
    // A test.fail() test: its expected failure is stored as passed on both attempts.
    { testCaseId: 4, browserName: 'chromium', repeatEachIndex: 0, retries: 0, status: 'passed' },
    { testCaseId: 4, browserName: 'chromium', repeatEachIndex: 0, retries: 1, status: 'passed' },
  ];

  test('counts only the test whose earlier attempt failed, as Playwright does', () => {
    expect(distinctRunCountsFromAttempts(serialGroup)).toEqual({
      totalTests: 4,
      passedTests: 4,
      failedTests: 0,
      skippedTests: 0,
      didNotRunTests: 0,
      flakyTests: 1,
    });
  });

  test('returns the final attempt of each flaky result', () => {
    expect([...flakyFinalAttempts(serialGroup)]).toEqual([serialGroup[3]]);
  });

  test('reads an earlier timed-out attempt as a failure, and a later failure as no flake', () => {
    const rows = [
      { testCaseId: 1, browserName: null, repeatEachIndex: 0, retries: 0, status: 'timedout' },
      { testCaseId: 1, browserName: null, repeatEachIndex: 0, retries: 1, status: 'passed' },
      { testCaseId: 2, browserName: null, repeatEachIndex: 0, retries: 0, status: 'passed' },
      { testCaseId: 2, browserName: null, repeatEachIndex: 0, retries: 1, status: 'failed' },
    ];
    expect(distinctRunCountsFromAttempts(rows)).toMatchObject({ passedTests: 1, failedTests: 1, flakyTests: 1 });
  });

  test('keeps each repetition to its own attempts', () => {
    const rows = [
      { testCaseId: 1, browserName: null, repeatEachIndex: 0, retries: 0, status: 'failed' },
      { testCaseId: 1, browserName: null, repeatEachIndex: 1, retries: 0, status: 'passed' },
      { testCaseId: 1, browserName: null, repeatEachIndex: 1, retries: 1, status: 'passed' },
    ];
    expect(distinctRunCountsFromAttempts(rows)).toMatchObject({ totalTests: 2, failedTests: 1, flakyTests: 0 });
  });

  test("reads a final attempt's own history, and a retry pass without one as flaky", () => {
    const failedFirst = [
      { retry: 0, status: 'failed' },
      { retry: 1, status: 'passed' },
    ];
    expect(isFlakyExecution({ status: 'passed', retries: 1, attempts: failedFirst })).toBe(true);
    expect(
      isFlakyExecution({
        status: 'passed',
        retries: 1,
        attempts: [
          { retry: 0, status: 'passed' },
          { retry: 1, status: 'passed' },
        ],
      }),
    ).toBe(false);
    // The earlier attempt's row, whose history stops at it, is no flaky result.
    expect(isFlakyExecution({ status: 'failed', retries: 0, attempts: failedFirst.slice(0, 1) })).toBe(false);
    expect(isFlakyExecution({ status: 'passed', retries: 0, attempts: null })).toBe(false);
    expect(isFlakyExecution({ status: 'passed', retries: 1, attempts: null })).toBe(true);
    // A history that holds no earlier attempt reads as no history.
    expect(isFlakyExecution({ status: 'passed', retries: 1, attempts: [{ retry: 1, status: 'passed' }] })).toBe(true);
  });

  test('reads a retry pass none of whose earlier attempts is among the rows as flaky', () => {
    const rows = [
      { testCaseId: 1, browserName: null, repeatEachIndex: 0, retries: 2, status: 'passed' },
      { testCaseId: 2, browserName: null, repeatEachIndex: 0, retries: 0, status: 'passed' },
    ];
    expect([...flakyFinalAttempts(rows)]).toEqual([rows[0]]);
  });

  test("picks a test's flaky repetition as its outcome, not a re-run that passed twice", () => {
    const rows = [
      { testCaseId: 1, browserName: null, repeatEachIndex: 0, retries: 0, status: 'failed' },
      { testCaseId: 1, browserName: null, repeatEachIndex: 0, retries: 1, status: 'passed' },
      { testCaseId: 1, browserName: null, repeatEachIndex: 1, retries: 0, status: 'passed' },
      { testCaseId: 1, browserName: null, repeatEachIndex: 1, retries: 1, status: 'passed' },
    ];
    expect(testOutcomes(rows)).toEqual([rows[1]]);
    expect(flakyFinalAttempts(rows).has(testOutcomes(rows)[0]!)).toBe(true);
  });

  test("gives a row without a history the run's stored attempts of it, so both readings agree", () => {
    // A trace import: one row per trace, no history, both passed.
    const rows = [
      {
        testCaseId: 1,
        browserName: null,
        repeatEachIndex: 0,
        retries: 0,
        status: 'passed',
        startedAt: 10,
        duration: 5,
      },
      {
        testCaseId: 1,
        browserName: null,
        repeatEachIndex: 0,
        retries: 1,
        status: 'passed',
        startedAt: 20,
        duration: 5,
      },
      {
        testCaseId: 2,
        browserName: null,
        repeatEachIndex: 0,
        retries: 0,
        status: 'failed',
        startedAt: 10,
        duration: 5,
      },
      {
        testCaseId: 2,
        browserName: null,
        repeatEachIndex: 0,
        retries: 1,
        status: 'passed',
        startedAt: 20,
        duration: 5,
      },
    ];
    const filled = withAttemptHistory(rows);
    expect(filled[1]!.attempts).toEqual([
      { retry: 0, status: 'passed', duration: 5, startedAt: 10 },
      { retry: 1, status: 'passed', duration: 5, startedAt: 20 },
    ]);
    expect(filled[0]).toBe(rows[0]);
    expect(filled.map((row) => isFlakyExecution(row))).toEqual([false, false, false, true]);
    expect([...flakyFinalAttempts(rows)]).toEqual([rows[3]]);

    const reported = { ...rows[1]!, attempts: [{ retry: 0, status: 'failed' }] };
    expect(withAttemptHistory([rows[0]!, reported])[1]).toBe(reported);
  });
});

describe('normalizeTestCaseStatus', () => {
  test("maps Playwright's camelCase timedOut to the canonical lowercase form", () => {
    expect(normalizeTestCaseStatus('timedOut')).toBe('timedout');
  });

  test('passes every other status through unchanged', () => {
    for (const status of ['passed', 'failed', 'skipped', 'timedout', 'didnotrun', 'interrupted']) {
      expect(normalizeTestCaseStatus(status)).toBe(status);
    }
  });
});
