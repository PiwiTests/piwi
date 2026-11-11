/**
 * What a running row of a live run says where **Watch** would be, while none of the run's workers is in its live view:
 * in the desktop app, which hands out no live view key, where its tests' pages show (`desktop`: at a stop, where the
 * run is steered). Null when the row says nothing there: a run nobody shares says so once, in the Tests toolbar
 * (`runLiveViewStatus`), never on each row.
 */
export type LiveRowNote = 'desktop';

export interface LiveRowRun {
  /** The run executes. */
  live: boolean;
  /** This dashboard is the desktop app. */
  desktop: boolean;
  /** The run's workers in its live view now. */
  workers: number;
}

export function liveRowNote(run: LiveRowRun): LiveRowNote | null {
  if (!run.live || run.workers > 0) return null;
  return run.desktop ? 'desktop' : null;
}

/**
 * What a running row shows where Watch would be: **Watch** on its worker in the run's live view (`watch`), else
 * **Pause and watch** on its worker in a run the desktop app started (`pause-and-watch`), else the run's note. Null
 * when the row shows none.
 */
export function liveRowShows(row: {
  liveWorker: boolean;
  desktopWorker: boolean;
  note: LiveRowNote | null;
}): 'watch' | 'pause-and-watch' | LiveRowNote | null {
  if (row.liveWorker) return 'watch';
  if (row.desktopWorker) return 'pause-and-watch';
  return row.note;
}
