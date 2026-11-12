import type { Component, InjectionKey } from 'vue';

/**
 * What a host's window adds to the live view of its runs (`DesktopRunWorker`), provided once by the host
 * (`provideRunViewHost`): what only that host can do. Without it, the view offers neither.
 */
export interface RunViewHost {
  /** **Open in a window**: the shell opens a worker in a window of its own (`desktop_open_worker_window`). */
  workerWindows: boolean;
  /**
   * The link a stop's place opens the file in an editor with, given `file-path`, `line`, `root` and `inline`; the place
   * shows as text without one.
   */
  placeLink: Component | null;
}

export const RUN_VIEW_HOST: InjectionKey<RunViewHost> = Symbol('run-view-host');

/** What the live view shows when its host provides nothing: neither a worker's window nor a link to the file. */
export const PLAIN_RUN_VIEW_HOST: RunViewHost = { workerWindows: false, placeLink: null };
