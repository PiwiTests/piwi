/**
 * Desktop build: what the app's window reads and sends to follow the Playwright runs the desktop shell starts, which
 * the bundled server is the hub of (`server/utils/desktop-runs.ts`). The window is a peer of the same hub Piwi Picker
 * reaches over its WebSocket, through two routes behind the desktop guard: a stream (`GET /api/desktop/runs/events`)
 * of the hub's own messages and of the code made at a stop, and the hub's commands (`POST /api/desktop/runs/commands`),
 * each naming the stream it is from. Code from a stop, and the locators the runs' tests pick (`DESKTOP_PICKS_PATH`),
 * come to the window alone, for it to copy, never to Piwi Picker.
 */
import type {
  HubCommand,
  HubFrameMessage,
  HubFrameRefusal,
  HubCodeMessage,
  HubSessionMessage,
} from '@piwitests/core/run-hub';
import type { StopCode } from '@piwitests/editor/run-host';

/**
 * What the shell ends the name of a run nobody attends with (`PIWI_RUN_REF`, `hub_env.rs`): a Flake Lab, a bisect, a
 * lab job, a run that repeats each test (`--repeat-each` above 1) or runs in UI mode. The server holds no failure of
 * such a run, whoever watches it.
 */
export const UNATTENDED_RUN_SUFFIX = '-unattended';

/** Whether the run `ref` names is one nobody attends: none of its failures waits for an answer. */
export function isUnattendedDesktopRun(ref: string): boolean {
  return ref.endsWith(UNATTENDED_RUN_SUFFIX);
}

/** The most codes made at stops and locators picked the server keeps, the latest, for a window that opens later. */
export const MAX_KEPT_STOP_CODES = 20;

/**
 * Where a run the shell starts sends the locators its tests pick (`PIWI_EDITOR_SEND`, as an editor's Send to editor
 * pairing names its endpoint): the pause bar's **Pick a locator**, and a pick on the image of a stop. The server, which
 * the shell asks for the address with the run channel, passes each one to the window, to copy.
 */
export const DESKTOP_PICKS_PATH = '/api/desktop/runs/picks';

/**
 * A locator a test of a run picked, as the window shows it to copy: the locator, and the file, relative to the run's
 * folder, and the 1-based line of the call it was picked for, when the test named one.
 */
export interface DesktopRunPick {
  locator: string;
  file: string | null;
  line: number | null;
}

/** What the window's stream sends. */
export type DesktopRunEvent =
  /** First, once: the id the window's commands name the stream by. */
  | { type: 'hello'; viewer: string }
  /**
   * Each run live as the stream opens, then each change, as Piwi Picker hears them, with what each stop takes from
   * the window.
   */
  | HubSessionMessage
  /** A frame of a stop the window watches (`view`), or why its view sends none now. */
  | HubFrameMessage
  | HubFrameRefusal
  /** What each code made at a stop came to, whichever surface started it: its sentence. */
  | HubCodeMessage
  /** The code itself, made at a stop of a run, for the window to copy; the latest ones again as the stream opens. */
  | { type: 'stop-code'; code: StopCode }
  /** A locator a test of a run picked, for the window to copy; the latest ones again as the stream opens, with the codes. */
  | { type: 'pick'; pick: DesktopRunPick }
  /** A sentence about a run, to show once: a stop that went on, a code that could not be made. */
  | { type: 'notice'; root: string | null; severity: 'information' | 'warning'; message: string };

/**
 * A command of the window: one of the hub's (`HubCommand`, answered as the hub answers it), or `show`, which only the
 * window sends: the person turned **Hold failures** on for the run `ref` (`on`), so a failure no pause bar shows is
 * held in it, until the window says otherwise or its stream closes; never in a run nobody attends. Each names the stream it comes
 * from (`viewer`, the stream's `hello`), whose views it watches and whose input it plays.
 */
export type DesktopRunCommand = (HubCommand | { type: 'show'; id: number; ref: string; on: boolean }) & {
  viewer: string;
};

/** The stream id a command names: 32 lowercase hex characters, as `hello` gives it. */
export function isDesktopRunViewer(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}
