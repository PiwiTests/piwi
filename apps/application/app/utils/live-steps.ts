import type { TestCaseResult } from '~~/types/api';
import { liveWorkerKey } from '#shared/live-view';

/**
 * The step a worker is currently on, from the run stream's transient
 * `step-begin`/`step-end` events (nothing is persisted from them). An ended
 * step keeps its `status` until the next one begins, so a row can show the
 * last thing its worker did between steps.
 */
export interface LiveStepInfo {
  title: string;
  /** The step's target (rendered locator or URL), carried separately by newer Playwright. */
  subtitle?: string | null;
  category?: string | null;
  status?: string | null;
  /** Owning test's title — pins the step to the right running row. */
  parentTitle?: string | null;
  /** When the step began, in epoch milliseconds of the worker's clock. */
  startedAt?: number | null;
}

/** The step each worker is currently on, by `liveWorkerKey` (its shard and its worker). */
export type LiveStepsByWorker = Record<string, LiveStepInfo | undefined>;

/**
 * The live step to show on a test row: only rows still running, matched by
 * shard and worker, else by worker alone for a reporter that sends no shard
 * with its steps. The `parentTitle` guard drops a stale readout during a
 * worker's test handoff — the previous test's last step lingers in the map
 * until the next test's first step begins, and it must not surface on the new
 * row.
 */
export function liveStepForCase(
  steps: LiveStepsByWorker | null | undefined,
  testCase: TestCaseResult,
): LiveStepInfo | null {
  if (testCase.status !== 'running' || testCase.workerIndex == null) return null;
  return liveStepOf(steps, { shard: testCase.shardIndex ?? null, worker: testCase.workerIndex, test: testCase.title });
}

/** The step a worker is on in its test `test`, by shard and worker, else by worker alone. Null for none. */
export function liveStepOf(
  steps: LiveStepsByWorker | null | undefined,
  at: { shard: number | null; worker: number; test: string },
): LiveStepInfo | null {
  if (!steps) return null;
  const step =
    steps[liveWorkerKey({ shard: at.shard, worker: at.worker })] ??
    steps[liveWorkerKey({ shard: null, worker: at.worker })];
  if (!step) return null;
  if (step.parentTitle && step.parentTitle !== at.test) return null;
  return step;
}
