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
    startTime: new Date(Date.UTC(2026, 9, 30 - i)),
    runStatus: status,
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

  test('anchors on the newest execution when none is being viewed', () => {
    expect(historyStreak(history(['failed', 'passed']), null)).toMatchObject({ count: 1, anchorPassed: false });
    expect(historyStreak([], null)).toBeNull();
  });
});
