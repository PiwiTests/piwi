/**
 * Which worker a live run of several shows behind its tabs, one tab per lane (Playwright's `parallelIndex`).
 */
import type { HubWorker } from '@piwitests/core/run-hub';

/**
 * The worker a live run of several shows behind its tabs, by its lane (`parallelIndex`, kept by the worker Playwright
 * starts in its place): the one shown before (`before`, the person's choice included) while it stands at a stop or is
 * watched (`watched`); else, after the person resumed or ended the test shown (`advance`), the first stopped worker;
 * else the first stop that came since the tabs were last drawn (a stop not in `known`); else the one shown before;
 * else the first stopped worker, else the first. A stop so takes the tab once, as it comes, and never from a stop being
 * answered or a page being watched.
 */
export function shownLaneOf(
  workers: readonly HubWorker[],
  shown: {
    before: number | null;
    watched?: (worker: HubWorker) => boolean;
    known?: ReadonlySet<string>;
    advance?: boolean;
  },
): number | null {
  if (workers.length === 0) return null;
  const { before, watched = () => false, known = new Set<string>(), advance = false } = shown;
  const stopped = workers.filter((w) => w.state === 'stopped' && w.stop);
  const current = workers.find((w) => w.parallelIndex === before);
  if (current && (stopped.includes(current) || watched(current))) return current.parallelIndex;
  const next = advance ? stopped[0] : stopped.find((w) => !known.has(w.stop!.since));
  return (next ?? current ?? stopped[0] ?? workers[0]!).parallelIndex;
}
