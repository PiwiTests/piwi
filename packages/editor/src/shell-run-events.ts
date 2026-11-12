/**
 * What a desktop shell's window reads and sends to follow the Playwright runs the shell starts, which its host is the
 * hub of (`./shell-runs.ts`): the dashboard's desktop build and Piwi Runner serve the same routes. The window is a peer
 * of the hub Piwi Picker reaches over its WebSocket, through two routes behind the access token: a stream
 * (`DESKTOP_RUN_EVENTS_PATH`) of the hub's own messages and of the code made at a stop, and the hub's commands
 * (`DESKTOP_RUN_COMMANDS_PATH`), each naming the stream it is from. Code from a stop, and the locators the runs' tests
 * pick (`DESKTOP_PICKS_PATH`), come to the window alone, for it to copy, never to Piwi Picker. Types and checks alone,
 * so a window's bundle imports it.
 */
import type {
  HubCommand,
  HubFrameMessage,
  HubFrameRefusal,
  HubCodeMessage,
  HubLaneFrameMessage,
  HubLaneFrameRefusal,
  HubLaneLayerMessage,
  HubSessionMessage,
} from '@piwitests/core/run-hub';
import type { StopCode } from './protocol';

/**
 * Where the shell reads the run channel it names in each run's environment (`PIWI_RUN_CHANNEL`), with where the run's
 * picks go (`PIWI_EDITOR_SEND`) and the hub: for the shell alone.
 */
export const DESKTOP_RUN_CHANNEL_PATH = '/api/desktop/run-channel';

/** The window's stream of the runs. */
export const DESKTOP_RUN_EVENTS_PATH = '/api/desktop/runs/events';

/** The window's commands to the runs. */
export const DESKTOP_RUN_COMMANDS_PATH = '/api/desktop/runs/commands';

/**
 * Where a run the shell starts sends the locators its tests pick (`PIWI_EDITOR_SEND`, as an editor's Send to editor
 * pairing names its endpoint): the pause bar's **Pick a locator**, and a pick on the image of a stop. The host, which
 * the shell asks for the address with the run channel, passes each one to the window, to copy.
 */
export const DESKTOP_PICKS_PATH = '/api/desktop/runs/picks';

/** The most codes made at stops and locators picked the host keeps, the latest, for a window that opens later. */
export const MAX_KEPT_STOP_CODES = 20;

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
  /** Once, after every run live as the stream opened: a run the window kept that is not among them ended meanwhile. */
  | { type: 'listed' }
  /** A frame of a stop the window watches (`view`), or why its view sends none now. */
  | HubFrameMessage
  | HubFrameRefusal
  /** A frame of a lane the window watches (`watch`), as its test runs or stands at a stop, or why none comes now. */
  | HubLaneFrameMessage
  | HubLaneFrameRefusal
  /**
   * A layer of a lane the window watches and asked for (`watch`'s `layers`): the call its test is in, what its page
   * said, the page's text, an image of its filmstrip. Kept nowhere on the way.
   */
  | HubLaneLayerMessage
  /** What each code made at a stop came to, whichever surface started it: its sentence. */
  | HubCodeMessage
  /** The code itself, made at a stop of a run, for the window to copy; the latest ones again as the stream opens. */
  | { type: 'stop-code'; code: StopCode }
  /** A locator a test of a run picked, for the window to copy; the latest ones again as the stream opens, with the codes. */
  | { type: 'pick'; pick: DesktopRunPick }
  /** A sentence about a run, to show once: a stop that went on, a code that could not be made. */
  | { type: 'notice'; root: string | null; severity: 'information' | 'warning'; message: string }
  /**
   * A signed-in teammate asks to watch the run `ref`, which is not shared live (**Ask to watch**): the window asks the
   * person, naming them (`by`) and the run's number on the instance (`run`), with Share live and Not now (`answer-ask`).
   */
  | { type: 'ask-to-watch'; ref: string; id: string; by: string; run: number | null }
  /**
   * Another tool asked through the hub to stop the run `ref` (the hub's `stop`): the window that holds it stops it as
   * its own Stop does, else the main window has the shell stop its process.
   */
  | { type: 'stop-run'; ref: string };

/**
 * A command of the window: one of the hub's (`HubCommand`, answered as the hub answers it), or `show`, which only the
 * window sends: the person turned **Hold failures** on for the run `ref` (`on`), so a failure no pause bar shows is
 * held in it, until the window says otherwise or its stream closes; never in a run nobody attends. Each names the
 * stream it comes from (`viewer`, the stream's `hello`), whose views it watches and whose input it plays.
 */
export type DesktopRunCommand = (
  | HubCommand
  | { type: 'show'; id: number; ref: string; on: boolean }
  /** The person's Not now to a teammate's ask to watch the run `ref` (`ask`, the ask's id). */
  | { type: 'answer-ask'; id: number; ref: string; ask: string }
) & {
  viewer: string;
};

/** The stream id a command names: 32 lowercase hex characters, as `hello` gives it. */
export function isDesktopRunViewer(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}
