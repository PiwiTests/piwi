/**
 * The messages between the dashboard window and the windows of its runs, over a `BroadcastChannel` of the dashboard's
 * origin, so those windows hold no IPC grant.
 *
 * A run's own window (`pages/desktop/run-output.vue`) says it is `ready`, with the run it shows (`key`) and the id of
 * the last line it has (`through`), and asks for what only the dashboard window does, of the run it names by its `key`:
 * `stop` it, turn its Hold failures over (`hold`), run it again (`rerun`) or one of its tests (`rerun-test`), `open`
 * one of its pages there, or show it in the tray again (`back`). The dashboard window answers with the run's `state`:
 * its header, what it offers, its results and the lines the window does not have yet. A dashboard window that reloaded
 * asks a window the page before had open whether it is still there (`ask`), and the window answers `ready` again. A
 * worker's window asks the dashboard window to show the run of the hub's run it names in Local runs (`show-run`), and
 * either window to open a file in the editor (`open-in-ide`), which only the dashboard window's grant does.
 */
import type { RunOutputLine, RunResultRow } from '@piwitests/run-ui/run-output';
import type { OpenTarget } from '~/composables/useOpenInIde';
import type { BadgeColor } from '~/utils';

export const RUN_OUTPUT_CHANNEL = 'piwi:run-output';

/** A test the run's results list, as its window shows it, with what it offers there. */
export interface RunWindowRow extends RunResultRow {
  /** Its execution, once reported: **Open** shows it in the dashboard window. */
  executionId: number | null;
  /** Whether **Run again** runs it again as the run ran it. */
  rerunnable: boolean;
}

/** The Hold failures switch of a running run, as its window shows it. */
export interface RunWindowHold {
  /** Whether the run holds its failures now, as the hub says. */
  on: boolean;
  /** Whether the person has it hold them: the window says `show` for the run while it does, as the tray does. */
  chosen: boolean;
  /** Why the run holds no failure, in place of the switch's sentence; null when it can. */
  refusal: string | null;
}

/**
 * What the window may ask the dashboard window to open, of the run it shows: its first failure, its Piwi run, the
 * comparison with the run its tests come from, an execution of its results, or a page of this app a link of its live
 * view names (a path of this origin).
 */
export type RunWindowPage = 'failure' | 'run' | 'compare' | { execution: number } | { path: string };

/** The run's header, what it offers and its newest lines, as its window shows them. */
export interface RunOutputState {
  type: 'state';
  name: string;
  /** The run the window shows: a Run again from the window moves the window to the run it starts. */
  key: number;
  title: string;
  status: { label: string; color: BadgeColor };
  detail: string;
  /** What the environment said of the run, beside its command; null for nothing. */
  note: string | null;
  startedAt: number;
  finishedAt: number | null;
  running: boolean;
  stopRequested: boolean;
  /** When the person asked the run to stop, in ms since the epoch; null while nobody did. */
  stopRequestedAt: number | null;
  /** Its steps' names on the hub: the window shows their workers live. */
  refs: string[];
  /** Its Hold failures, while it runs and holds its own; null otherwise. */
  hold: RunWindowHold | null;
  /** Whether it offers **Run again**, once it ended, and whether a Run again asked from the window is starting. */
  rerunnable: boolean;
  startingAgain: boolean;
  /** Its Piwi run (**Open run #N**), whether it failed (**Open the failure**), and the one it compares with. */
  piwiRunId: number | null;
  failed: boolean;
  sourceRunId: number | null;
  /** Its project, for its tests' places. */
  projectId: string;
  projectLabel: string | null;
  /** What it failed on, once it ended; whether a test of it runs again with Hold failures. */
  rows: RunWindowRow[];
  rowsHold: boolean;
  /** Its lines the window does not have yet: all those it keeps after `ready`, the new ones since after that. */
  lines: RunOutputLine[];
}

export type RunOutputMessage =
  | RunOutputState
  | { type: 'ready'; name: string; key?: number; through?: number }
  | { type: 'ask'; name: string }
  | { type: 'stop' | 'rerun' | 'back'; name: string; key: number }
  | { type: 'hold'; name: string; key: number; on: boolean }
  | { type: 'rerun-test'; name: string; key: number; row: string; hold: boolean }
  | { type: 'open'; name: string; key: number; page: RunWindowPage }
  | { type: 'show-run'; ref: string }
  | { type: 'open-in-ide'; target: OpenTarget };

/** Whether `path` is a path of this app's own origin, as a link of the run's live view names one. */
export function isAppPath(path: string): boolean {
  try {
    return new URL(path, 'http://app.invalid').origin === 'http://app.invalid' && path.startsWith('/');
  } catch {
    return false;
  }
}

/** The output window's name for the run of key `key`, as the shell takes one: lowercase letters, digits and dashes. */
export function runOutputWindowName(key: number): string {
  return `piwi-run-output-${key}`;
}

/**
 * The name of the output window a label names, as the shell labels them (`output-<name>_<n>`); null for another
 * window's label.
 */
export function outputWindowNameOf(label: string): string | null {
  const match = /^output-([a-z0-9-]{1,64})_\d+$/.exec(label);
  return match ? match[1]! : null;
}

/**
 * The lines the window shows once `state` arrives, from the `held` ones it has of the run `heldKey`: `state.lines`
 * added after them when they follow on, in their place otherwise; the state's alone once it is of another run; the
 * last `max` of them.
 */
export function mergeRunOutputLines(
  held: RunOutputLine[],
  heldKey: number | null,
  state: Pick<RunOutputState, 'key' | 'lines'>,
  max: number,
): RunOutputLine[] {
  const mine = heldKey === state.key ? held : [];
  const follows = mine.length > 0 && state.lines.length > 0 && state.lines[0]!.id === mine.at(-1)!.id + 1;
  const lines = follows ? [...mine, ...state.lines] : state.lines.length > 0 ? state.lines : mine;
  return lines.length > max ? lines.slice(lines.length - max) : lines;
}
