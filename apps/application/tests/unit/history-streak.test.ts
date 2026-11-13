import { describe, expect, test } from 'vitest';
import { historyStreak } from '../../app/utils/history-streak';
import type { TestCaseHistoryPoint } from '../../types/api';

/** History as the execution page fetches it: newest first. */
function history(statuses: string[]): TestCaseHistoryPoint[] {
  return statuses.map((status, i) => ({
    id: 100 - i,
    runId: 50 - i,
    status,
    duration: 1000,
    error: null,
    retries: 0,
    passedAfterFailure: false,
    startTime: new Date(Date.UTC(2026, 9, 30 - i)),
    runStatus: status,
  }));
}

let nextAttemptId = 1000;
/** The attempts of a test in one run and project, first attempt first, as the history holds them. */
function attempts(runId: number, statuses: string[], browserName = 'chromium'): TestCaseHistoryPoint[] {
  return statuses.map((status, retries) => ({
    id: nextAttemptId++,
    runId,
    status,
    duration: 1000,
    error: null,
    retries,
    passedAfterFailure: false,
    browserName,
    repeatEachIndex: 0,
    startTime: new Date(Date.UTC(2026, 9, runId - 20)),
    runStatus: 'failed',
  }));
}

describe('historyStreak', () => {
  test('counts the failures from the viewed execution back, and names the pass before them', () => {
    const streak = historyStreak(history(['passed', 'failed', 'timedout', 'passed']), 99);
    expect(streak).toMatchObject({ count: 2, anchorPassed: false, total: 4 });
    expect(streak!.lastPass!.id).toBe(97);
  });

  test('says nothing about an execution older than the history it was given', () => {
    // The test passes today, and the failure being viewed is older than the newest executions fetched.
    expect(historyStreak(history(['passed', 'passed']), 12)).toBeNull();
  });

  test('counts runs, not the attempts of each run', () => {
    // Two failed runs, each retried twice, then a passing run.
    const rows = [
      ...attempts(50, ['failed', 'failed', 'failed']),
      ...attempts(49, ['failed', 'failed', 'failed']),
      ...attempts(48, ['passed']),
    ];
    const finalOfNewest = rows.find((r) => r.runId === 50 && r.retries === 2)!;
    const streak = historyStreak(rows, finalOfNewest.id);
    expect(streak).toMatchObject({ count: 2, total: 3, anchorPassed: false });
    expect(streak!.lastPass!.runId).toBe(48);
  });

  test("reads one run's outcome from its final attempt: a pass on a retry ends the streak", () => {
    const rows = [...attempts(50, ['failed', 'passed']), ...attempts(49, ['failed'])];
    const firstAttempt = rows.find((r) => r.runId === 50 && r.retries === 0)!;
    expect(historyStreak(rows, firstAttempt.id)).toMatchObject({ count: 0, anchorPassed: false });
  });

  test("counts the viewed execution's Playwright project only", () => {
    const rows = [
      ...attempts(50, ['failed'], 'chromium'),
      ...attempts(50, ['passed'], 'firefox'),
      ...attempts(49, ['failed'], 'chromium'),
      ...attempts(49, ['passed'], 'firefox'),
      ...attempts(48, ['passed'], 'chromium'),
    ];
    const chromium = historyStreak(rows, rows.find((r) => r.runId === 50 && r.browserName === 'chromium')!.id);
    expect(chromium).toMatchObject({ count: 2, total: 3 });
    expect(chromium!.lastPass!.runId).toBe(48);
    const firefox = historyStreak(rows, rows.find((r) => r.runId === 50 && r.browserName === 'firefox')!.id);
    expect(firefox).toMatchObject({ count: 0, anchorPassed: true, total: 2 });
  });

  test('anchors on the newest execution when none is being viewed', () => {
    expect(historyStreak(history(['failed', 'passed']), null)).toMatchObject({ count: 1, anchorPassed: false });
    expect(historyStreak([], null)).toBeNull();
  });
});
