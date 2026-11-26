import type { TestError } from '@playwright/test/reporter';
import { runErrorOfReported } from '@piwitests/core/run-errors';
import type { WireRunError } from '../../types/wire.js';
import { relativeTestPath } from '../support/test-paths.js';

/**
 * What Playwright says of the worker an error outside any test came from (`WorkerInfo`, Playwright 1.60 and later):
 * its lane and its project. Read structurally, so the reporter's types hold for every Playwright it supports.
 */
export interface ErrorWorker {
  parallelIndex?: unknown;
  project?: { name?: unknown } | null;
}

/**
 * An error Playwright reported outside any test (`onError`), as the run keeps it (`runErrorOfReported`): its message
 * with its causes after it, the frames of its stack, and the place it was thrown, named relative to `base` (the
 * Playwright config's folder) as test files are; with the `worker` it came from, its lane and Playwright project, and
 * `shardIndex`, the shard the run is, when Playwright names one. Null for an error with no message.
 */
export function runErrorOf(
  error: TestError,
  base: string,
  worker?: ErrorWorker | null,
  shardIndex: number | null = null,
): WireRunError | null {
  const from = worker
    ? { parallelIndex: worker.parallelIndex, shardIndex, playwrightProject: worker.project?.name }
    : null;
  return runErrorOfReported(error, (file) => relativeTestPath(file, base), from);
}
