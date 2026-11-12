/**
 * The Runs window: the runs the paired editor started, as the background worker hears them from each editor
 * service's hub (`background/run-hubs.ts`), and the runs the paired desktop app's shell started, from the hub its
 * server is, the CI runs in progress the connected instance lists (`background/ci-runs.ts`), read-only, and what the window and the worker say to each other through their port (`RUNS_PORT`). The window makes no network call and never sees a hub's token: it reads this state and sends the
 * controls, which the worker passes on. What a hub sends is data from another program: shown as text, an image or a
 * frame of a live view or of a watched lane as an image, never as markup. A frame is kept in memory, the latest one
 * alone, never stored; so are a watched lane's layers (its call's log, its page's events, its text, its filmstrip).
 */
import { readLaneLayers, type LaneLayer } from '@piwitests/core/live-layers';
import { LIVE_SHARE_MISSING, LIVE_SHARE_UNKNOWN, type LiveViewMissing } from '@piwitests/core/live-view';
import type { LaneLayerData } from '@piwitests/core/run-channel';
import {
  type HubCodeAction,
  type HubCodeIntent,
  type HubWindowAction,
  type HubControlAction,
  type HubImage,
  type HubIntent,
  type HubKeptRequest,
  type HubSession,
  type HubWorker,
} from '@piwitests/core/run-hub';
import { isViewPoint, readViewInput, type ViewInput } from '@piwitests/core/run-view';
import { runsAttention, type RunAttention } from '@piwitests/run-model/attention';
import type { CiRun } from '@piwitests/run-model/ci';
import type { LaneState } from '@piwitests/core/live-lane';
import type { LiveViewEnd } from '@piwitests/core/live-view';
import { IN_WINDOW, laneWatchOf } from '@piwitests/run-model/stop';

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
  /**
   * The program on the paired port answered with no proof and no such page: no editor's Piwi extension, or one too old
   * to prove it holds the pairing's token. It was sent nothing.
   */
  | 'not-editor'
  /** The program on the paired port did not prove it holds the pairing's token: it was sent nothing. */
  | 'unproven'
  /** The editor answered with its hubs. */
  | 'found';

/**
 * What the worker found when it last asked the paired desktop app for the hub of its runs, once the app proved it
 * holds the pairing's token: as for the editor, and `unpaired` while no desktop app is paired.
 */
export type RunsDesktopDiscovery = Exclude<RunsDiscovery, 'searching'>;

/** A hub as the window shows it: no token. */
export interface RunsHub {
  /** Its address, which names it in the window's commands. */
  id: string;
  connected: boolean;
  /** The editor it belongs to (`Visual Studio Code`, `WebStorm`); null when it does not say. */
  client: string | null;
  /** The paired desktop app's hub, of the runs its shell starts, rather than an editor's. */
  desktop: boolean;
  /** It shows a lane of a run while it runs (`lanes` among the features it welcomed the worker with). */
  lanes: boolean;
  /** It sends a watched lane's layers beside its frames, as `watch` asks them (`layers` among its features). */
  layers: boolean;
  /** It says who is present on each run, lane and stop, and takes `drive` (`presence` among its features). */
  presence: boolean;
  /** It keeps a Hold failures for each run a person attends (`hold` among its features): a run without one is unattended. */
  holds: boolean;
  /** It stops a whole run as the tool that started it does (`stop` among its features), for a run `canStopRun` names. */
  stops: boolean;
  /**
   * It opens Playwright's trace viewer on a lane's running test, on its own machine (`trace` among its features), for a
   * worker `canOpenTrace` names.
   */
  traces: boolean;
  /**
   * It shares each run of its editor window live until the person stops (`share-window` among its features): Share
   * live offers the window's runs beside the run's own.
   */
  sharesWindow: boolean;
  /** Its editor window shares each of its runs live now, until the person stops or the window closes. */
  windowShared: boolean;
}

/** A run of a hub; `session.ended` for one that ended, kept a while with its last workers. */
export interface RunsRun {
  hub: string;
  session: HubSession;
  /** An ended run that failed or timed out while no Runs window had the focus, until one takes it. */
  unseen?: boolean;
}

export interface RunsState {
  discovery: RunsDiscovery;
  /** What the paired desktop app answered; `unpaired` while none is. */
  desktop: RunsDesktopDiscovery;
  hubs: RunsHub[];
  /** The live runs first, in the order the hubs told them, then the ended ones, the latest first. */
  runs: RunsRun[];
  /**
   * The CI runs in progress of the projects this browser maps, read-only, from the instance the extension is
   * connected to (`background/ci-runs.ts`); none without connected mode.
   */
  ci?: RunsCiRun[];
}

/**
 * A test a CI run runs now, as its lane on the instance stands (`lane` of the run's stream): its shard (null for a run
 * not sharded), its lane (Playwright's `parallelIndex`), the worker in it, where it stands and the test's title.
 */
export interface RunsCiTest {
  shard: number | null;
  lane: number;
  worker: number | null;
  state: LaneState;
  title: string;
  retry: number;
}

/**
 * A CI run in progress as the window lists it: the instance's list, then, for a run whose own stream the worker reads
 * (`MAX_CI_STREAMS`, the newest), the tests it runs now and whether its lanes can be watched (its project's live view
 * on and the run holding a key).
 */
export interface RunsCiRun extends CiRun {
  tests: RunsCiTest[];
  watchable: boolean;
}

/** A lane of a CI run, as the window and the worker name it: the run on the instance, its shard and its lane. */
export interface RunsCiLane {
  runId: number;
  shard: number | null;
  lane: number;
}

/**
 * An image of a CI lane the window watches: a JPEG as the instance sent it, base64, with the test and the call it was
 * taken at; or the instance's sentence saying why the lane sends none now (`refused`), until an image comes again.
 */
export type RunsCiFrame = RunsCiLane &
  ({ data: string; test: string | null; call: string | null } | { refused: string });

/**
 * Why a CI lane the window watched ended without its asking: as the instance said it (`LiveViewEnd`), or it stopped
 * answering (`silent`), closed the watch (`closed`), its stream broke (`broken`), or another Runs window took the one
 * watch to another lane (`moved`).
 */
export type CiWatchEnd = LiveViewEnd | 'silent' | 'closed' | 'broken' | 'moved';

/**
 * Why a CI lane was not watched: the run is no longer listed (`unlisted`), its lanes cannot be watched
 * (`unwatchable`), no test ran in the lane yet (`no-test`), the instance did not answer (`offline`) or not in time
 * (`late`), its live view is not one the extension reads (`older`), or it refused (`refused`, its sentence the
 * answer's `message`, else its `status`).
 */
export type CiWatchFailure = 'unlisted' | 'unwatchable' | 'no-test' | 'offline' | 'late' | 'older' | 'refused';

/**
 * What a command of the window asks: a control; at a stop, an intent the test's window runs (the pause bar's Pick and
 * Record, the check panel's Assert, a region's Assert a region), the requests its test kept or the one to mock; an
 * image of the stopped page; or its live view: watching it (`view`), the input played on it (`input`), and the locator
 * of the element under a point of an image of it (`pick-at`); or the run shared live on the team instance, or no more
 * (`share`, Share live); or a lane of the run watched while it runs, through its tests and stops (`watch`, Watch); or
 * the stop driven from here, an agent's actions there refused, or given back (`drive`, Take control and Give back); or
 * the whole run stopped (`stop`, Stop the run); or Playwright's trace viewer opened on a lane's running test, on the
 * hub's machine (`trace`, Open the trace so far: the hub's `openTrace`).
 */
export type RunsWhat =
  | HubControlAction
  | HubIntent
  | HubCodeIntent
  | HubWindowAction
  | 'requests'
  | 'mock'
  | 'image'
  | 'view'
  | 'input'
  | 'pick-at'
  | 'share'
  | 'hold'
  | 'watch'
  | 'drive'
  | 'stop'
  | 'trace';

const WHATS: readonly string[] = [
  'pause',
  'step',
  'resume',
  'finish',
  'end',
  'pick',
  'record',
  'assert',
  'assert-region',
  'front',
  'requests',
  'mock',
  'image',
  'view',
  'input',
  'pick-at',
  'share',
  'hold',
  'watch',
  'give-up',
  'drive',
  'stop',
  'trace',
];

/** The commands that name a worker and a stop's live view: the frames come to the window that watches it alone. */
const VIEW_WHATS: readonly string[] = ['view', 'input', 'pick-at'];

/** What the window sends the worker. */
export type RunsRequest =
  /** The window's own browser window, which the popup's Runs brings to the front. */
  | { type: 'window'; windowId: number }
  /** Ask the editor and the desktop app for their hubs again. */
  | { type: 'find' }
  /** Keeps the worker alive while the window is open. */
  | { type: 'ping' }
  /**
   * Watch a running test's lane of a CI run (`on`), read-only, or stop: answered with `answer` of the same `id`, then
   * its images as `ci-frame` and its end as `ci-ended`.
   */
  | ({ type: 'ci-watch'; id: number; on: boolean } & RunsCiLane)
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
      /**
       * For `view`: start watching the stop's live view, or stop; for `share`: share the run live, or stop; for `watch`:
       * start watching the lane, or stop; for `drive`: drive the stop, or give it back.
       */
      on?: boolean;
      /**
       * For `share` alone: each run of the hub's editor window from now on, the run named included, until the person
       * stops (`window`), rather than the run alone; with `on: false`, every run of the window stops sharing.
       */
      scope?: 'window';
      /** For `watch` and `trace`: the lane, Playwright's `parallelIndex`. */
      lane?: number;
      /**
       * For `watch` alone, at a hub that sends layers: the layers of the lane the window takes beside its frames
       * (`@piwitests/core/live-layers`); asked again for a lane it watches, they change, and `text` takes the page's
       * text now.
       */
      layers?: LaneLayer[];
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
  /** For `pick-at`: whether an editor took the locator; absent when the run's reporter does not say. */
  taken?: boolean;
  /** For `ci-watch`: why the lane was not watched; the instance's own sentence in `message` when it gave one. */
  ci?: CiWatchFailure;
  /** For `ci-watch` refused by the instance with no sentence: its status. */
  status?: number;
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

/** A lane of a run, as the window and the worker name it: the hub, the run, and Playwright's `parallelIndex`. */
export interface RunsLane {
  hub: string;
  ref: string;
  lane: number;
}

/**
 * A frame of a lane the window watches: the page of the worker `worker` running the test `test` (Playwright's id) or
 * standing at the stop `since` names (null while the test runs), as a frame of a stop's live view carries it; or the
 * hub's sentence saying why the lane sends none now (`refused`), until a frame comes again.
 */
export type RunsLaneFrame = RunsLane & { worker: number; since: string | null } & (
    | { test: string; width: number; height: number; data: string }
    | { test: string | null; refused: string }
  );

/**
 * A layer of a lane the window watches and asked for (`watch`'s `layers`): of the worker `worker` and the test `test`
 * (Playwright's id; null for the text of a page no test shows), as the hub sent it, read by `parseHubMessage`.
 */
export type RunsLaneLayer = RunsLane & { worker: number; test: string | null } & LaneLayerData;

/** What the worker sends the window. */
export type RunsEvent =
  | { type: 'state'; state: RunsState }
  | ({ type: 'answer'; id: number } & RunsAnswer)
  | ({ type: 'code' } & RunsCode)
  | ({ type: 'frame' } & RunsFrame)
  /** A live view the window watched ended without the window asking: its hub's connection was lost. */
  | ({ type: 'view-ended' } & RunsView)
  | ({ type: 'lane-frame' } & RunsLaneFrame)
  /** A lane the window watched is no longer watched without the window asking: its hub's connection was lost. */
  | ({ type: 'lane-ended' } & RunsLane)
  | ({ type: 'lane-layer' } & RunsLaneLayer)
  | ({ type: 'ci-frame' } & RunsCiFrame)
  /** A CI lane the window watched ended without the window asking, and why. */
  | ({ type: 'ci-ended'; why: CiWatchEnd } & RunsCiLane)
  /** The hubs were asked for again, as the window's `find` asked: Look again has its answer. */
  | { type: 'found' };

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
    case 'ci-watch': {
      const { id, runId, shard, lane, on } = value;
      if (!isIndex(id) || id === 0 || !isIndex(runId) || runId === 0 || !isIndex(lane, 1024)) return null;
      if (shard !== null && (!isIndex(shard, 1024) || shard === 0)) return null;
      return typeof on === 'boolean' ? { type: 'ci-watch', id, runId, shard, lane, on } : null;
    }
    case 'command': {
      const { id, hub, ref, worker, since, what } = value;
      if (!isIndex(id) || id === 0 || typeof hub !== 'string' || hub.length > 200) return null;
      if (typeof ref !== 'string' || !/^[\w-]{1,64}$/.test(ref)) return null;
      if (worker !== null && !isIndex(worker)) return null;
      if (since !== null && (typeof since !== 'string' || !since || since.length > 64)) return null;
      if (typeof what !== 'string' || !WHATS.includes(what)) return null;
      if ((what === 'image' || what === 'drive' || VIEW_WHATS.includes(what)) && worker === null) return null;
      // Share live, Hold failures and Stop the run name the run alone, and Watch and Open the trace so far the run and
      // its lane.
      if (['share', 'hold', 'stop', 'watch', 'trace'].includes(what) && (worker !== null || since !== null))
        return null;
      // Every control but Pause names the stop it answers, so a click made twice does not answer the next one; End the
      // test while a Pause waits for a call names none, and its worker.
      if (what === 'give-up' && (since !== null || worker === null)) return null;
      if (!['pause', 'image', 'share', 'hold', 'stop', 'watch', 'trace', 'give-up'].includes(what) && since === null)
        return null;
      const command = { type: 'command', id, hub, ref, worker, since, what: what as RunsWhat } as const;
      // Each field belongs to one command alone: Mock a request names the response, a view whether it is on, an input
      // its events, a pick on the image its point, Watch the lane and whether it is on, Open the trace so far the lane.
      const own: Record<string, readonly string[]> = {
        mock: ['request'],
        view: ['on'],
        share: ['on', 'scope'],
        hold: ['on'],
        drive: ['on'],
        watch: ['lane', 'on', 'layers'],
        trace: ['lane'],
        input: ['events'],
        'pick-at': ['x', 'y'],
      };
      const fields = own[what] ?? [];
      const named = ['request', 'on', 'lane', 'layers', 'events', 'x', 'y', 'scope'];
      if (named.some((f) => !fields.includes(f) && value[f] !== undefined)) return null;
      switch (what) {
        case 'mock':
          return isIndex(value.request) && value.request > 0 ? { ...command, request: value.request } : null;
        case 'share':
          if (typeof value.on !== 'boolean' || (value.scope !== undefined && value.scope !== 'window')) return null;
          return value.scope === 'window'
            ? { ...command, on: value.on, scope: 'window' }
            : { ...command, on: value.on };
        case 'view':
        case 'hold':
        case 'drive':
          return typeof value.on === 'boolean' ? { ...command, on: value.on } : null;
        case 'watch': {
          if (typeof value.on !== 'boolean' || !isIndex(value.lane)) return null;
          if (value.layers === undefined) return { ...command, lane: value.lane, on: value.on };
          const layers = readLaneLayers(value.layers);
          return layers ? { ...command, lane: value.lane, on: value.on, layers } : null;
        }
        case 'trace':
          return isIndex(value.lane) ? { ...command, lane: value.lane } : null;
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

/**
 * The state as one window reads it: the background worker's single connection to a hub watches every stop and lane a
 * window watches, so a stop the window does not watch itself (`watches`: its live view, or the lane of its worker,
 * Playwright's `parallelIndex`, null for a worker that runs no test, whose stop no lane shows) takes from it what it
 * takes from a connection that does not watch: no input, and at a stop no pause bar shows, none of the actions in the
 * test's window.
 */
export function stateForViewer(state: RunsState, watches: (view: RunsView, lane: number | null) => boolean): RunsState {
  return {
    ...state,
    runs: state.runs.map(({ hub, session, ...run }) => ({
      ...run,
      hub,
      session: {
        ...session,
        workers: session.workers.map((worker) => {
          const { stop } = worker;
          const at = { hub, ref: session.ref, worker: worker.worker };
          const lane = worker.test ? worker.parallelIndex : null;
          if (!stop?.intents || watches({ ...at, since: stop.since }, lane)) return worker;
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

/** The live runs of a state. */
export function liveRuns(state: Pick<RunsState, 'runs'>): RunsRun[] {
  return state.runs.filter((run) => !run.session.ended);
}

/** The runs of the hubs whose connection answers now: a lost hub's runs, as last heard, are left out. */
export function answeringRuns(state: Pick<RunsState, 'runs' | 'hubs'>): RunsRun[] {
  return state.runs.filter((run) => state.hubs.some((hub) => hub.id === run.hub && hub.connected));
}

/**
 * What the runs whose hub answers ask of the person now (`runsAttention`), and the failed tests of the runs that ended
 * `unseen` (a run that failed with no test failed counts as one): the toolbar's badge, the popup's Runs tile and the
 * Runs window's title say it.
 */
export function attentionOf(state: Pick<RunsState, 'runs' | 'hubs'>): RunAttention | null {
  const live = runsAttention(answeringRuns(state).map((run) => run.session));
  const missed = state.runs
    .filter((run) => run.unseen)
    .reduce((sum, run) => sum + Math.max(1, run.session.progress?.failed ?? 0), 0);
  if (missed === 0) return live;
  const { waiting = 0, heldFailures = 0, failed = 0 } = live ?? {};
  return { state: waiting > 0 ? 'waiting' : 'failing', waiting, heldFailures, failed: failed + missed };
}

/** How a reporter of 0.66.0 and earlier says its run was not registered. */
const EARLIER_UNREGISTERED =
  "This run cannot be shared live: the reporter's global setup did not register it with the instance as it started (wrapConfig adds it).";

/**
 * Why a run cannot be shared live, as the reporter says it (`LIVE_SHARE_MISSING`, and `unknown` for workers given no
 * key at all), which the window says in its own words; null for any other sentence of the hub's, shown as it came.
 */
export function shareRefusalOf(refused: string): LiveViewMissing | 'unknown' | null {
  if (refused === LIVE_SHARE_UNKNOWN) return 'unknown';
  if (refused === EARLIER_UNREGISTERED) return 'unregistered';
  const reasons = Object.keys(LIVE_SHARE_MISSING) as LiveViewMissing[];
  return reasons.find((why) => LIVE_SHARE_MISSING[why] === refused) ?? null;
}

/**
 * Whether a run says where its tests' pages show: a live run none of whose workers stands stopped, with a worker whose
 * reporter shows a stopped page live (`view`) and whose test can stop. `desktop` for a run of the desktop app's hub,
 * which sets no breakpoints; null when there is nothing to say, and for a run with a worker whose lane can be watched
 * while it runs, whose row says it (Watch).
 */
export function pageHintOf(
  run: RunsRun,
  hub: Pick<RunsHub, 'desktop' | 'lanes'> | undefined,
): 'editor' | 'desktop' | null {
  const { session } = run;
  if (session.ended || session.workers.some((worker) => worker.state === 'stopped')) return null;
  if (session.workers.some((worker) => laneWatchOf(hub, worker) === 'watch')) return null;
  const stops = session.workers.some((worker) => worker.intents.includes('view') && !worker.test?.cannotPause);
  if (!stops) return null;
  return hub?.desktop ? 'desktop' : 'editor';
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
 * Whether a person attends a run: not one whose hub keeps a Hold failures for each run a person attends but gives it
 * none (a Flake Lab run, a bisect, a lab job, a run that repeats its tests past a failure, UI mode). A hub that keeps
 * none, of an older version, names no run unattended.
 */
export function attendedRun(run: RunsRun, hubs: readonly RunsHub[]): boolean {
  const hub = hubs.find((h) => h.id === run.hub);
  return !hub?.holds || !!run.session.hold;
}

/**
 * What the global shortcut does: resume every stopped test, each at the stop it stands at, a run nobody attends
 * included (a person paused it); with none stopped, pause every run a person attends (`attendedRun`) with a worker,
 * each worker before its next call, the others left to run. Nothing when no run is live.
 */
export function shortcutCommands(runs: readonly RunsRun[], hubs: readonly RunsHub[] = []): ShortcutCommand[] {
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
    .filter((run) => run.session.workers.length > 0 && attendedRun(run, hubs))
    .map(({ hub, session }) => ({ hub, ref: session.ref, worker: null, action: 'pause', since: null }));
}

/** Where the person left the Runs window, in `chrome.storage.local`: the next one opens there. */
export const RUNS_BOUNDS_KEY = 'runsWindowBounds';

/** A window's place and size on screen, in CSS pixels. */
export interface RunsBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A kept place, checked: whole numbers, a size a window can have and a place on some screen; null otherwise. */
export function readRunsBounds(value: unknown): RunsBounds | null {
  if (typeof value !== 'object' || value === null) return null;
  const { left, top, width, height } = value as Record<string, unknown>;
  const whole = (n: unknown, min: number, max: number): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
  if (!whole(width, 240, 8000) || !whole(height, 200, 8000)) return null;
  if (!whole(left, -20000, 20000) || !whole(top, -20000, 20000)) return null;
  return { left, top, width, height };
}

/** The keys of the stop controls, as the debuggers have them: Resume, Step and Finish. */
export type StopKey = 'resume' | 'step' | 'finish';

/** Each control's keys, as `aria-keyshortcuts` names them: Resume on F8 (and F5), Step on F10, Finish on Shift+F11. */
export const STOP_KEYS: Record<StopKey, string> = { resume: 'F8 F5', step: 'F10', finish: 'Shift+F11' };

/** The control a key press asks for, of `STOP_KEYS`; null for any other key or one held with Ctrl, Alt or Meta. */
export function stopKeyOf(event: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): StopKey | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  if ((event.key === 'F8' || event.key === 'F5') && !event.shiftKey) return 'resume';
  if (event.key === 'F10' && !event.shiftKey) return 'step';
  if (event.key === 'F11' && event.shiftKey) return 'finish';
  return null;
}

/** A stopped test a key steers: its run, its worker and its stop. */
export interface KeyTarget {
  run: RunsRun;
  worker: number;
  since: string;
  failed: boolean;
}

/**
 * The stopped test a key steers: the one whose row holds the focus (`focused`, its `workerKey`), else the only stopped
 * test of the live runs whose hub answers (`answering`, by hub id); null when there is none, or several and the focus
 * is in none of them.
 */
export function keyTargetOf(
  runs: readonly RunsRun[],
  focused: string | null,
  answering: (hub: string) => boolean = () => true,
): KeyTarget | null {
  const stopped = runs.flatMap((run) =>
    run.session.ended || !answering(run.hub)
      ? []
      : run.session.workers.flatMap((worker): KeyTarget[] =>
          worker.state === 'stopped' && worker.stop
            ? [{ run, worker: worker.worker, since: worker.stop.since, failed: worker.stop.reason === 'failure' }]
            : [],
        ),
  );
  const chosen = focused ? stopped.find((s) => workerKey(s.run.hub, s.run.session.ref, s) === focused) : undefined;
  return chosen ?? (stopped.length === 1 ? stopped[0]! : null);
}

/**
 * Names a worker's slot within a run (Playwright's `parallelIndex`), which a worker started in its place after a failure
 * takes: what the window keeps Watch live by.
 */
export function slotKey(hub: string, ref: string, parallelIndex: number): string {
  return `${hub}|${ref}|slot-${parallelIndex}`;
}

/** Names a lane of a CI run, for the worker's watch and the window's rows. */
export function ciLaneKey(lane: RunsCiLane): string {
  return `${lane.runId}|${lane.shard ?? ''}|${lane.lane}`;
}

/**
 * A CI lane's view on the run's page (`?watch=`, the shard and the worker's number from 1, `2` or `1.2`): **Watch on
 * the dashboard**.
 */
export function ciDashboardWatch(run: Pick<RunsCiRun, 'url'>, lane: Pick<RunsCiLane, 'shard' | 'lane'>): string {
  return `${run.url}?watch=${lane.shard !== null ? `${lane.shard}.` : ''}${lane.lane + 1}`;
}

/** Names a worker within the state, for the window's focus and its images. */
export function workerKey(hub: string, ref: string, worker: Pick<HubWorker, 'worker'>): string {
  return `${hub}|${ref}|${worker.worker}`;
}
