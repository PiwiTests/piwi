/**
 * Whether an execution is the latest of its test, for the line under a failing
 * execution's headline that answers "does it still fail?". Pure: the caller
 * loads the newer executions of the same test (`getNewerExecutions`), every
 * Playwright project, every branch, lab runs left out, and this sums them up.
 *
 * Only the same Playwright project counts (`browserName`, null equal to null):
 * a Chromium failure is neither confirmed nor cleared by a Firefox pass. A run
 * stores one row per attempt, so each newer run is read through the test's
 * outcome there: the final attempt of each `--repeat-each` repetition, a failed
 * one first (`decidesOutcome`). A later attempt of the execution's own
 * repetition counts as newer too.
 */
import { decidesOutcome, isFailedStatus } from '#shared/utils/test-counts';

/** One newer execution of the same test, as `getNewerExecutions` selects it. */
export interface NewerExecutionRow {
  id: number;
  runId: number;
  status: string;
  /** Playwright's `repeatEachIndex`: each repetition of a test retries on its own. */
  repeatEachIndex: number;
  retries: number | null;
  browserName: string | null;
  failureClusterId: number | null;
  /** The run's start time. */
  startTime: string | number | Date | null;
}

/** The execution the page shows. */
export interface LatestExecutionCurrent {
  runId: number;
  browserName: string | null;
  failureClusterId: number | null;
}

export interface LatestExecution {
  /** No newer execution of the test in the same Playwright project. */
  isLatest: boolean;
  /**
   * The newest execution of the test in the same project: the attempt that decides its outcome in a later run, else
   * a later attempt of this execution's repetition.
   */
  newest: {
    executionId: number;
    runId: number;
    status: string;
    retries: number;
    /** The run's start time. */
    at: string | number | Date | null;
    /** A later attempt of the execution's own run. */
    sameRun: boolean;
    /**
     * It failed in the execution's own failure cluster: true or false when both
     * clusters are known, null when either is not (nothing is known about its error).
     */
    sameCluster: boolean | null;
  } | null;
  /** The later runs it failed in again, newest first, up to the newest run it did not fail in. */
  failedAgainRunIds: number[];
  failedAgainCount: number;
  /** How many of those runs failed in a known other cluster: with another error. */
  failedAgainInOtherClusterCount: number;
  /** Another Playwright project ran the test later. */
  laterInOtherProject: boolean;
  /** The Playwright project the line is about, null when the execution names none. */
  projectName: string | null;
}

function startMs(value: NewerExecutionRow['startTime']): number {
  if (value == null) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Sum up the newer executions of the test the current execution belongs to. */
export function summarizeNewerExecutions(
  current: LatestExecutionCurrent,
  rows: ReadonlyArray<NewerExecutionRow>,
): LatestExecution {
  const project = current.browserName ?? null;
  const sameProject = rows.filter((r) => (r.browserName ?? null) === project);
  const laterInOtherProject = rows.some((r) => (r.browserName ?? null) !== project);

  // The final attempt of each repetition in each run (the row with the highest
  // retry), then the one that decides the test's outcome in that run.
  const finalByRepeat = new Map<string, NewerExecutionRow>();
  for (const r of sameProject) {
    const key = `${r.runId}\x00${r.repeatEachIndex}`;
    const prev = finalByRepeat.get(key);
    if (!prev || (r.retries ?? 0) > (prev.retries ?? 0)) finalByRepeat.set(key, r);
  }
  const finalByRun = new Map<number, NewerExecutionRow>();
  for (const r of finalByRepeat.values()) {
    if (decidesOutcome(r, finalByRun.get(r.runId))) finalByRun.set(r.runId, r);
  }
  // Newest first: later runs by start time, then id; the execution's own run is the oldest.
  const finals = [...finalByRun.values()].sort((a, b) => {
    const aOwn = a.runId === current.runId ? 1 : 0;
    const bOwn = b.runId === current.runId ? 1 : 0;
    if (aOwn !== bOwn) return aOwn - bOwn;
    return startMs(b.startTime) - startMs(a.startTime) || b.runId - a.runId;
  });

  // Whether a row failed in the execution's own cluster; null when either cluster is unknown.
  const sameCluster = (r: NewerExecutionRow): boolean | null =>
    r.failureClusterId == null || current.failureClusterId == null
      ? null
      : r.failureClusterId === current.failureClusterId;

  const failedAgainRunIds: number[] = [];
  let failedAgainInOtherClusterCount = 0;
  for (const r of finals) {
    if (r.runId === current.runId || !isFailedStatus(r.status)) break;
    failedAgainRunIds.push(r.runId);
    if (sameCluster(r) === false) failedAgainInOtherClusterCount++;
  }

  const top = finals[0] ?? null;
  return {
    isLatest: top == null,
    newest: top
      ? {
          executionId: top.id,
          runId: top.runId,
          status: top.status,
          retries: top.retries ?? 0,
          at: top.startTime,
          sameRun: top.runId === current.runId,
          sameCluster: sameCluster(top),
        }
      : null,
    failedAgainRunIds,
    failedAgainCount: failedAgainRunIds.length,
    failedAgainInOtherClusterCount,
    laterInOtherProject,
    projectName: project || null,
  };
}
