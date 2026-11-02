import type { TestCaseHistoryPoint } from '~~/types/api';

/** What the history strip says about the execution being viewed. */
export interface HistoryStreak {
  /** Consecutive failed executions, from the viewed one back. */
  count: number;
  /** The most recent pass before the viewed execution, if the history holds one. */
  lastPass: TestCaseHistoryPoint | null;
  total: number;
  anchorPassed: boolean;
}

const isFail = (status?: string | null) => status === 'failed' || status === 'timedOut' || status === 'timedout';

/**
 * The failing streak and the most recent green execution, anchored to the execution being viewed (`currentId`), not
 * the newest one, so an older execution reached by a link gets a verdict about itself. `history` is newest first.
 * With no `currentId`, the newest execution is the anchor; an execution the history does not hold (older than the
 * executions fetched) gets no verdict, since one anchored elsewhere would describe another execution.
 */
export function historyStreak(history: TestCaseHistoryPoint[], currentId: number | null): HistoryStreak | null {
  if (!history.length) return null;
  const found = currentId == null ? 0 : history.findIndex((p) => p.id === currentId);
  if (found === -1) return null;

  let count = 0;
  for (let i = found; i < history.length; i++) {
    if (isFail(history[i]!.status)) count++;
    else break;
  }
  let lastPass: TestCaseHistoryPoint | null = null;
  for (let i = found + 1; i < history.length; i++) {
    if (history[i]!.status === 'passed') {
      lastPass = history[i]!;
      break;
    }
  }
  return { count, lastPass, total: history.length, anchorPassed: history[found]?.status === 'passed' };
}
