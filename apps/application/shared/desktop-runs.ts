/**
 * Desktop build: what the app's window reads and sends to follow the Playwright runs the desktop shell starts, which
 * the bundled server is the hub of (`server/utils/desktop-runs.ts`). The window is a peer of the same hub Piwi Picker
 * reaches over its WebSocket, through two routes behind the desktop guard: a stream (`GET /api/desktop/runs/events`)
 * of the hub's own messages and of the code made at a stop, and the hub's commands (`POST /api/desktop/runs/commands`),
 * each naming the stream it is from. Code from a stop comes to the window alone, for it to copy, never to Piwi Picker.
 */
import type {
  HubCommand,
  HubFrameMessage,
  HubFrameRefusal,
  HubCodeMessage,
  HubSessionMessage,
} from '@piwitests/core/run-hub';
import type { StopCode } from '@piwitests/editor/run-host';

/** The most codes made at stops the server keeps, the latest, for a window that opens its stream later. */
export const MAX_KEPT_STOP_CODES = 20;

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
  /** A sentence about a run, to show once: a stop that went on, a code that could not be made. */
  | { type: 'notice'; root: string | null; severity: 'information' | 'warning'; message: string };

/**
 * A command of the window: one of the hub's (`HubCommand`, answered as the hub answers it), or `show`, which only the
 * window sends: the window shows the run `ref` live (`on`), so a failure no pause bar shows is held in it, until it
 * says otherwise or its stream closes. Each names the stream it comes from (`viewer`, the stream's `hello`), whose
 * views it watches and whose input it plays.
 */
export type DesktopRunCommand = (HubCommand | { type: 'show'; id: number; ref: string; on: boolean }) & {
  viewer: string;
};

/** The stream id a command names: 32 lowercase hex characters, as `hello` gives it. */
export function isDesktopRunViewer(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}
