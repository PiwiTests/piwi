/**
 * A worker's lane: Playwright's `parallelIndex`, the slot a run's tests take one after another, which a worker
 * Playwright starts again after a failure (or for another project) keeps. `workerIndex` names the worker process
 * instead, new at every start. People and agents read a worker by its lane from 1, per shard: `Worker 2`. A result of
 * an older reporter carries no lane.
 */

/** The largest lane a 32-bit integer column holds. */
const MAX_LANE = 2_147_483_647;

/** A lane as the reporter sent it: a non-negative integer, else null. */
export function workerLane(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_LANE ? value : null;
}

/** The number a worker is read by: its lane from 1, null when the lane is not known. */
export function workerNumber(parallelIndex: unknown): number | null {
  const lane = workerLane(parallelIndex);
  return lane === null ? null : lane + 1;
}

/**
 * The number a page names an execution's worker by (`Worker N`): its lane from 1, else Playwright's `workerIndex` for
 * a result that carries no lane; null with neither.
 */
export function shownWorkerNumber(execution: { parallelIndex?: unknown; workerIndex?: number | null }): number | null {
  const process = execution.workerIndex;
  return workerNumber(execution.parallelIndex) ?? (typeof process === 'number' && process >= 0 ? process : null);
}

/** An execution as the worker order reads it. */
interface WorkerOf {
  shardIndex?: number | null;
  parallelIndex?: unknown;
  workerIndex?: number | null;
}

/**
 * The order of executions by their worker: by shard, then by lane, then by worker process (`workerIndex`), so a lane's
 * processes follow one another. An execution without a lane, from a reporter that sends none, goes by its process
 * alone, and one without a worker (a test that never ran) goes first in its shard.
 */
export function compareWorkers(a: WorkerOf, b: WorkerOf): number {
  return (
    (a.shardIndex ?? -1) - (b.shardIndex ?? -1) ||
    (workerLane(a.parallelIndex) ?? -1) - (workerLane(b.parallelIndex) ?? -1) ||
    (a.workerIndex ?? -1) - (b.workerIndex ?? -1)
  );
}
