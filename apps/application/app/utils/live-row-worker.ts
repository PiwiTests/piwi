import { liveWorkerKey, type LiveWorkerState } from '#shared/live-view';
import type { TestCaseResult } from '~~/types/api';

/** A running row's worker, as the run's live view files it (`liveWorkerKey`); null for a row that does not run. */
export function rowWorkerKey(tc: TestCaseResult): string | null {
  if (tc.status !== 'running' || tc.workerIndex == null) return null;
  return liveWorkerKey({ shard: tc.shardIndex ?? null, worker: tc.workerIndex });
}

/**
 * The execution each worker runs now, by `liveWorkerKey`: its running row that began last. A row of the test before,
 * whose end has not streamed in yet, is not it, nor an earlier repetition of the same test (`--repeat-each`).
 */
export function currentRows(rows: readonly TestCaseResult[]): Map<string, TestCaseResult> {
  const current = new Map<string, TestCaseResult>();
  for (const tc of rows) {
    const key = rowWorkerKey(tc);
    if (!key) continue;
    const seen = current.get(key);
    if (!seen || (tc.startedAt ?? 0) >= (seen.startedAt ?? 0)) current.set(key, tc);
  }
  return current;
}

/**
 * A row's worker in the run's live view, when the row is the test that worker runs now (`current`, from
 * `currentRows`). A stop names its test: one of the worker's next test, whose begin has not streamed in yet, is not
 * this row's.
 */
export function rowLiveWorker(
  current: ReadonlyMap<string, TestCaseResult>,
  workers: Readonly<Record<string, LiveWorkerState>> | null | undefined,
  tc: TestCaseResult,
): LiveWorkerState | null {
  const key = rowWorkerKey(tc);
  const worker = key ? workers?.[key] : null;
  if (!key || !worker || current.get(key)?.executionId !== tc.executionId) return null;
  return worker.paused?.test && worker.paused.test !== tc.title ? { ...worker, paused: null } : worker;
}
