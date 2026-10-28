/**
 * The runs the editor started, as their workers tell them over the run channel (`@piwitests/core/run-channel`): a
 * session per run, by the ref of its command (`PIWI_ORIGIN_REF`), holding its workers, the test each one runs and where
 * it stands stopped. The record channel's socket (`recorder/handoff.ts`) hands each worker's run connection here. The
 * client hears each session (`piwi/runSessionChanged`) and steers it (`piwi/runControl`, `piwi/setRunBreakpoints`,
 * `piwi/pausedPage`), as Piwi Picker does through the hub (`run-hub.ts`); both can start an intent at a stop (`intent`:
 * the pause bar's Pick a locator and Record here, the check panel's Check an element, a region's ARIA snapshot) and ask
 * the stopped worker what it holds (`requests`, `mock`, `locator`: the responses its test kept, the one to mock, a
 * locator's matches), which `stop-actions.ts` turns into code. A viewer outside the page (a Piwi Picker connection of
 * the hub) watches a stopped page's live view (`view`): the worker starts it with the first viewer of a stop and stops
 * it with the last, and its frames go to that stop's viewers alone, none of an older stop; a viewer plays its input on
 * the page it watches (`input`), and the intents a stop no pause bar shows takes from a viewer of its view. Any client
 * picks the element under a point of an image of a stopped page (`pickAt`). A worker names places relative to the
 * run's working directory; the client, by their file's URI as the workspace names it: the session converts both ways.
 * A stop that shows no pause bar while no surface can answer stops (the client does not, and no Piwi Picker hears the
 * runs) is resumed at once, and so is one held when the last of them goes. A failure no pause bar shows is held only
 * in a run started to be watched (`watched`: with the editor's breakpoints or a `page.pause()`) or while a Runs window
 * of Piwi Picker follows the runs, else it goes on at once and no client hears of it. A worker's connection that
 * closes lets a stop no pause bar shows go on; a stop the bar shows waits there for its answer. An agent (the service's
 * MCP server, `run-agent.ts`) hears what each worker says (`heard`), has a run's workers tell what their tests do
 * (`followRun`), and, at a stop, reads the page's ARIA snapshot (`snapshot`), acts on an element of it by its ref
 * (`act`), ranks an element's locators (`refLocator`) and shares the browser with Playwright's own tools (`bind`);
 * a stop it asked for (Pause, Step, Run to) is said to be the agent's (`RunStop.by`).
 */
import * as path from 'node:path';
import type * as net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RUN_INTENT_NAMES,
  parseRunToHub,
  type BindAnswer,
  type HubToRun,
  type IntentAnswer,
  type LocatorAnswer,
  type MockAnswer,
  type PickAtAnswer,
  type Place,
  type RefLocatorAnswer,
  type RequestsAnswer,
  type RunActAction,
  type RunEvent,
  type RunHold,
  type RunIntent,
  type RunQuery,
  type RunTake,
  type RunToHub,
  type SnapshotAnswer,
} from '@piwitests/core/run-channel';
import { isViewPoint, type ViewInput } from '@piwitests/core/run-view';
import type {
  PausedImage,
  PausedPageParams,
  PausedPageResult,
  PickAtParams,
  PickAtResult,
  RunControlParams,
  RunControlResult,
  RunSession,
  RunStop,
  RunTest,
  SetRunBreakpointsParams,
} from './protocol.js';
import type { HubAction } from '@piwitests/core/run-hub';
import { relativeTo } from './workspace.js';

/** How often a session's changes are sent at most, but a stop and its end, which are sent at once. */
export const SESSION_PACE_MS = 300;
/** The least time between two notifications of a session: a burst of stops and their ends is sent once in it. */
export const SESSION_BURST_MS = 50;
/** How long a session waits for a worker after its last one left before it ends: Playwright starts a new one. */
export const SESSION_LINGER_MS = 5_000;
/** How long `piwi/pausedPage`, and an intent, wait for the worker's answer. */
export const PAUSED_PAGE_WAIT_MS = 10_000;
/** The runs whose breakpoints (for workers that connect later) and whose command's end the service keeps, at most. */
const MAX_KEPT_RUNS = 50;
/** The stops the service shows and answers among those a worker holds only then (`attached`): a held failure. */
const SHOWN_HOLDS: readonly RunHold[] = ['failure'];

type RunAttach = Extract<RunToHub, { type: 'run-attach' }>;

/** What a worker's answer to a request carries: an image, whether an intent started, or a query's answer. */
type Answered =
  | PausedImage
  | IntentAnswer
  | RequestsAnswer
  | MockAnswer
  | LocatorAnswer
  | PickAtAnswer
  | SnapshotAnswer
  | RefLocatorAnswer
  | BindAnswer
  | null;

/**
 * What a worker said, as an agent hears it (`RunSessionsOptions.heard`): it connected or left, a test began or ended,
 * it stopped (the stop as the client hears it) or went on, the running test did something (`RunEvent`), and the run
 * ended (no worker).
 */
export type RunHeard =
  | { type: 'joined' }
  | { type: 'left' }
  | { type: 'test-begin'; test: RunTest }
  | { type: 'test-end'; status: string; pausedMs: number }
  | { type: 'stopped'; stop: RunStop }
  | { type: 'running'; since: string }
  | { type: 'event'; event: RunEvent }
  | { type: 'ended' };

/**
 * A frame of a stopped page's live view, as a viewer gets it: the stop it shows, named by `since`; or why the view
 * sends none now (`refused`: each image of the page is too long), until a frame comes again.
 */
export type ViewFrame = { ref: string; worker: number; since: string } & (
  | {
      /** The page's viewport, in CSS pixels. */
      width: number;
      height: number;
      /** A JPEG, base64. */
      data: string;
    }
  | { refused: string }
);

/** Who watches the live view of a stop: each frame of it goes to `frame`, while it watches. */
export interface Viewer {
  frame(frame: ViewFrame): void;
}

/** A stop as a client names it: the run, the one stopped worker or `worker`, and the stop it showed (`since`). */
export interface StopParams {
  ref: string;
  worker?: number | null;
  since?: string | null;
}

/** What a stop is asked to start from outside the page: the stop it was shown, as `piwi/runControl` names one. */
export interface IntentParams extends StopParams {
  since: string;
  what: RunIntent;
  /** Who asks: a viewer of the stop's live view starts one at a stop no pause bar shows. */
  viewer?: Viewer | null;
}

/** A stop's live view: start (`on`) or stop watching it. */
export interface ViewParams extends StopParams {
  since: string;
  on: boolean;
}

/** A worker's stop, as the code made there names it. */
export interface StopRef {
  ref: string;
  worker: number;
  /** The worker's own number for the stop. */
  stop: number;
  since: string;
  reason: RunStop['reason'];
  /** The file of the stopped call, as the workspace names it, its 0-based line, and its 0-based column when known. */
  uri: string;
  line: number;
  character: number | null;
  /** The run's folder, as `piwi/status` names it. */
  root: string | null;
}

/** Why an action that writes code is refused when the client writes none. */
export const NO_CODE = "The editor cannot write code from a stop: update Piwi's extension in the editor.";

/** What a query asks, as a refusal names it. */
type Query = RunQuery | 'view' | 'input' | 'pick-at' | 'snapshot' | 'act' | 'ref-locator' | 'bind';

/** What each query asks, as a refusal names it. */
const QUERY_WORDS: Record<Query, string> = {
  requests: 'list the responses its test kept',
  mock: 'hand over a response it kept',
  locator: 'count a locator on the stopped page',
  view: "show the stopped page's live view",
  input: 'play input on the stopped page',
  'pick-at': 'pick the element under a point of an image of the stopped page',
  snapshot: "read the stopped page's ARIA snapshot for an agent",
  act: 'act on the stopped page for an agent',
  'ref-locator': "rank the locators of a stopped page's element for an agent",
  bind: 'share its browser with Playwright tools',
};

/** Why the input of a viewer that does not watch the stop is refused. */
const NEEDS_VIEW = 'The input needs the live view of this stop: watch it first.';

export interface RunSessionsOptions {
  /** A session changed, or ended: the client hears it. */
  notify(session: RunSession): void;
  /**
   * Whether a surface shows the stops and answers them: the client (`InitializationOptions.runControl`), or a Piwi
   * Picker subscribed to the hub.
   */
  answersStops(): boolean;
  /** A sentence for the client to show once, about the folder `root`. */
  notice(root: string, severity: 'information' | 'warning', message: string): void;
  /** The folder of the Playwright config a run's working directory is, as the workspace names it; null for none. */
  rootOf(cwd: string): string | null;
  /** Whether the client writes the code made at a stop (`InitializationOptions.stopCode`). */
  writesCode?(): boolean;
  /**
   * A worker sent the region picked at its stop, with its ARIA snapshot, for the code it makes; or why the region
   * brought none (`refused`).
   */
  onRegion?(stop: StopRef, region: { locator: string; snapshot: string } | { refused: string }): void;
  /**
   * Whether the run of `ref` was started to be watched: the service built its command with the editor's breakpoints,
   * or for a spec that calls `page.pause()` (both headed). A failure no bar shows is held in such a run.
   */
  watched?(ref: string): boolean;
  /**
   * Whether a person follows the runs in Piwi Picker now (a Runs window open, its hub connection saying so): a failure
   * no bar shows is held while one does.
   */
  followed?(): boolean;
  /**
   * A session starts: the first worker of a run connected, the run's command being one the service built or one it did
   * not, or a run of a ref whose command ended before (`again`: a rerun of that command, its environment and ref as
   * they were, whose code is the files as they stand now).
   */
  sessionStarted?(ref: string, again: boolean): void;
  /**
   * Why this host does not start an intent at any stop, whatever the worker takes (the desktop app's server, which no
   * editor records into nor checks with); null for one it starts. Such an intent is refused, and left out of
   * `intentsOf`.
   */
  declines?(what: RunIntent): string | null;
  /** What the sentences call the host the workers connect to: `the editor` by default. */
  host?: string;
  /** What the sentences call the surfaces of this host that show where a run stops: `this editor` by default. */
  surfaces?: string;
  /**
   * What a worker of the run `ref` said, for an agent following the runs, with the run's folder as `piwi/status` names
   * it (`root`); `worker` is null for the run's end.
   */
  heard?(ref: string, worker: number | null, what: RunHeard, root: string | null): void;
  paceMs?: number;
  burstMs?: number;
  lingerMs?: number;
  requestMs?: number;
}

interface Worker {
  socket: net.Socket;
  index: number;
  parallelIndex: number;
  /** The run's working directory, which the worker's places are relative to. */
  cwd: string;
  test: RunTest | null;
  /** Where it stands stopped, and the worker's number for that stop and its place. */
  stop: { id: number; place: Place; view: RunStop } | null;
  pausing: boolean;
  /** What its reporter takes at a stop, and its version. */
  takes: Set<RunTake>;
  reporter: string;
  /** The requests waiting for the worker's answer, by what they ask. */
  requests: Map<number, { what: 'image' | RunTake; settle(value: Answered): void }>;
  /** An agent asked the worker to stop (Pause, Step, Run to), and it has not stopped since, nor anyone asked otherwise. */
  askedBy: 'agent' | null;
  /**
   * The live view of its stop while viewers watch it: the stop, its viewers, the worker's answer to starting it, and
   * whether it started. Null when nobody watches, and as the stop ends.
   */
  view: { stop: number; viewers: Set<Viewer>; started: Promise<IntentAnswer>; on: boolean } | null;
}

interface Session {
  ref: string;
  root: string | null;
  workers: Map<number, Worker>;
  ended: boolean;
  /** What the client last heard of it, as sent and as text, and when; null before it heard anything. */
  heard: RunSession | null;
  sent: string;
  sentAt: number;
  /** The notification on its way, and when it goes. */
  paced: ReturnType<typeof setTimeout> | null;
  pacedAt: number;
  linger: ReturnType<typeof setTimeout> | null;
  /** The time of its latest stop, in milliseconds: each stop's is later. */
  stoppedAt: number;
  /** The client heard that a stop of this run was resumed for it. */
  resumedSaid: boolean;
}

/** What a request asks a worker: an image, or what it takes but the click counts its input carries and its events. */
type Asked = 'image' | Exclude<RunTake, 'input-clicks' | 'events'>;

/** The request asking a worker `what`, at the stop `stop` but for an image. */
function requestOf(request: number, what: Asked, stop: number, extra: RequestExtra): HubToRun {
  switch (what) {
    case 'image':
      return { type: 'request', request, what };
    case 'mock':
      return { type: 'request', request, what, stop, id: extra.id ?? 0 };
    case 'locator':
      return { type: 'request', request, what, stop, locator: extra.locator ?? null };
    case 'view':
      return { type: 'request', request, what, stop, on: extra.on ?? false };
    case 'input':
      return { type: 'request', request, what, stop, events: extra.events ?? [] };
    case 'pick-at':
      return { type: 'request', request, what, stop, x: extra.x ?? 0, y: extra.y ?? 0 };
    case 'snapshot':
      return { type: 'request', request, what, stop, depth: extra.depth ?? null, image: extra.image ?? false };
    case 'act':
      return {
        type: 'request',
        request,
        what,
        stop,
        ref: extra.ref ?? '',
        action: extra.action ?? 'click',
        value: extra.value ?? null,
      };
    case 'ref-locator':
      return { type: 'request', request, what, stop, ref: extra.ref ?? '' };
    case 'bind':
      return { type: 'request', request, what, stop, on: extra.on ?? false };
    default:
      return { type: 'request', request, what, stop };
  }
}

/** What a request carries beside the stop it names. */
interface RequestExtra {
  id?: number;
  locator?: string | null;
  on?: boolean;
  events?: ViewInput[];
  x?: number;
  y?: number;
  depth?: number | null;
  image?: boolean;
  ref?: string;
  action?: RunActAction;
  value?: string | null;
}

function uriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

export class RunSessions {
  private readonly sessions = new Map<string, Session>();
  /** The breakpoints a client sent for each run, as files and 0-based lines, newest last. */
  private readonly breakpoints = new Map<string, Array<{ file: string; line: number }>>();
  /** The refs whose command ended (`commandEnded`), the latest 50: a session of one is a rerun's. */
  private readonly endedCommands = new Set<string>();
  /** The runs an agent follows (`followRun`), whose workers tell what their tests do, the latest 50. */
  private readonly followedRuns = new Set<string>();
  private lastRequest = 0;

  constructor(private readonly options: RunSessionsOptions) {}

  /** What the sentences call the host the workers connect to. */
  private get host(): string {
    return this.options.host ?? 'the editor';
  }

  /**
   * A worker connected with `attach`: it joins its run's session, a new one when none runs, hears which of the stops it
   * holds only then the service shows (`attached`, to a worker that lists them: a failure's) and the breakpoints sent
   * for the run since it started. Returns where its next lines go. A connection naming the index of a worker
   * connected now is closed: another process the run's environment reached (a test running Playwright itself) takes
   * no worker's place. The workers of a command that ended are let go with its session (`commandEnded`), so those of
   * a rerun start a new one.
   */
  attach(socket: net.Socket, attach: RunAttach): (line: string) => void {
    let session = this.sessions.get(attach.ref);
    const holder = session?.workers.get(attach.workerIndex);
    if (holder && !holder.socket.destroyed) {
      socket.destroy();
      return () => {};
    }
    if (!session) {
      session = {
        ref: attach.ref,
        root: this.options.rootOf(attach.cwd),
        workers: new Map(),
        ended: false,
        heard: null,
        sent: '',
        sentAt: 0,
        paced: null,
        pacedAt: 0,
        linger: null,
        stoppedAt: 0,
        resumedSaid: false,
      };
      this.sessions.set(attach.ref, session);
      this.options.sessionStarted?.(attach.ref, this.endedCommands.delete(attach.ref));
    }
    if (session.linger) clearTimeout(session.linger);
    session.linger = null;
    const worker: Worker = {
      socket,
      index: attach.workerIndex,
      parallelIndex: attach.parallelIndex,
      cwd: attach.cwd,
      test: null,
      stop: null,
      pausing: false,
      takes: new Set(attach.takes),
      reporter: attach.reporter,
      requests: new Map(),
      view: null,
      askedBy: null,
    };
    session.workers.set(worker.index, worker);
    // A worker of that index whose connection closed, before its close was heard.
    if (holder) this.closeWorker(holder);
    const own = session;
    socket.on('close', () => this.detach(own, worker));
    if (attach.holds)
      this.send(worker, { type: 'attached', holds: SHOWN_HOLDS.filter((h) => attach.holds!.includes(h)) });
    const breakpoints = this.breakpoints.get(attach.ref);
    if (breakpoints) this.sendBreakpoints(worker, breakpoints, session.root);
    if (this.followedRuns.has(attach.ref) && worker.takes.has('events'))
      this.send(worker, { type: 'events', on: true });
    this.changed(session);
    this.options.heard?.(attach.ref, worker.index, { type: 'joined' }, session.root);
    return (line) => this.read(own, worker, line);
  }

  /**
   * An agent follows the run `ref`: its workers tell what their tests do from now on (`events`), a worker that connects
   * later too, those of a reporter that takes it.
   */
  followRun(ref: string): void {
    if (this.followedRuns.has(ref)) return;
    this.followedRuns.add(ref);
    for (const oldest of this.followedRuns) {
      if (this.followedRuns.size <= MAX_KEPT_RUNS) break;
      this.followedRuns.delete(oldest);
    }
    for (const worker of this.sessions.get(ref)?.workers.values() ?? []) {
      if (worker.takes.has('events')) this.send(worker, { type: 'events', on: true });
    }
  }

  /**
   * `piwi/runControl`: what the worker was asked, or why nothing was. `by` names an agent that asked (the service's MCP
   * server): the stop a Pause, a Step or a Run to it asked for is said to be its own.
   */
  control(params: RunControlParams, by: 'agent' | null = null): RunControlResult {
    const refuse = (message: string): RunControlResult => ({ ok: false, message });
    const session = typeof params?.ref === 'string' ? this.sessions.get(params.ref) : undefined;
    if (!session?.workers.size) return refuse(`No worker of this run is connected to ${this.host}.`);
    const named = typeof params.worker === 'number' ? (session.workers.get(params.worker) ?? null) : null;
    if (typeof params.worker === 'number' && !named) {
      return refuse(`Worker ${params.worker} of this run is not connected to ${this.host}.`);
    }
    const workers = named ? [named] : [...session.workers.values()];
    switch (params.action) {
      case 'pause': {
        const asked = workers.filter((w) => !w.stop && !w.test?.cannotPause);
        if (!asked.length) {
          if (workers.some((w) => w.stop)) return refuse('The test is stopped already.');
          const why = workers.find((w) => w.test?.cannotPause)?.test?.cannotPause;
          return refuse(`The test does not stop${why ? `: ${why}` : ''}.`);
        }
        for (const worker of asked) {
          this.send(worker, { type: 'control', action: 'pause' });
          worker.pausing = true;
          worker.askedBy = by;
        }
        this.changed(session, true);
        return {
          ok: true,
          message:
            asked.length > 1 ? `Pausing ${asked.length} workers at their next call.` : 'Pausing at the next call.',
        };
      }
      case 'step':
      case 'resume':
      case 'finish':
      case 'run-to': {
        const worker = this.stoppedWorker(workers, named, params.since);
        if ('message' in worker) return worker;
        const stop = worker.stop!.id;
        if (params.action === 'run-to') {
          const file = typeof params.place?.uri === 'string' ? uriToPath(params.place.uri) : null;
          const line = params.place?.line;
          if (!file || typeof line !== 'number' || !Number.isInteger(line) || line < 0) {
            return refuse('Run to needs a line of a file.');
          }
          const relative = this.relative(worker, file, session.root);
          if (!relative) return refuse(`${path.basename(file)} is outside the folder the run runs in.`);
          this.send(worker, { type: 'run-to', stop, place: { file: relative, line: line + 1 } });
          worker.askedBy = by;
          return { ok: true, message: `Running to ${path.basename(file)}:${line + 1}.` };
        }
        this.send(worker, { type: 'control', action: params.action, stop });
        worker.askedBy = params.action === 'step' ? by : null;
        return {
          ok: true,
          message:
            params.action === 'step'
              ? 'Stepping to the next call.'
              : params.action === 'resume'
                ? 'Resuming.'
                : 'Finishing the test without stopping at a breakpoint.',
        };
      }
      default:
        return refuse(`Piwi does not know the action ${JSON.stringify(params.action)}.`);
    }
  }

  /**
   * The worker whose stop a control answers: the one stopped among `workers`, at the stop `since` names when it names
   * one (a control naming the stop it answers reaches no worker past it); why there is none otherwise.
   */
  private stoppedWorker(workers: Worker[], named: Worker | null, since: unknown): Worker | RunControlResult {
    const refuse = (message: string): RunControlResult => ({ ok: false, message });
    const at = typeof since === 'string' ? since : null;
    const stopped = workers.filter((w) => w.stop && (at === null || w.stop.view.since === at));
    if (at !== null && !stopped.length) return refuse('The test went on.');
    if (!stopped.length) {
      if (named) return refuse(named.test ? 'The test is running.' : 'The worker runs no test now.');
      return refuse(workers.some((w) => w.test) ? 'The test is running.' : 'No test runs now.');
    }
    if (stopped.length > 1) return refuse(`${stopped.length} workers are stopped: choose one.`);
    return stopped[0]!;
  }

  /**
   * The worker stopped at the stop a client names: the run's one stopped worker or `worker`, at the stop `since` names
   * when it names one; why there is none otherwise.
   */
  private stopped(params: StopParams): { session: Session; worker: Worker } | RunControlResult {
    const refuse = (message: string): RunControlResult => ({ ok: false, message });
    const session = typeof params?.ref === 'string' ? this.sessions.get(params.ref) : undefined;
    if (!session?.workers.size) return refuse(`No worker of this run is connected to ${this.host}.`);
    const named = typeof params.worker === 'number' ? (session.workers.get(params.worker) ?? null) : null;
    if (typeof params.worker === 'number' && !named) {
      return refuse(`Worker ${params.worker} of this run is not connected to ${this.host}.`);
    }
    const since = typeof params.since === 'string' && params.since ? params.since : null;
    const worker = this.stoppedWorker(named ? [named] : [...session.workers.values()], named, since);
    return 'message' in worker ? worker : { session, worker };
  }

  /**
   * At the stop `since` names (of the run's one stopped worker, or the one named), start an intent in the test's
   * window: the pause bar's Pick a locator or Record here as its button does, the check panel's Check an element
   * (`assert`) or the picker for a region (`assert-region`). At a stop no bar shows, only for a viewer of its live
   * view, which drives it there. Refused without the stop, at a stop no bar shows for anyone else, for a reporter that
   * does not take it, and, for `assert` and `assert-region`, when the client writes no code. Answers once the worker
   * said whether it started, or after `PAUSED_PAGE_WAIT_MS`.
   */
  intent(params: IntentParams): Promise<RunControlResult> {
    const refuse = (message: string): Promise<RunControlResult> => Promise.resolve({ ok: false, message });
    if (typeof params?.since !== 'string' || !params.since) return refuse('The command needs the stop it answers.');
    const name = RUN_INTENT_NAMES[params.what];
    if (!name) return refuse(`Piwi does not know the intent ${JSON.stringify(params.what)}.`);
    const declined = this.options.declines?.(params.what);
    if (declined) return refuse(declined);
    const at = this.stopped(params);
    if ('message' in at) return Promise.resolve(at);
    const { worker } = at;
    if ((params.what === 'assert' || params.what === 'assert-region') && !this.options.writesCode?.()) {
      return refuse(NO_CODE);
    }
    if (!worker.stop!.view.bar && !this.watching(worker, params.viewer ?? null)) {
      return refuse(`${name} needs the pause bar in the test's window, and this test runs headless: run it headed.`);
    }
    if (!worker.takes.has(params.what)) {
      return refuse(
        `@piwitests/reporter ${worker.reporter || ''}`.trimEnd() +
          ` cannot start ${name} from outside the test's window: update it.`,
      );
    }
    return this.ask(worker, params.what, worker.stop!.id).then(
      (answer) => (answer as IntentAnswer | null) ?? { ok: false, message: 'The test did not answer.' },
    );
  }

  /** Whether `viewer` watches the live view of the stop its worker stands at. */
  private watching(worker: Worker, viewer: Viewer | null): boolean {
    return !!viewer && !!worker.stop && worker.view?.stop === worker.stop.id && worker.view.viewers.has(viewer);
  }

  /** Whether `viewer` watches the live view of the stop `since` names, of the run's worker `workerIndex`. */
  viewing(viewer: Viewer, ref: string, workerIndex: number, since: string): boolean {
    const worker = this.sessions.get(ref)?.workers.get(workerIndex);
    return !!worker && worker.stop?.view.since === since && this.watching(worker, viewer);
  }

  /**
   * Start or stop watching the live view of the stop a viewer names: the worker starts it as the first viewer of the
   * stop comes and stops it as the last one goes, and its frames go to that stop's viewers alone until then or until
   * the stop ends; a viewer that comes once it is on is sent its latest frame again. Answers once the worker said
   * whether it started.
   */
  async watch(params: ViewParams, viewer: Viewer): Promise<RunControlResult> {
    if (typeof params?.since !== 'string' || !params.since) {
      return { ok: false, message: 'The command needs the stop it answers.' };
    }
    const at = this.stopped(params);
    // A stop that ended took its view with it.
    if ('message' in at) return params.on ? at : { ok: true, message: 'You no longer watch the page.' };
    const { worker } = at;
    if (!params.on) {
      this.unwatch(worker, viewer);
      return { ok: true, message: 'You no longer watch the page.' };
    }
    const refused = this.refusesQuery(worker, 'view');
    if (refused) return { ok: false, message: refused };
    const stop = worker.stop!.id;
    let view = worker.view;
    if (view?.stop !== stop) {
      const started = this.ask(worker, 'view', stop, { on: true }).then(
        (answer) => (answer as IntentAnswer | null) ?? { ok: false, message: 'The test did not answer.' },
      );
      view = { stop, viewers: new Set(), started, on: false };
      const own = view;
      worker.view = own;
      void started.then((answer) => {
        own.on = answer.ok;
        if (!answer.ok && worker.view === own) worker.view = null;
      });
    } else if (view.on && !view.viewers.has(viewer)) {
      // A viewer that comes to a view on: the worker sends the frame it sent last again, which a still page repaints
      // no other of.
      void this.ask(worker, 'view', stop, { on: true });
    }
    view.viewers.add(viewer);
    const answer = await view.started;
    if (!answer.ok) {
      view.viewers.delete(viewer);
      return { ok: false, message: answer.message };
    }
    if (worker.view === view) return { ok: true, message: answer.message };
    // The stop ended meanwhile, or the viewer left it, the last one.
    return { ok: false, message: worker.stop?.id === stop ? 'You no longer watch the page.' : 'The test went on.' };
  }

  /** A viewer stops watching a worker's stop: the last one to go has the worker stop the view. */
  private unwatch(worker: Worker, viewer: Viewer): void {
    const view = worker.view;
    if (!view?.viewers.delete(viewer) || view.viewers.size) return;
    worker.view = null;
    void this.ask(worker, 'view', view.stop, { on: false });
  }

  /** A viewer left (its connection closed): it watches nothing any more. */
  unwatchAll(viewer: Viewer): void {
    for (const session of this.sessions.values()) {
      for (const worker of session.workers.values()) this.unwatch(worker, viewer);
    }
  }

  /**
   * Play a viewer's input on the page of the stop it names, which it watches: refused for a viewer that does not watch
   * it and for a reporter that does not take it. Answers once the worker played it, or why not.
   */
  async input(params: StopParams & { since: string }, viewer: Viewer, events: ViewInput[]): Promise<RunControlResult> {
    const at = this.stopped(params);
    if ('message' in at) return at;
    const refused = this.refusesQuery(at.worker, 'input');
    if (refused) return { ok: false, message: refused };
    if (!this.watching(at.worker, viewer)) return { ok: false, message: NEEDS_VIEW };
    const answer = (await this.ask(at.worker, 'input', at.worker.stop!.id, { events })) as IntentAnswer | null;
    return answer ?? { ok: false, message: 'The test did not answer.' };
  }

  /**
   * `piwi/pickAt`, and the hub's `pick-at`: the element under the point `x`, `y` (CSS pixels of the stopped page's
   * viewport) of the stop a client names, its locator sent where a pick goes; why there is none otherwise.
   */
  async pickAt(params: PickAtParams): Promise<PickAtResult> {
    const refuse = (message: string): PickAtResult => ({ ok: false, message, locator: null });
    if (typeof params?.since !== 'string' || !params.since) return refuse('The command needs the stop it answers.');
    const { x, y } = params;
    if (!isViewPoint(x, y)) return refuse('Pick on the image needs the point, in CSS pixels of the page.');
    const at = this.stopped(params);
    if ('message' in at) return refuse(at.message);
    const refused = this.refusesQuery(at.worker, 'pick-at');
    if (refused) return refuse(refused);
    const answer = (await this.ask(at.worker, 'pick-at', at.worker.stop!.id, { x, y })) as PickAtAnswer | null;
    return answer ?? refuse('The test did not answer.');
  }

  /**
   * For an agent: the ARIA snapshot in AI mode of the page of the stop a client names, `depth` levels deep at most (the
   * whole tree for null), with its image when `image` is true; why there is none otherwise.
   */
  async snapshot(params: StopParams, depth: number | null, image: boolean): Promise<SnapshotAnswer> {
    const none = { url: '', title: '', snapshot: null, cut: false, image: null };
    const at = this.stopped(params);
    if ('message' in at) return { ...at, ...none };
    const refused = this.refusesQuery(at.worker, 'snapshot');
    if (refused) return { ok: false, message: refused, ...none };
    const answer = (await this.ask(at.worker, 'snapshot', at.worker.stop!.id, {
      depth,
      image,
    })) as SnapshotAnswer | null;
    return answer ?? { ok: false, message: 'The test did not answer.', ...none };
  }

  /** For an agent: the element `ref` names on the page of the stop a client names, and its locators ranked. */
  async refLocator(params: StopParams, ref: string): Promise<RefLocatorAnswer> {
    return this.refQuery(params, 'ref-locator', { ref });
  }

  /**
   * For an agent: act on the element `ref` names on the page of the stop `since` names, as trusted input, the element
   * as it stood before in the answer; refused without the stop.
   */
  async act(
    params: StopParams & { since: string },
    act: { ref: string; action: RunActAction; value: string | null },
  ): Promise<RefLocatorAnswer> {
    if (typeof params?.since !== 'string' || !params.since) {
      return { ok: false, message: 'The command needs the stop it answers.', element: null, locators: [] };
    }
    return this.refQuery(params, 'act', act);
  }

  private async refQuery(
    params: StopParams,
    what: 'ref-locator' | 'act',
    extra: RequestExtra,
  ): Promise<RefLocatorAnswer> {
    const at = this.stopped(params);
    if ('message' in at) return { ...at, element: null, locators: [] };
    const refused = this.refusesQuery(at.worker, what);
    if (refused) return { ok: false, message: refused, element: null, locators: [] };
    const answer = (await this.ask(at.worker, what, at.worker.stop!.id, extra)) as RefLocatorAnswer | null;
    return answer ?? { ok: false, message: 'The test did not answer.', element: null, locators: [] };
  }

  /**
   * `piwi/stopBind`: at the stop `since` names, share its worker's browser with Playwright's own tools until the test
   * ends (`on`), or stop sharing it; refused without the stop.
   */
  async bind(params: StopParams & { since: string }, on: boolean): Promise<BindAnswer> {
    const refuse = (message: string): BindAnswer => ({ ok: false, message, name: null, endpoint: null });
    if (typeof params?.since !== 'string' || !params.since) return refuse('The command needs the stop it answers.');
    const at = this.stopped(params);
    if ('message' in at) return refuse(at.message);
    const refused = this.refusesQuery(at.worker, 'bind');
    if (refused) return refuse(refused);
    const answer = (await this.ask(at.worker, 'bind', at.worker.stop!.id, { on })) as BindAnswer | null;
    return answer ?? refuse('The test did not answer.');
  }

  /** Why the worker at a stop is not asked `what`; null when it takes it. */
  private refusesQuery(worker: Worker, what: Query): string | null {
    return worker.takes.has(what)
      ? null
      : `@piwitests/reporter ${worker.reporter || ''}`.trimEnd() + ` cannot ${QUERY_WORDS[what]}: update it.`;
  }

  /** The responses the test kept as it stood at the stop a client names, oldest first, without their bodies. */
  async requests(params: StopParams): Promise<RequestsAnswer> {
    const at = this.stopped(params);
    if ('message' in at) return { ...at, requests: [] };
    const refused = this.refusesQuery(at.worker, 'requests');
    if (refused) return { ok: false, message: refused, requests: [] };
    const answer = (await this.ask(at.worker, 'requests', at.worker.stop!.id)) as RequestsAnswer | null;
    return answer ?? { ok: false, message: 'The test did not answer.', requests: [] };
  }

  /** The kept response `id` at the stop a client names, with its body, and that stop; why not otherwise. */
  async mock(params: StopParams, id: number): Promise<{ stop: StopRef; answer: MockAnswer } | RunControlResult> {
    const at = this.stopped(params);
    if ('message' in at) return at;
    const refused = this.refusesQuery(at.worker, 'mock');
    if (refused) return { ok: false, message: refused };
    const stop = this.refOf(at.session, at.worker);
    const answer = (await this.ask(at.worker, 'mock', stop.stop, { id })) as MockAnswer | null;
    return answer ? { stop, answer } : { ok: false, message: 'The test did not answer.' };
  }

  /**
   * How many elements `locator` matches on the page of the stop a client names, outlined there where the bar shows;
   * null takes the outline down.
   */
  async locator(params: StopParams, locator: string | null): Promise<LocatorAnswer> {
    const at = this.stopped(params);
    if ('message' in at) return { ...at, count: null };
    const refused = this.refusesQuery(at.worker, 'locator');
    if (refused) return { ok: false, message: refused, count: null };
    const answer = (await this.ask(at.worker, 'locator', at.worker.stop!.id, { locator })) as LocatorAnswer | null;
    return answer ?? { ok: false, message: 'The test did not answer.', count: null };
  }

  /** The stop a client names (`StopParams`), while its worker stands at it; why there is none otherwise. */
  stopOf(params: StopParams): StopRef | RunControlResult {
    const at = this.stopped(params);
    return 'message' in at ? at : this.refOf(at.session, at.worker);
  }

  /** The stop `stop` of a run's worker, while the worker stands at it; null otherwise. */
  stopAt(ref: string, workerIndex: number, stop: number): StopRef | null {
    const session = this.sessions.get(ref);
    const worker = session?.workers.get(workerIndex);
    return session && worker?.stop?.id === stop ? this.refOf(session, worker) : null;
  }

  private refOf(session: Session, worker: Worker): StopRef {
    const { id, view } = worker.stop!;
    return {
      ref: session.ref,
      worker: worker.index,
      stop: id,
      since: view.since,
      reason: view.reason,
      uri: view.uri,
      line: view.line,
      character: view.character,
      root: session.root,
    };
  }

  /**
   * What a run's worker takes from Piwi Picker: the intents, and `mock` when it lists and hands over responses; the
   * actions that write code (`assert`, `assert-region`, `mock`) only while the client writes it.
   */
  intentsOf(ref: string, worker: number): HubAction[] {
    const found = this.sessions.get(ref)?.workers.get(worker);
    if (!found) return [];
    const code = !!this.options.writesCode?.();
    const intents: HubAction[] = (['pick', 'record', 'assert', 'assert-region'] as const).filter(
      (what) =>
        found.takes.has(what) &&
        (code || (what !== 'assert' && what !== 'assert-region')) &&
        !this.options.declines?.(what),
    );
    if (code && found.takes.has('requests') && found.takes.has('mock')) intents.push('mock');
    return [
      ...intents,
      ...(['view', 'input', 'input-clicks', 'pick-at'] as const).filter((what) => found.takes.has(what)),
    ];
  }

  /**
   * What the stop of a run's worker takes from `viewer` now, of `intentsOf`: the input (and the click counts it carries,
   * `input-clicks`) only while `viewer` watches its live view, and, at a stop no pause bar shows, the actions in the
   * test's window (Pick, Record, Assert, Assert a region) only then too, driven through that view.
   */
  stopIntentsOf(ref: string, worker: number, viewer: Viewer | null): HubAction[] {
    const found = this.sessions.get(ref)?.workers.get(worker);
    if (!found?.stop) return [];
    const watching = this.watching(found, viewer);
    const inWindow = found.stop.view.bar || watching;
    return this.intentsOf(ref, worker).filter((what) =>
      what === 'input' || what === 'input-clicks'
        ? watching
        : what === 'mock' || what === 'view' || what === 'pick-at' || inWindow,
    );
  }

  /**
   * The runs live now, as the client last heard them: a change it has not heard yet goes to everyone who follows the
   * runs together, in the notification that brings it. A run the client heard nothing of yet is left out until then.
   */
  current(): RunSession[] {
    return [...this.sessions.values()].flatMap((session) => (session.heard ? [session.heard] : []));
  }

  /**
   * The surfaces that answer stops changed: when none is left, every stop no pause bar shows goes on, as it would
   * have at once.
   */
  surfacesChanged(): void {
    const answered = this.options.answersStops();
    for (const session of this.sessions.values()) {
      for (const worker of session.workers.values()) {
        if (!worker.stop || worker.stop.view.bar) continue;
        if (!answered || this.unwatchedFailure(session, worker)) {
          this.resumeUnanswered(session, worker, worker.stop.place);
        }
      }
    }
  }

  /**
   * Whether a worker stands at a failure nobody watches: no bar shows it, its run was not started to be watched, and
   * no Runs window follows the runs. It goes on at once.
   */
  private unwatchedFailure(session: Session, worker: Worker): boolean {
    return worker.stop?.view.reason === 'failure' && !this.watches(session);
  }

  /** Whether someone watches the run's failures: it was started to be watched, or a Runs window follows the runs. */
  private watches(session: Session): boolean {
    return !!this.options.watched?.(session.ref) || !!this.options.followed?.();
  }

  /** `piwi/setRunBreakpoints`: the run's workers stop at these lines from now on, a worker that starts later too. */
  setBreakpoints(params: SetRunBreakpointsParams): void {
    if (typeof params?.ref !== 'string' || !Array.isArray(params.places)) return;
    const files = params.places.flatMap((place) => {
      const file = typeof place?.uri === 'string' ? uriToPath(place.uri) : null;
      return file && Number.isInteger(place.line) && place.line >= 0 ? [{ file, line: place.line }] : [];
    });
    this.breakpoints.delete(params.ref);
    this.breakpoints.set(params.ref, files);
    for (const oldest of this.breakpoints.keys()) {
      if (this.breakpoints.size <= MAX_KEPT_RUNS) break;
      this.breakpoints.delete(oldest);
    }
    const session = this.sessions.get(params.ref);
    for (const worker of session?.workers.values() ?? []) this.sendBreakpoints(worker, files, session!.root);
  }

  /** `piwi/pausedPage`: an image of a stopped worker's page, null when there is none. */
  pausedPage(params: PausedPageParams): Promise<PausedPageResult> {
    const worker = typeof params?.ref === 'string' ? this.sessions.get(params.ref)?.workers.get(params.worker) : null;
    if (!worker?.stop || params.what !== 'image') return Promise.resolve({ image: null });
    return this.ask(worker, 'image').then((image) => ({ image: image as PausedImage | null }));
  }

  /** Ask a worker, and settle with its answer, or null after `PAUSED_PAGE_WAIT_MS` or when it leaves. */
  private ask(worker: Worker, what: Asked, stop?: number, extra: RequestExtra = {}): Promise<Answered> {
    const request = ++this.lastRequest;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        worker.requests.delete(request);
        resolve(null);
      }, this.options.requestMs ?? PAUSED_PAGE_WAIT_MS);
      timer.unref?.();
      worker.requests.set(request, {
        what,
        settle: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      this.send(worker, requestOf(request, what, stop ?? 0, extra));
    });
  }

  /**
   * The client said the command of `ref` ended: its run ended with it. The connections of its workers, whose process
   * is ending, are closed, which lets a stop no pause bar shows go on at once.
   */
  commandEnded(ref: string): void {
    this.endedCommands.delete(ref);
    this.endedCommands.add(ref);
    for (const oldest of this.endedCommands) {
      if (this.endedCommands.size <= MAX_KEPT_RUNS) break;
      this.endedCommands.delete(oldest);
    }
    const session = this.sessions.get(ref);
    if (session) this.end(session);
  }

  /** The service stops: every worker's connection closes, which lets a stop no pause bar shows go on. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.paced) clearTimeout(session.paced);
      if (session.linger) clearTimeout(session.linger);
      for (const worker of session.workers.values()) this.closeWorker(worker);
    }
    this.sessions.clear();
  }

  private read(session: Session, worker: Worker, line: string): void {
    if (session.workers.get(worker.index) !== worker) return;
    const message = parseRunToHub(line);
    if (!message) return;
    switch (message.type) {
      case 'test-begin':
        worker.test = {
          id: message.testId,
          title: message.title,
          uri: this.uri(worker, message.file, session.root),
          line: message.line - 1,
          project: message.project,
          retry: message.retry,
          cannotPause: message.cannotPause,
        };
        worker.stop = null;
        worker.view = null;
        if (message.cannotPause) worker.pausing = false;
        this.options.heard?.(session.ref, worker.index, { type: 'test-begin', test: worker.test }, session.root);
        return this.changed(session);
      case 'stopped':
        // A failure nobody watches goes on at once, unseen: no client hears of it.
        if (message.reason === 'failure' && !message.bar && (!this.options.answersStops() || !this.watches(session))) {
          return this.send(worker, { type: 'control', action: 'resume', stop: message.stop });
        }
        worker.view = null;
        worker.stop = {
          id: message.stop,
          place: message.place,
          view: {
            reason: message.reason,
            title: message.title,
            uri: this.uri(worker, message.place.file, session.root),
            line: message.place.line - 1,
            character: message.place.column ? message.place.column - 1 : null,
            locator: message.locator,
            bar: message.bar,
            since: this.stamp(session),
            ...(message.error === undefined ? {} : { error: message.error }),
            ...(worker.askedBy ? { by: worker.askedBy } : {}),
          },
        };
        worker.pausing = false;
        worker.askedBy = null;
        this.changed(session, true);
        this.options.heard?.(session.ref, worker.index, { type: 'stopped', stop: worker.stop.view }, session.root);
        if (!message.bar && !this.options.answersStops()) this.resumeUnanswered(session, worker, message.place);
        return;
      case 'running': {
        if (worker.stop?.id !== message.stop) return;
        const since = worker.stop.view.since;
        worker.stop = null;
        worker.view = null;
        this.changed(session, true);
        return this.options.heard?.(session.ref, worker.index, { type: 'running', since }, session.root);
      }
      case 'test-end':
        if (worker.test?.id === message.testId) worker.test = null;
        worker.stop = null;
        worker.view = null;
        worker.askedBy = null;
        this.changed(session);
        return this.options.heard?.(
          session.ref,
          worker.index,
          { type: 'test-end', status: message.status, pausedMs: message.pausedMs },
          session.root,
        );
      case 'event':
        return this.options.heard?.(session.ref, worker.index, { type: 'event', event: message.event }, session.root);
      case 'frame': {
        // A frame of the stop the worker stands at, for its viewers alone, or why none comes.
        const view = worker.view;
        if (!view || !worker.stop || worker.stop.id !== message.stop || view.stop !== message.stop) return;
        const at = { ref: session.ref, worker: worker.index, since: worker.stop.view.since };
        const frame: ViewFrame =
          'refused' in message
            ? { ...at, refused: message.refused }
            : { ...at, width: message.width, height: message.height, data: message.data };
        for (const viewer of view.viewers) viewer.frame(frame);
        return;
      }
      case 'answer': {
        const asked = worker.requests.get(message.request);
        if (asked?.what !== message.what) return;
        worker.requests.delete(message.request);
        return asked.settle(message.value);
      }
      case 'region': {
        const region = 'refused' in message ? { refused: message.refused } : message;
        if (worker.stop?.id === message.stop) return this.options.onRegion?.(this.refOf(session, worker), region);
        // The stop ended: a snapshot has nowhere to go, a refusal still says why.
        if ('refused' in region) this.options.notice(session.root ?? worker.cwd, 'warning', region.refused);
        return;
      }
      case 'notice':
        return this.options.notice(session.root ?? worker.cwd, 'warning', message.message);
    }
  }

  /**
   * A stop no one can answer: no pause bar shows it, the client shows no stop, and no Piwi Picker hears the runs. It
   * goes on, said once a run.
   */
  private resumeUnanswered(session: Session, worker: Worker, place: Place): void {
    this.send(worker, { type: 'control', action: 'resume', stop: worker.stop!.id });
    // A failure held for a surface that is not there ends as it would have: nothing to say.
    if (session.resumedSaid || worker.stop!.view.reason === 'failure') return;
    session.resumedSaid = true;
    this.options.notice(
      session.root ?? worker.cwd,
      'information',
      `Piwi resumed the test stopped at ${path.basename(place.file)}:${place.line}: no pause bar shows in a headless ` +
        `browser, and neither ${this.options.surfaces ?? 'this editor'} nor Piwi Picker shows where a run stops. Run ` +
        'it headed to pause there.',
    );
  }

  /** The time of a stop, ISO 8601, later than the run's stop before it, so it names this stop alone. */
  private stamp(session: Session): string {
    session.stoppedAt = Math.max(Date.now(), session.stoppedAt + 1);
    return new Date(session.stoppedAt).toISOString();
  }

  /**
   * A worker's connection closes, which lets a stop no pause bar shows go on, and its requests are answered with
   * nothing.
   */
  private closeWorker(worker: Worker): void {
    worker.view = null;
    worker.socket.destroy();
    for (const asked of worker.requests.values()) asked.settle(null);
    worker.requests.clear();
  }

  private detach(session: Session, worker: Worker): void {
    if (session.workers.get(worker.index) !== worker) return;
    session.workers.delete(worker.index);
    this.closeWorker(worker);
    if (session.ended) return;
    this.changed(session, true);
    this.options.heard?.(session.ref, worker.index, { type: 'left' }, session.root);
    if (session.workers.size) return;
    session.linger = setTimeout(() => this.end(session), this.options.lingerMs ?? SESSION_LINGER_MS);
    session.linger.unref?.();
  }

  /** The run ended: the client hears it last, and a later worker of its ref starts a new session. */
  private end(session: Session): void {
    if (session.ended) return;
    session.ended = true;
    if (session.linger) clearTimeout(session.linger);
    session.linger = null;
    const workers = [...session.workers.values()];
    session.workers.clear();
    for (const worker of workers) this.closeWorker(worker);
    if (this.sessions.get(session.ref) === session) this.sessions.delete(session.ref);
    this.flush(session);
    this.options.heard?.(session.ref, null, { type: 'ended' }, session.root);
  }

  /**
   * The client hears the session: for `now`, at once, or with the next burst when it heard it moments ago; else within
   * the pace.
   */
  private changed(session: Session, now = false): void {
    const at = now
      ? session.sentAt + (this.options.burstMs ?? SESSION_BURST_MS)
      : Date.now() + (this.options.paceMs ?? SESSION_PACE_MS);
    if (now && at <= Date.now()) return this.flush(session);
    if (session.paced && session.pacedAt <= at) return;
    if (session.paced) clearTimeout(session.paced);
    session.pacedAt = at;
    session.paced = setTimeout(() => this.flush(session), Math.max(0, at - Date.now()));
    session.paced.unref?.();
  }

  /** A session as the client hears it. */
  private view(session: Session): RunSession {
    return {
      ref: session.ref,
      root: session.root,
      workers: [...session.workers.values()]
        .sort((a, b) => a.index - b.index)
        .map((worker) => ({
          worker: worker.index,
          parallelIndex: worker.parallelIndex,
          state: worker.stop ? 'stopped' : worker.test ? 'running' : 'between',
          test: worker.test,
          stop: worker.stop?.view ?? null,
          pausing: worker.pausing,
          takes: [...worker.takes],
        })),
      ended: session.ended,
    };
  }

  private flush(session: Session): void {
    if (session.paced) clearTimeout(session.paced);
    session.paced = null;
    const view = this.view(session);
    const text = JSON.stringify(view);
    if (text === session.sent) return;
    session.heard = view;
    session.sent = text;
    session.sentAt = Date.now();
    this.options.notify(view);
  }

  private send(worker: Worker, message: HubToRun): void {
    if (!worker.socket.destroyed) worker.socket.write(`${JSON.stringify(message)}\n`);
  }

  private sendBreakpoints(worker: Worker, files: Array<{ file: string; line: number }>, root: string | null): void {
    const places = new Map<string, Place>();
    for (const { file, line } of files) {
      const relative = this.relative(worker, file, root);
      if (relative) places.set(`${relative}:${line}`, { file: relative, line: line + 1 });
    }
    this.send(worker, { type: 'breakpoints', places: [...places.values()] });
  }

  /**
   * A file of the client's, relative to the run's working directory, or to the workspace's spelling of its folder
   * (`root`: the run ran in the folder as the file system spells it); null outside it.
   */
  private relative(worker: Worker, file: string, root: string | null): string | null {
    return relativeTo(worker.cwd, file) ?? (root ? relativeTo(root, file) : null);
  }

  /** The URI of a worker's file, under the workspace's spelling of the run's folder when it is in it. */
  private uri(worker: Worker, file: string, root: string | null): string {
    const absolute = path.resolve(worker.cwd, file);
    const relative = root ? relativeTo(worker.cwd, absolute) : null;
    return pathToFileURL(relative ? path.join(root!, relative) : absolute).href;
  }
}
