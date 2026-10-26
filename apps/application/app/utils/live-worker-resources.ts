import type { TestCaseResult } from '~~/types/api';
import type { RunResourceTimelinePart } from '#shared/handlers/run-resources';
import { formatSize } from '#shared/resource-copy';

/**
 * What a worker of a live run uses right now: the last values its reporter
 * sent of the cores and memory of the worker and the browsers it started, and
 * of the pages open in it. Shown on the worker's running test, beside the
 * step it is on. A value the reporter has not sent yet is null: a worker's
 * processes are told apart once its first test ended.
 */
export interface LiveWorkerResources {
  cpuCores: number | null;
  memoryBytes: number | null;
  memoryKind: 'pss' | 'rss' | null;
  openPages: number | null;
}

/** Each worker's last values, keyed by `shardKey(shardIndex, worker)`. */
export type LiveResourcesByWorker = Map<string, LiveWorkerResources>;

function shardKey(shardIndex: number | null | undefined, worker: number): string {
  return `${shardIndex ?? '-'}:${worker}`;
}

/** Each worker's last values, from the live parts of the run's reporters. */
export function liveResourcesByWorker(parts: RunResourceTimelinePart[] | null | undefined): LiveResourcesByWorker {
  const out: LiveResourcesByWorker = new Map();
  const entry = (shardIndex: number | null, worker: number, memoryKind: LiveWorkerResources['memoryKind']) => {
    const key = shardKey(shardIndex, worker);
    let found = out.get(key);
    if (!found) {
      found = { cpuCores: null, memoryBytes: null, memoryKind, openPages: null };
      out.set(key, found);
    }
    return found;
  };
  for (const part of parts ?? []) {
    for (const tree of part.timeline.workers ?? []) {
      const values = entry(part.shardIndex, tree.worker, part.memoryKind);
      values.cpuCores = tree.cpuCores.at(-1)?.[1] ?? null;
      values.memoryBytes = tree.memoryBytes.at(-1)?.[1] ?? null;
    }
    for (const pages of part.timeline.pages) {
      entry(part.shardIndex, pages.worker, part.memoryKind).openPages = pages.points.at(-1)?.[1] ?? null;
    }
  }
  return out;
}

/**
 * The values to show on a test row: only rows still running, matched by their
 * worker and shard. A run with one reporter matches by worker alone, as its
 * test rows may not name a shard.
 */
export function liveResourcesForCase(
  byWorker: LiveResourcesByWorker,
  testCase: TestCaseResult,
  singleReporter: boolean,
): LiveWorkerResources | null {
  if (byWorker.size === 0 || testCase.status !== 'running' || testCase.workerIndex == null) return null;
  const exact = byWorker.get(shardKey(testCase.shardIndex, testCase.workerIndex));
  if (exact) return exact;
  if (!singleReporter) return null;
  for (const [key, values] of byWorker) if (key.endsWith(`:${testCase.workerIndex}`)) return values;
  return null;
}

/** `1.3 cores · 640 MB · 4 pages`, leaving out what is not known; empty when nothing is. */
export function liveResourcesLabel(values: LiveWorkerResources): string {
  const parts: string[] = [];
  if (values.cpuCores !== null) {
    const cores = Math.round(values.cpuCores * 10) / 10;
    parts.push(`${cores} core${cores === 1 ? '' : 's'}`);
  }
  if (values.memoryBytes !== null) parts.push(formatSize(values.memoryBytes));
  if (values.openPages !== null) parts.push(`${values.openPages} page${values.openPages === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
