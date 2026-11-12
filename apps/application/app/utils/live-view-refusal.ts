import { LIVE_VIEW_END_TEXT, type LiveWorkerState } from '#shared/live-view';

/** What the run's live view says of itself when a view did not open: its workers' endpoint, or how it refused. */
export type LiveViewAnswer =
  | { enabled: boolean; workers: LiveWorkerState[]; viewers: number; maxViewers: number }
  | { status: number | null };

/** The view that did not open: its worker, its lane when it follows one, its name, and whether it showed an image. */
export interface RefusedView {
  shard: number | null;
  worker: number;
  slot?: number | null;
  name: string;
  hadImage: boolean;
}

/**
 * Why the instance closed a view's stream, in a sentence: the person signed out or lost access, the run is gone, the
 * project turned its live view off, the worker left, or the run has as many views as it allows.
 */
export function liveViewRefusalText(answer: LiveViewAnswer, view: RefusedView): string {
  if ('status' in answer) {
    if (answer.status === 401) return 'You are signed out: sign in again to watch this run.';
    if (answer.status === 403) return 'You can no longer open this run.';
    if (answer.status === 404) return 'This run is no longer on the instance.';
    return 'The view did not open, and the instance does not answer.';
  }
  if (!answer.enabled) return LIVE_VIEW_END_TEXT.off;
  const here = answer.workers.some(
    (worker) =>
      worker.shard === view.shard &&
      (typeof view.slot === 'number' ? worker.slot === view.slot : worker.worker === view.worker),
  );
  if (!here) {
    if (view.hadImage) return LIVE_VIEW_END_TEXT['worker-left'];
    const name = `${view.name.charAt(0).toUpperCase()}${view.name.slice(1)}`;
    return `${name} is not in the run’s live view now: its tests may have ended.`;
  }
  if (answer.viewers >= answer.maxViewers) {
    return `${answer.maxViewers} pages at most watch one run at a time, and as many watch this run now. Try again once one closes.`;
  }
  return 'The view did not open. Try again.';
}
