/**
 * What a running row of a live run says where **Watch** would be, while none of the run's workers is in its live view:
 * that the developer who runs it has not shared it (`unshared`: a run outside CI that holds a live view key), or, in
 * the desktop app, which hands out no live view key, where its tests' pages show (`desktop`: at a stop, where the run
 * is steered). Null when the row says nothing there.
 */
export type LiveRowNote = 'unshared' | 'desktop';

export interface LiveRowRun {
  /** The run executes. */
  live: boolean;
  /** This dashboard is the desktop app. */
  desktop: boolean;
  /** The run holds a live view key: its project's live view applies to it. */
  keyed: boolean;
  /** The run is a CI run, whose workers join its live view at once. */
  ci: boolean;
  /** The run's workers in its live view now. */
  workers: number;
}

export function liveRowNote(run: LiveRowRun): LiveRowNote | null {
  if (!run.live || run.workers > 0) return null;
  if (run.desktop) return 'desktop';
  return run.keyed && !run.ci ? 'unshared' : null;
}
