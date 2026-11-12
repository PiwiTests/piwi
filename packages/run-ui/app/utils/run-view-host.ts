import type { Component, InjectionKey } from 'vue';

/**
 * **Inspect** of a watched lane, for a host that reads the pages of a lane's running test (the dashboard's desktop
 * build, from the test's own trace): the window opens and closes it (`useDesktopRunHub().setInspect`), tells the host's
 * server (`inspect`) while a view of it shows, and passes the host what its stream says of the lane; the host keeps
 * what it heard and shows it under the lane's page (`view`).
 */
export interface RunViewInspect {
  /** What shows under a watched lane's page while Inspect is open on it, given `session` and `worker`. */
  view: Component;
  /** What the lane's Inspect button says it shows, as its title. */
  title: string;
  /** Inspect of the lane `key` (`desktopLaneKey`) opens for the window: nothing is heard of it yet. */
  opened(key: string): void;
  /** What the window's stream said of a lane Inspect is open on (`inspect`), as it came. */
  heard(key: string, event: Record<string, unknown>): void;
  /**
   * The server took Inspect of the lane on the stream `viewer`: the host reads what it read so far, while the stream
   * that asked is still open (`current`).
   */
  taken(key: string, at: { viewer: string; ref: string; lane: number; current(): boolean }): Promise<void>;
  /** Inspect of the lane closed for the window, was refused, or its run ended: what was heard of it goes. */
  closed(key: string): void;
}

/**
 * What a host's window adds to the live view of its runs (`DesktopRunWorker`): what only that host can do, which it
 * provides once to the whole app under `RUN_VIEW_HOST` (the dashboard's `plugins/run-view-host.ts`). Without it, the
 * view offers none of it.
 */
export interface RunViewHost {
  /** **Open in a window**: the shell opens a worker in a window of its own (`desktop_open_worker_window`). */
  workerWindows: boolean;
  /**
   * The link a stop's place opens the file in an editor with, given `file-path`, `line`, `root` and `inline`; the place
   * shows as text without one.
   */
  placeLink: Component | null;
  /** **Inspect** of a watched lane; the lane offers none without it. */
  inspect: RunViewInspect | null;
}

export const RUN_VIEW_HOST: InjectionKey<RunViewHost> = Symbol('run-view-host');

/** What the live view shows when its host provides nothing: no worker's window, no link to the file, no Inspect. */
export const PLAIN_RUN_VIEW_HOST: RunViewHost = { workerWindows: false, placeLink: null, inspect: null };
