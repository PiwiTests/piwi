/**
 * The Runs window: the runs the paired editor started, as the background worker hears them from each editor
 * service's hub (`background/run-hubs.ts`), and what the window and the worker say to each other through their port
 * (`RUNS_PORT`). The window makes no network call and never sees a hub's token: it reads this state and sends the
 * controls, which the worker passes on. What a hub sends is data from another program: shown as text, an image or a
 * frame of a live view as an image, never as markup. A frame is kept in memory, the latest one alone, never stored.
 */
import type {
  HubAction,
  HubCodeAction,
  HubCodeIntent,
  HubControlAction,
  HubImage,
  HubIntent,
  HubKeptRequest,
  HubSession,
  HubStop,
  HubTest,
  HubWorker,
} from '@piwitests/core/run-hub';
import { isViewPoint, readViewInput, type ViewInput } from '@piwitests/core/run-view';

/** The name of the Runs window's port to the worker. */
export const RUNS_PORT = 'piwi-runs';
/** The run shortcut's command, in the manifest: it has no key until the person gives it one. */
export const RUN_COMMAND = 'run-pause-resume';
/** The Runs window's page. */
export const RUNS_PAGE = 'runs.html';
/** How often the window says it is still open: within the 30 s an MV3 worker stays alive after a message. */
export const RUNS_PING_MS = 20_000;

/** What the worker found when it last asked the paired editor for its hubs. */
export type RunsDiscovery =
  /** It is asking now, for the first time since it started. */
  | 'searching'
  /** No editor is paired. */
  | 'unpaired'
  /** The editor's address is not granted to the extension. */
  | 'no-access'
  /** The editor did not answer: closed, or another program on its port. */
  | 'unreachable'
  /** The editor refused the pairing's token. */
  | 'refused'
  /** The editor's Piwi extension has no live endpoint: it predates the Runs window. */
  | 'outdated'
  /** The program on the paired port did not prove it holds the pairing's token: it was sent nothing. */
  | 'unproven'
  /** The editor answered with its hubs. */
  | 'found';

/** A hub as the window shows it: no token. */
export interface RunsHub {
  /** Its address, which names it in the window's commands. */
  id: string;
  connected: boolean;
  /** The editor it belongs to (`Visual Studio Code`, `WebStorm`); null when it does not say. */
  client: string | null;
}

/** A run of a hub; `session.ended` for one that ended, kept a while with its last workers. */
export interface RunsRun {
  hub: string;
  session: HubSession;
}

export interface RunsState {
  discovery: RunsDiscovery;
  hubs: RunsHub[];
  /** The live runs first, in the order the hubs told them, then the ended ones, the latest first. */
  runs: RunsRun[];
}

/**
 * What a command of the window asks: a control; at a stop, an intent the test's window runs (the pause bar's Pick and
 * Record, the check panel's Assert, a region's Assert a region), the requests its test kept or the one to mock; an
 * image of the stopped page; or its live view: watching it (`view`), the input played on it (`input`), and the locator
 * of the element under a point of an image of it (`pick-at`).
 */
export type RunsWhat =
  | HubControlAction
  | HubIntent
  | HubCodeIntent
  | 'requests'
  | 'mock'
  | 'image'
  | 'view'
  | 'input'
  | 'pick-at';

const WHATS: readonly string[] = [
  'pause',
  'step',
  'resume',
  'finish',
  'pick',
  'record',
  'assert',
  'assert-region',
  'requests',
  'mock',
  'image',
  'view',
  'input',
  'pick-at',
];

/** The commands that name a worker and a stop's live view: the frames come to the window that watches it alone. */
const VIEW_WHATS: readonly string[] = ['view', 'input', 'pick-at'];

/** What the window sends the worker. */
export type RunsRequest =
  /** The window's own browser window, which the popup's Runs brings to the front. */
  | { type: 'window'; windowId: number }
  /** Ask the editor for its hubs again. */
  | { type: 'find' }
  /** Keeps the worker alive while the window is open. */
  | { type: 'ping' }
  /** A command for a run, answered with `answer` of the same `id`. */
  | {
      type: 'command';
      id: number;
      hub: string;
      ref: string;
      worker: number | null;
      since: string | null;
      what: RunsWhat;
      /** For `mock` alone: the kept response to mock, the `id` of one of those `requests` listed. */
      request?: number;
      /** For `view` alone: start watching the stop's live view, or stop. */
      on?: boolean;
      /** For `input` alone: the events to play on the page, in CSS pixels of its viewport. */
      events?: ViewInput[];
      /** For `pick-at` alone: the point of an image of the page, in CSS pixels of its viewport. */
      x?: number;
      y?: number;
    };

/**
 * Why the worker answered a command itself: the hub is not connected, did not answer in time, or the window sent
 * input for a stop it does not watch.
 */
export type RunsFailure = 'offline' | 'timeout' | 'unwatched';

/** The answer to a command: the hub's own sentence, or `failure` when it never reached the hub or never came back. */
export interface RunsAnswer {
  ok: boolean;
  message: string;
  failure?: RunsFailure;
  /** For `image`: the stopped page, null when the worker has none. */
  image?: HubImage | null;
  /** For `requests`: the responses the test kept, oldest first, as the hub listed them (`parseHubMessage`). */
  requests?: HubKeptRequest[];
  /** For `pick-at`: the locator sent to the editor, null when none was found. */
  locator?: string | null;
}

/**
 * What an action that writes code at a stop came to, as a hub said, whichever surface started it: the editor wrote the
 * code (its sentence, and what to check in the code), or refused it once it started, and why. The window shows it
 * while the worker stands at the stop `since` names.
 */
export interface RunsCode {
  hub: string;
  ref: string;
  worker: number;
  since: string;
  action: HubCodeAction;
  ok: boolean;
  message: string;
  warnings: string[];
}

/** A stop's live view, as the window and the worker name it: the hub, the run, the worker and the stop. */
export interface RunsView {
  hub: string;
  ref: string;
  worker: number;
  since: string;
}

/**
 * A frame of the live view of a stop the window watches: a JPEG as the page painted it, base64, its size checked by
 * `parseHubMessage`, and the page's viewport in CSS pixels (`width`, `height`), which input and `pick-at` name their
 * points in; or the hub's sentence saying why the view sends none now (`refused`: the page is too heavy for it), until
 * a frame comes again.
 */
export type RunsFrame = RunsView & ({ width: number; height: number; data: string } | { refused: string });

/** What the worker sends the window. */
export type RunsEvent =
  | { type: 'state'; state: RunsState }
  | ({ type: 'answer'; id: number } & RunsAnswer)
  | ({ type: 'code' } & RunsCode)
  | ({ type: 'frame' } & RunsFrame)
  /** A live view the window watched ended without the window asking: its hub's connection was lost. */
  | ({ type: 'view-ended' } & RunsView);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown, max = 2_147_483_647): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

/** A message from the window, checked field by field; null for anything else. */
export function parseRunsRequest(value: unknown): RunsRequest | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case 'window':
      return isIndex(value.windowId) ? { type: 'window', windowId: value.windowId } : null;
    case 'find':
    case 'ping':
      return { type: value.type };
    case 'command': {
      const { id, hub, ref, worker, since, what } = value;
      if (!isIndex(id) || id === 0 || typeof hub !== 'string' || hub.length > 200) return null;
      if (typeof ref !== 'string' || !/^[\w-]{1,64}$/.test(ref)) return null;
      if (worker !== null && !isIndex(worker)) return null;
      if (since !== null && (typeof since !== 'string' || !since || since.length > 64)) return null;
      if (typeof what !== 'string' || !WHATS.includes(what)) return null;
      if ((what === 'image' || VIEW_WHATS.includes(what)) && worker === null) return null;
      // Every control but Pause names the stop it answers, so a click made twice does not answer the next one.
      if (what !== 'pause' && what !== 'image' && since === null) return null;
      const command = { type: 'command', id, hub, ref, worker, since, what: what as RunsWhat } as const;
      // Each field belongs to one command alone: Mock a request names the response, a view whether it is on, an input
      // its events, a pick on the image its point.
      const own: Record<string, readonly string[]> = {
        mock: ['request'],
        view: ['on'],
        input: ['events'],
        'pick-at': ['x', 'y'],
      };
      const fields = own[what] ?? [];
      if (['request', 'on', 'events', 'x', 'y'].some((f) => !fields.includes(f) && value[f] !== undefined)) return null;
      switch (what) {
        case 'mock':
          return isIndex(value.request) && value.request > 0 ? { ...command, request: value.request } : null;
        case 'view':
          return typeof value.on === 'boolean' ? { ...command, on: value.on } : null;
        case 'input': {
          const events = readViewInput(value.events);
          return typeof events === 'string' ? null : { ...command, events };
        }
        case 'pick-at':
          return isViewPoint(value.x, value.y) ? { ...command, x: value.x as number, y: value.y as number } : null;
        default:
          return command;
      }
    }
    default:
      return null;
  }
}

/** The actions in the test's window, which the pause bar shows, or a viewer drives through a headless stop's view. */
export const IN_WINDOW = ['pick', 'record', 'assert', 'assert-region'] as const;

/**
 * What a stop takes from this window (`stop.intents`, as the hub tells each connection): its live view, the input on
 * it while the window watches it, Pick on the image, the actions in the test's window where the pause bar shows or
 * while the window watches the view, Mock a request. From a service that predates it, what the worker's reporter
 * takes where the pause bar shows, and Mock a request at any stop: no live view.
 */
export function stopIntents(worker: Pick<HubWorker, 'intents'>, stop: Pick<HubStop, 'bar' | 'intents'>): HubAction[] {
  if (stop.intents) return stop.intents;
  return worker.intents.filter(
    (what) => what === 'mock' || (stop.bar && (IN_WINDOW as readonly string[]).includes(what)),
  );
}

/**
 * The state as one window reads it: the background worker's single connection to a hub watches every stop a window
 * watches, so a stop the window does not watch itself takes from it what it takes from a connection that does not
 * watch: no input, and at a stop no pause bar shows, none of the actions in the test's window.
 */
export function stateForViewer(state: RunsState, watches: (view: RunsView) => boolean): RunsState {
  return {
    ...state,
    runs: state.runs.map(({ hub, session }) => ({
      hub,
      session: {
        ...session,
        workers: session.workers.map((worker) => {
          const { stop } = worker;
          if (!stop?.intents || watches({ hub, ref: session.ref, worker: worker.worker, since: stop.since })) {
            return worker;
          }
          const intents = stop.intents.filter(
            (what) =>
              what !== 'input' &&
              what !== 'input-clicks' &&
              (stop.bar || !(IN_WINDOW as readonly string[]).includes(what)),
          );
          return { ...worker, stop: { ...stop, intents } };
        }),
      },
    })),
  };
}

/** Names a stop's live view, for the worker's maps of who watches it. */
export function viewKey(view: RunsView): string {
  return `${view.hub}|${view.ref}|${view.worker}|${view.since}`;
}

/**
 * A point of an image of a stopped page, from where the pointer is on it to CSS pixels of the page's viewport: the
 * image is shown scaled to `shown` (its content box, the border left out), and names the viewport it shows
 * (`viewport`). Kept within the viewport, at a hundredth of a pixel; null for an image shown at no size.
 */
export function pagePoint(
  offset: { x: number; y: number },
  shown: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } | null {
  if (!(shown.width > 0) || !(shown.height > 0) || !(viewport.width > 0) || !(viewport.height > 0)) return null;
  const at = (value: number, size: number, page: number) =>
    Math.round(Math.min(Math.max((value * page) / size, 0), page - 0.01) * 100) / 100;
  return { x: at(offset.x, shown.width, viewport.width), y: at(offset.y, shown.height, viewport.height) };
}

/** The live runs of a state. */
export function liveRuns(state: Pick<RunsState, 'runs'>): RunsRun[] {
  return state.runs.filter((run) => !run.session.ended);
}

/** What the global shortcut sends to one run. */
export interface ShortcutCommand {
  hub: string;
  ref: string;
  worker: number | null;
  action: 'pause' | 'resume';
  since: string | null;
}

/**
 * What the global shortcut does: resume every stopped test, each at the stop it stands at; with none stopped, pause
 * every run with a worker, each worker before its next call. Nothing when no run is live.
 */
export function shortcutCommands(runs: readonly RunsRun[]): ShortcutCommand[] {
  const live = runs.filter((run) => !run.session.ended);
  const stopped = live.flatMap(({ hub, session }) =>
    session.workers.flatMap((worker): ShortcutCommand[] =>
      worker.state === 'stopped' && worker.stop
        ? [{ hub, ref: session.ref, worker: worker.worker, action: 'resume', since: worker.stop.since }]
        : [],
    ),
  );
  if (stopped.length > 0) return stopped;
  return live
    .filter(({ session }) => session.workers.length > 0)
    .map(({ hub, session }) => ({ hub, ref: session.ref, worker: null, action: 'pause', since: null }));
}

/** A `file:` URI as a path with `/` separators: `/home/me/shop/tests/cart.spec.ts`, `C:/shop/tests/cart.spec.ts`. */
function uriPath(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:') return null;
    const path = decodeURIComponent(url.pathname);
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/** A file of the run, relative to the run's folder when it is inside it, else as its whole path. */
export function runFile(uri: string, root: string | null): string {
  const path = uriPath(uri);
  if (path === null) return uri;
  const base = root?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (base && path.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return path.slice(base.length + 1);
  return path;
}

/** Where a stop stands, as text: `tests/pages/cart.page.ts:13`, with the 1-based line. */
export function stopPlace(stop: Pick<HubStop, 'uri' | 'line'>, root: string | null): string {
  return `${runFile(stop.uri, root)}:${stop.line + 1}`;
}

/**
 * The error a failure's stop names: its `error`, else, from a service or a reporter that predates it, read from its
 * title, which the reporter makes of `Failed: ` and the error's first line, which Playwright starts with the error's
 * name (`Error: expect(locator).toBeVisible() failed`).
 */
export function stopError(stop: Pick<HubStop, 'error' | 'title'>): string {
  return stop.error ?? stop.title.replace(/^Failed:\s*(?:Error:\s*)?/, '');
}

/** A test's name: its `describe` blocks' titles, then its own. */
export function testName(test: Pick<HubTest, 'title'>): string {
  return test.title.join(' › ');
}

/** Names a worker within the state, for the window's focus and its images. */
export function workerKey(hub: string, ref: string, worker: Pick<HubWorker, 'worker'>): string {
  return `${hub}|${ref}|${worker.worker}`;
}
