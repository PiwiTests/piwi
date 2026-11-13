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

/**
 * A run's worker tabs: the lane shown, the stops that stood as its workers were last followed (`known`, by `since`),
 * and the stop the person resumed or ended on the worker shown (`advance`).
 */
export interface WorkerTabs {
  shown: number | null;
  known: readonly string[];
  advance: string | null;
}

/**
 * A run's tabs as its workers stand now (`shownLaneOf`): the worker shown stays while it stands at a stop or is
 * `watched`; once the person resumed or ended its test there (`advance`) and it left that stop, the next stopped test
 * takes the tab; else a stop not `known` takes it, once. Null for a run of fewer than two workers, which shows no tabs.
 */
export function tabsAfter(
  tabs: WorkerTabs | null | undefined,
  workers: readonly HubWorker[],
  watched: (worker: HubWorker) => boolean,
): WorkerTabs | null {
  if (workers.length < 2) return null;
  const sorted = [...workers].sort((a, b) => a.parallelIndex - b.parallelIndex);
  const { shown = null, known = [], advance = null } = tabs ?? {};
  const before = sorted.find((worker) => worker.parallelIndex === shown);
  const advanced = advance !== null && (before?.state !== 'stopped' || before.stop?.since !== advance);
  return {
    shown: shownLaneOf(sorted, { before: shown, watched, known: new Set(known), advance: advanced }),
    known: sorted.flatMap((worker) => (worker.state === 'stopped' && worker.stop ? [worker.stop.since] : [])),
    advance: advanced ? null : advance,
  };
}

/**
 * The person shows the worker in `lane` behind a run's tabs: it keeps the tab until a stop is answered there, or, while
 * it runs and nobody watches it, until a new stop comes.
 */
export function tabsChosen(tabs: WorkerTabs, lane: number): WorkerTabs {
  return { ...tabs, shown: lane, advance: null };
}

/**
 * The person resumes or ends the test of the worker in `lane` at the stop `since`: once it leaves that stop, the next
 * stopped test takes the tab, when that worker is the one shown. The same tabs otherwise.
 */
export function tabsAdvanced(tabs: WorkerTabs, lane: number, since: string | null): WorkerTabs {
  return since !== null && tabs.shown === lane ? { ...tabs, advance: since } : tabs;
}
