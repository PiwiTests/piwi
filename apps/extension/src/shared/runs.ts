/**
 * The Runs window: the runs the paired editor started, as the background worker hears them from each editor
 * service's hub (`background/run-hubs.ts`), and what the window and the worker say to each other through their port
 * (`RUNS_PORT`). The window makes no network call and never sees a hub's token: it reads this state and sends the
 * controls, which the worker passes on. What a hub sends is data from another program: shown as text, an image as an
 * image, never as markup.
 */
import type {
  HubControlAction,
  HubImage,
  HubIntent,
  HubSession,
  HubStop,
  HubTest,
  HubWorker,
} from '@piwitests/core/run-hub';

/** The name of the Runs window's port to the worker. */
export const RUNS_PORT = 'piwi-runs';
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

/** What a command of the window asks: a control, an intent of the pause bar, or an image of the stopped page. */
export type RunsWhat = HubControlAction | HubIntent | 'image';

const WHATS: readonly string[] = ['pause', 'step', 'resume', 'finish', 'pick', 'record', 'image'];

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
    };

/** Why the worker answered a command itself: the hub is not connected, or did not answer in time. */
export type RunsFailure = 'offline' | 'timeout';

/** The answer to a command: the hub's own sentence, or `failure` when it never reached the hub or never came back. */
export interface RunsAnswer {
  ok: boolean;
  message: string;
  failure?: RunsFailure;
  /** For `image`: the stopped page, null when the worker has none. */
  image?: HubImage | null;
}

/** What the worker sends the window. */
export type RunsEvent = { type: 'state'; state: RunsState } | ({ type: 'answer'; id: number } & RunsAnswer);

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
      if (what === 'image' && worker === null) return null;
      // Every control but Pause names the stop it answers, so a click made twice does not answer the next one.
      if (what !== 'pause' && what !== 'image' && since === null) return null;
      return { type: 'command', id, hub, ref, worker, since, what: what as RunsWhat };
    }
    default:
      return null;
  }
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

/** A test's name: its `describe` blocks' titles, then its own. */
export function testName(test: Pick<HubTest, 'title'>): string {
  return test.title.join(' › ');
}

/** Names a worker within the state, for the window's focus and its images. */
export function workerKey(hub: string, ref: string, worker: Pick<HubWorker, 'worker'>): string {
  return `${hub}|${ref}|${worker.worker}`;
}
