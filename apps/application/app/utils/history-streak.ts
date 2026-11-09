import type { TestCaseHistoryPoint } from '~~/types/api';
import { isFailedStatus, testOutcomes } from '#shared/utils/test-counts';

/** What the history strip says about the execution being viewed. */
export interface HistoryStreak {
  /** Consecutive failed runs, from the viewed execution's run back. */
  count: number;
  /** The most recent run before the viewed execution's that passed, as its final attempt, if the history holds one. */
  lastPass: TestCaseHistoryPoint | null;
  /** The runs the history holds. */
  total: number;
  anchorPassed: boolean;
}

/**
 * The test's outcome in each run of one Playwright project, newest run first: the history holds one row per attempt,
 * per project and per repetition, and a run's outcome is its final attempt, failed when one of its repetitions failed
 * (`testOutcomes`).
 */
function runOutcomes(history: TestCaseHistoryPoint[], browserName: string | null): TestCaseHistoryPoint[] {
  const byRun = new Map<number, TestCaseHistoryPoint[]>();
  for (const point of history) {
    if ((point.browserName ?? null) !== browserName) continue;
    const rows = byRun.get(point.runId);
    if (rows) rows.push(point);
    else byRun.set(point.runId, [point]);
  }
  return [...byRun.values()].map(
    (rows) =>
      testOutcomes(rows.map((row) => ({ ...row, testCaseId: 0, repeatEachIndex: row.repeatEachIndex ?? 0 })))[0]!,
  );
}

/**
 * The failing streak and the most recent green run, anchored to the execution being viewed (`currentId`), not the
 * newest one, so an older execution reached by a link gets a verdict about itself. `history` is newest first. The
 * streak counts runs of the viewed execution's Playwright project, one per run (`runOutcomes`), never attempts. With
 * no `currentId`, the newest execution is the anchor; an execution the history does not hold (older than the
 * executions fetched) gets no verdict, since one anchored elsewhere would describe another execution.
 */
export function historyStreak(history: TestCaseHistoryPoint[], currentId: number | null): HistoryStreak | null {
  if (!history.length) return null;
  const anchor = currentId == null ? history[0] : history.find((p) => p.id === currentId);
  if (!anchor) return null;

  const runs = runOutcomes(history, anchor.browserName ?? null);
  const found = runs.findIndex((run) => run.runId === anchor.runId);
  let count = 0;
  for (let i = found; i < runs.length; i++) {
    if (isFailedStatus(runs[i]!.status)) count++;
    else break;
  }
  let lastPass: TestCaseHistoryPoint | null = null;
  for (let i = found + 1; i < runs.length; i++) {
    if (runs[i]!.status === 'passed') {
      lastPass = runs[i]!;
      break;
    }
  }
  return { count, lastPass, total: runs.length, anchorPassed: anchor.status === 'passed' };
}
