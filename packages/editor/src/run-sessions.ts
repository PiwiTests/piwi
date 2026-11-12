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
 * picks the element under a point of an image of a stopped page (`pickAt`). A worker names places relative to the run's
 * working directory; the client, by their file's URI as the workspace names it: the session converts both ways. A stop
 * that shows no pause bar while no surface can answer stops (the client does not, and no Piwi Picker hears the runs) is
 * resumed at once, and so is one held when the last of them goes. A failure no pause bar shows is held only while its
 * run's **Hold failures** is on (`hold`: from its start in a run started to be watched, `watched`, with the editor's
 * breakpoints or a `page.pause()`; else as a person or an agent set it), and never in a run its host says holds none
 * (`holdsFailures`); otherwise its worker does not stop at it, and no client hears of it. A worker's connection that closes lets a stop no pause bar shows go on; a stop the bar shows
 * waits there for its answer. An agent (the service's MCP server, `run-agent.ts`) hears what each worker says
 * (`heard`), has a run's workers tell what their tests do (`followRun`), and, at a stop, reads the page's ARIA snapshot
 * (`snapshot`), acts on an element of it by its ref (`act`), ranks an element's locators (`refLocator`) and shares the
 * browser with Playwright's own tools (`bind`); a stop it asked for (Pause, Step, Run to) is said to be the agent's
 * (`RunStop.by`). Every surface can end the test at a stop (`end`, for a worker that takes it). A run started in a
 * terminal attaches as the editor's own do, under a ref the host never built (`terminal`): it starts with the editor's
 * breakpoints (`setEditorBreakpoints`), ends 5 s after its last worker left, and holds a failure only once its Hold
 * failures is turned on. A person shares a run live on the team instance its reporter reports to (`share`, **Share
 * live**, never an agent): each worker that takes it opens its live view stream there, a worker that connects later
 * too, and says how it stands (`live`), which the session sums up (`RunSession.live`). Any surface opens a lane's
 * running test's trace so far in Playwright's trace viewer on this machine (`openTrace`): its worker names the file to
 * the sessions alone, which check it and answer in a sentence; the host alone hears the checked file (`laneTrace`),
 * which the desktop app's server reads for its window's **Inspect**.
 */
import * as path from 'node:path';
import type * as net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RUN_INTENT_NAMES,
  parseRunMainToHub,
  parseRunToHub,
  type ActAnswer,
  type BindAnswer,
  type HubToMain,
  type HubToRun,
  isPageOfInstance,
  type IntentAnswer,
  type LocatorAnswer,
  type MockAnswer,
  type PickAtAnswer,
  type Place,
  type RefLocatorAnswer,
  type RequestsAnswer,
  type RunActAction,
  type RunEvent,
  type RunFeature,
  type RunHold,
  type RunMainToHub,
  type RunIntent,
  type RunLiveState,
  type RunQuery,
  type RunTake,
  type RunToHub,
  type SnapshotAnswer,
  type TraceAnswer,
} from '@piwitests/core/run-channel';
import { parseLiveAskAnswer } from '@piwitests/core/live-view';
import { emptyLane, reduceLane, type Lane, type LaneEvent } from '@piwitests/core/live-lane';
import { LANE_LAYERS, LANE_TEXTS_PER_SECOND, type LaneLayer } from '@piwitests/core/live-layers';
import { isViewPoint, type ViewInput } from '@piwitests/core/run-view';
import type {
  HoldRunParams,
  PausedImage,
  PausedPageParams,
  PausedPageResult,
  PickAtParams,
  PickAtResult,
  RunControlParams,
  RunControlResult,
  RunHoldFailures,
  RunLive,
  RunPage,
  RunPresence,
  RunProgress,
  RunSession,
  RunStop,
  RunWaiting,
  RunTest,
  SetBreakpointsParams,
  SetRunBreakpointsParams,
  ShareRunParams,
  AskToWatchParams,
  AnswerAskParams,
  LaneViewLayer,
  OpenTraceParams,
} from './protocol.js';
import { MAX_HUB_PRESENCE, type HubAction } from '@piwitests/core/run-hub';
import { relativeTo } from './workspace.js';
import { breakpointLines, runToLine } from './recorder/page-candidates.js';
import { checkTraceFile, hasDisplay, type TraceViewerLauncher } from './trace-viewer.js';

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
/** The stops nobody asked for, which a run nobody attends lets go on: a breakpoint, a `page.pause()`, any other. */
const UNASKED_STOPS: ReadonlySet<string> = new Set(['breakpoint', 'page-pause', 'other']);
/** The stops the service shows and answers among those a worker holds only then (`attached`): a held failure. */
const SHOWN_HOLDS: readonly RunHold[] = ['failure'];

type RunAttach = Extract<RunToHub, { type: 'run-attach' }>;
type RunBegin = Extract<RunMainToHub, { type: 'run-begin' }>;

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
  | TraceAnswer
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
  /** A person took the stop the agent drove (`by`: the tool, as presence names it). */
  | { type: 'taken'; by: string }
  /** The person who drove the stop gave it back: an agent may act on it again. */
  | { type: 'given-back' }
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

/**
 * A frame of a lane a viewer watches (`watchLane`): the worker's page at the stop `since` names, null while the test it
 * shows (`test`, Playwright's id) runs; or why none comes.
 */
export type LaneViewFrame = { ref: string; lane: number; worker: number; since: string | null } & (
  | { test: string; width: number; height: number; data: string }
  | { test: string | null; refused: string }
);

/**
 * A layer of a lane a viewer watches and asked for (`LaneParams.layers`, `@piwitests/core/live-layers`), as the worker
 * sent it: the shape of `piwi/laneLayer`.
 */
export type { LaneViewLayer };

/**
 * Who watches the live view of a stop: each frame of it goes to `frame`, while it watches; the frames of a lane it
 * watches to `laneFrame`, which a viewer that watches no lane leaves out; and the layers of that lane it asked for to
 * `laneLayer`, which a viewer that asks for none leaves out.
 */
export interface Viewer {
  frame(frame: ViewFrame): void;
  laneFrame?(frame: LaneViewFrame): void;
  laneLayer?(layer: LaneViewLayer): void;
  /** The tool it is, as presence names it; a viewer without one is in no presence list and drives no stop. */
  who?: Omit<RunPresence, 'self'>;
}

/** The agent, as presence names it: on a run it follows, and as the driver of a stop it asked for or acted on. */
export const AGENT_VIEWER: Viewer = { frame: () => undefined, who: { kind: 'agent', name: 'an agent' } };

/** A worker's `watchers`, absent while none watches. */
function watchersField(watchers: RunPresence[]): { watchers?: RunPresence[] } {
  return watchers.length ? { watchers } : {};
}

/** The viewers that are someone, as one viewer (`self`) hears them: else as the editor's client hears them. */
function presenceList(viewers: Iterable<Viewer>, self: Viewer | null): RunPresence[] {
  const list = new Map<string, RunPresence>();
  for (const viewer of viewers) {
    if (!viewer.who || list.size >= MAX_HUB_PRESENCE) continue;
    const presence = presenceOf(viewer, self);
    // A tool's panels are one tool: its page view and its lane view of a worker are named once.
    list.set(`${presence.kind}\n${presence.name}\n${presence.self ?? ''}`, presence);
  }
  return [...list.values()];
}

/** A viewer as `self` hears it: marked `self` when it is that viewer, or, for the editor's client, when it is an editor. */
function presenceOf(viewer: Viewer, self: Viewer | null): RunPresence {
  const own = self ? viewer === self : viewer.who!.kind === 'editor';
  return { kind: viewer.who!.kind, name: viewer.who!.name, ...(own ? { self: true as const } : {}) };
}

/**
 * A lane as a viewer names it: the run, and Playwright's `parallelIndex`; and the layers it takes of the lane beside its
 * frames, none when left out.
 */
export interface LaneParams {
  ref: string;
  lane: number;
  on: boolean;
  layers?: readonly LaneLayer[];
}

/**
 * A lane's running attempt's trace, as its worker named it to the host and `checkTraceFile` passed it (`laneTrace`),
 * for the host to read itself: no surface hears it.
 */
export interface LaneTrace {
  ok: true;
  /** The run's folder, as the host knows it (`rootOf`). */
  root: string;
  /** The runner's trace folder of the lane's worker, as the file system spells it: the attempt's files are in it. */
  traces: string;
  /** The name the attempt's files start with: `<testId>[-retry<k>]` (`attemptName`). */
  base: string;
  /** The trace file the worker named, which passed the checks. */
  file: string;
  /** The lane's worker's index. */
  worker: number;
  /** The attempt: Playwright's id of its test, and its retry. */
  test: { id: string; retry: number };
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

/**
 * An answer to an agent's request at a stop: the worker's own (`answered`), whose words may quote the page (the first
 * line of Playwright's error for a page call that failed), or the service's refusal, whose words are its own.
 */
export type AgentAnswer<T> = T & { answered: boolean };

/** Why an agent's request the worker did not answer in time is refused. */
const NO_ANSWER_YET = 'The test did not answer.';
/** How long an action the page did not answer in time may still answer, once it was played. */
const LATE_ANSWER_MS = 60_000;
/** The most lanes of a run watched at once: a run's workers, and a few more Playwright may start. */
const MAX_WATCHED_LANES = 64;
/** How long after a worker was asked for its page's text another ask shares that one's answer. */
const LANE_TEXT_MS = 1000 / LANE_TEXTS_PER_SECOND;
/** The answer to an ask of the page's text the layers just made, which the worker takes as it hears them. */
const TEXT_ON_ITS_WAY: RunControlResult = { ok: true, message: 'The page’s text is on its way.' };

/** The service's refusal of an agent's request about an element, in its own words: no element, no locator. */
function noElement(message: string): AgentAnswer<RefLocatorAnswer> {
  return { ok: false, message, element: null, locators: [], answered: false };
}

/** Why an action that writes code is refused when the client writes none. */
export const NO_CODE = "The editor cannot write code from a stop: update Piwi's extension in the editor.";

/** What an agent asks of a stopped page: all three need the worker to take `agent`. */
type AgentQuery = 'snapshot' | 'act' | 'ref-locator';

/** What a query asks, as a refusal names it. */
type Query = RunQuery | 'view' | 'input' | 'pick-at' | AgentQuery | 'bind';

/** What a worker lists in `takes` to answer a query. */
function takeOf(query: Query): RunTake {
  return query === 'snapshot' || query === 'act' || query === 'ref-locator' ? 'agent' : query;
}

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

/** Why **Open the trace so far** is refused for a worker whose reporter does not say where its trace grows. */
const CANNOT_TRACE = "This worker's reporter cannot open its trace: update @piwitests/reporter.";

/** Why **Open the trace so far** is refused between two tests. */
const NO_TEST = 'No test runs on this worker now.';

/** Why **Open the trace so far** is refused on a machine that shows no window (`traceDisplay`). */
const NO_DISPLAY = "This machine has no display for Playwright's trace viewer.";

/** Why **Open the trace so far** is refused in a run whose folder the host does not know (`rootOf`). */
const NO_ROOT = "This run's folder is not known here: open its trace from the editor or the app that started it.";

/** `text` with its first letter in capitals. */
function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The longest reason a viewer that did not start gives a surface, in characters. */
const MAX_TRACE_REASON = 300;

/**
 * A viewer's reason with the trace's path and its folders left out, with either separator, then cut to
 * `MAX_TRACE_REASON`: the reason goes to every surface, the path to none, whole or in part. Its trailing period is left
 * out: the sentence ends it.
 */
function withoutPaths(reason: string, paths: readonly string[]): string {
  let said = reason;
  for (const known of paths.flatMap((p) => [p, p.split(path.sep).join('/')]).sort((a, b) => b.length - a.length)) {
    if (known) said = said.split(known).join("the test's trace");
  }
  return said.slice(0, MAX_TRACE_REASON).replace(/[.\s]+$/, '') || 'it did not say why';
}

/** Why the input of a viewer that does not watch the stop is refused. */
const NEEDS_VIEW = 'The input needs the live view of this stop: watch it first.';

/** Why End the test while a Pause waits finds no test waiting in a call. */
const NOT_WAITING = 'No test waits in a call for a Pause.';

/** Why a run none of whose workers said how it stands on the instance yet is not shared. */
const NOT_SAID = "The run's workers have not said yet whether it can be shared live: try again in a moment.";

/** The host of a run page's address, as a sentence names the instance; the address itself when it has none. */
function instanceOf(page: string): string {
  try {
    return new URL(page).host || page;
  } catch {
    return page;
  }
}

export interface RunSessionsOptions {
  /** A session changed, or ended: the client hears it. */
  notify(session: RunSession): void;
  /**
   * Who is present on the run changed though its view did not (a second tool of a kind and name already named, or a
   * stop driven by another of them): the hub, whose connections each hear their own entries, tells them again.
   */
  presenceChanged?(session: RunSession): void;
  /**
   * The addresses of the instances this host connects to: a run's page (`run-page`) is kept only on this machine or
   * under one of them (`isPageOfInstance`). None by default.
   */
  instances?(): Iterable<string | null | undefined>;
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
   * Whether the run of `ref` was started to be watched: the service built its command with the editor's breakpoints or
   * for a spec that calls `page.pause()` (both headed), or the person's start options hold its failures. Its **Hold
   * failures** is on from its start, until a person or an agent turns it off (`hold`).
   */
  watched?(ref: string): boolean;
  /**
   * Whether a failure of the run of `ref` may be held at all, whoever watches it: true by default. A run nobody attends
   * (the desktop app's Flake Lab, bisect and lab runs, a run in UI mode or repeating its tests past a failure, the
   * editor's Verify ×3, fix plan verifications and Flake Lab lines) holds none: its workers hear that they hold no
   * failure (`attached`), and a failure that stops one anyway goes on at once. It stops at no breakpoint either, and a
   * stop no one asked for (a `page.pause()`) goes on at once; a Pause, a Step or a Run to someone asked for waits.
   */
  holdsFailures?(ref: string): boolean;
  /**
   * A session starts: a run's first connection opened, its own process's or a worker's, the run's command being one
   * the service built or one it did not, or a run of a ref whose command ended before (`again`: a rerun of that command, its environment and ref as
   * they were, whose code is the files as they stand now).
   */
  sessionStarted?(ref: string, again: boolean): void;
  /** A teammate asks to watch the run of `ref` (`run-ask`): the client asks the developer. */
  askedToWatch?(ask: AskToWatchParams): void;
  /** This window's runs are shared live from now on, or no longer (`share` with `scope: 'window'`). */
  shareWindowChanged?(on: boolean): void;
  /**
   * Whether the run of `ref` was started in a terminal, by no command of the host's (a ref it never built): it is shown
   * as one (`RunSession.terminal`), starts with the editor's breakpoints (`setEditorBreakpoints`), and holds a failure
   * only once a person or an agent turns its **Hold failures** on (`hold`), so it never waits for nobody. False by
   * default.
   */
  terminal?(ref: string): boolean;
  /**
   * Why this host does not start an intent at any stop, whatever the worker takes (the desktop app's server, which no
   * editor records into nor checks with); null for one it starts. Such an intent is refused, and left out of
   * `intentsOf`.
   */
  declines?(what: RunIntent): string | null;
  /** What the sentences call the host the workers connect to: `the editor` by default. */
  host?: string;
  /**
   * What the workers' own lines call the host, told in `attached` (the editor's name, `Visual Studio Code`); `host`
   * when it gives none.
   */
  workerHost?: () => string | null;
  /** What the sentences call the surfaces of this host that show where a run stops: `this editor` by default. */
  surfaces?: string;
  /**
   * What a worker of the run `ref` said, for an agent following the runs, with the run's folder as `piwi/status` names
   * it (`root`); `worker` is null for the run's end.
   */
  heard?(ref: string, worker: number | null, what: RunHeard, root: string | null): void;
  /**
   * The text of `file` as the run of `ref` runs it, which a breakpoint or a Run to cursor is read against: on a
   * statement broken over lines, a breakpoint stops at each of its lines (`breakpointLines`) and Run to cursor runs to
   * the line of its call (`runToLine`). Null, or no such option, keeps the line as it is.
   */
  runText?(ref: string, file: string): string | null;
  paceMs?: number;
  burstMs?: number;
  lingerMs?: number;
  requestMs?: number;
  /** How long after a worker was asked for its page's text another ask of it is merged with that one. */
  laneTextMs?: number;
  /**
   * Starts Playwright's trace viewer on a lane's running test's trace (`openTrace`, **Open the trace so far**): the
   * service's and the desktop app's server's `startTraceViewer`. Absent, no trace is opened.
   */
  traceViewer?: TraceViewerLauncher;
  /**
   * Whether this machine shows the trace viewer's window: `hasDisplay` by default. Without one, no worker says it opens
   * its trace (`RunWorker.traces`), the hub leaves `trace` out of its features, and `openTrace` is refused.
   */
  traceDisplay?(): boolean;
}

interface Worker {
  socket: net.Socket;
  index: number;
  parallelIndex: number;
  /** The run's working directory, which the worker's places are relative to. */
  cwd: string;
  /**
   * Its lane's test, stop, Pause and the call that Pause waits in, read from its lane (`Session.laneStates`) while it
   * is the lane's worker: what it says changes them through `RunSessions.hear` alone.
   */
  readonly test: RunTest | null;
  readonly stop: HeldStop | null;
  readonly pausing: boolean;
  readonly waiting: RunWaiting | null;
  /** What its reporter takes at a stop, what it does beyond that (`features`), and its version. */
  takes: Set<RunTake>;
  features: Set<RunFeature>;
  reporter: string;
  /**
   * Its lane view while its lane has viewers: the worker's answer to starting it, which every viewer waiting for it
   * shares, and whether it started. Null when nobody watches the lane.
   */
  lane: { started: Promise<IntentAnswer>; on: boolean } | null;
  /** The layers its lane's viewers ask together as it last heard them (`layers`), comma-separated. */
  layersSent: string;
  /**
   * Its page's text as last asked of it, by a `text` request or by `layers` listing `text` anew: when, its answer, and
   * whether that answer is still to come. Another ask meanwhile, or within `laneTextMs` of it, shares its answer.
   */
  textAsk: { at: number; answer: Promise<RunControlResult>; pending: boolean } | null;
  /** The requests waiting for the worker's answer, by what they ask. */
  requests: Map<number, { what: Asked; settle(value: Answered): void }>;
  /** An agent asked the worker to stop (Pause, Step, Run to), and it has not stopped since, nor anyone asked otherwise. */
  askedBy: 'agent' | null;
  /**
   * Who drives its stop now (`AGENT_VIEWER` for the agent); null while nobody does. Read only while it stands at a
   * stop: the next stop sets it again.
   */
  driver: Viewer | null;
  /** The person who drove its stop and asked for a Step or a Run to: they drive the stop it comes to. */
  carried: Viewer | null;
  /** The stops its attach listed as held only while the service shows them (`RunAttach.holds`); null for none listed. */
  asksHolds: readonly RunHold[] | null;
  /** How its run stands on the team instance's live view, as it last said (`live`); null before it said. */
  live: RunLiveState | null;
  /**
   * The live view of its stop while viewers watch it: the stop, its viewers, the worker's answer to starting it, and
   * whether it started. Null when nobody watches, and as the stop ends.
   */
  view: { stop: number; viewers: Set<Viewer>; started: Promise<IntentAnswer>; on: boolean } | null;
}

/** Where a worker stands stopped: the worker's number for that stop, its place, and the stop as the client hears it. */
interface HeldStop {
  id: number;
  place: Place;
  view: RunStop;
}

/** A lane of a run as the hub keeps it (`@piwitests/core/live-lane`), with its own test, stop and call. */
type HubLane = Lane<RunTest, HeldStop, RunWaiting>;
type HubLaneEvent = LaneEvent<RunTest, HeldStop, RunWaiting>;

interface Session {
  ref: string;
  root: string | null;
  workers: Map<number, Worker>;
  /** Who was present on the run when it was last told (`presentKey`). */
  present: string;
  ended: boolean;
  /** Started in a terminal (`RunSessionsOptions.terminal`). */
  terminal: boolean;
  /** Of those, one an editor's own test runner started, as its process or a worker said (`runner`). */
  runner: boolean;
  /** A worker of the run connected once: until then, no worker connected means none started a test yet. */
  workersSeen: boolean;
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
  /**
   * Whether a person shared the run live (`share`), or stopped; null while nobody asked. False again once its last
   * streaming worker stopped though nobody asked, `stopped` saying why.
   */
  share: boolean | null;
  /**
   * Shared as one of this window's runs (`scope: 'window'`), said to the person once it is (`announced`); `streamed`
   * once a worker of it streamed to the instance.
   */
  byWindow: boolean;
  announced: boolean;
  streamed: boolean;
  /** The run on the instance this one continues, as the window shared it before; undefined until known. */
  after?: number | null;
  stopped: string | null;
  /** The run's live view as it was last summed up, kept while no worker that says it is connected. */
  live: RunLive | null;
  /** Who watches each lane (`parallelIndex`), through its tests and the workers Playwright starts in it. */
  lanes: Map<number, Set<Viewer>>;
  /** Each lane (`parallelIndex`) as it stands, reduced from what its workers say (`RunSessions.hear`). */
  laneStates: Map<number, HubLane>;
  /** The layers each viewer of a lane asked for, by lane. */
  laneLayers: Map<number, Map<Viewer, ReadonlySet<LaneLayer>>>;
  /** The run's own connection (`run-begin`), while it is open: the run goes on between its workers. */
  main: net.Socket | null;
  /** How far the run is, as its own process said; null before it said, and from a reporter that predates it. */
  progress: RunProgress | null;
  /** The run's page on the instance, as its own process named it (`run-page`); null before, or without one. */
  page: RunPage | null;
}

/**
 * What a request asks a worker: an image, what it takes but the click counts its input carries, its events, the
 * agent's requests and End the test (a control), and each of the agent's requests.
 */
type Asked =
  | 'image'
  | 'view-lane'
  | 'text'
  | 'trace'
  | 'front'
  | Exclude<RunTake, 'input-clicks' | 'events' | 'agent' | 'end' | 'share'>
  | AgentQuery;

/** The request asking a worker `what`, at the stop `stop` but for an image. */
function requestOf(request: number, what: Asked, stop: number, extra: RequestExtra): HubToRun {
  switch (what) {
    case 'image':
    case 'text':
    case 'trace':
      return { type: 'request', request, what };
    case 'view-lane':
      return { type: 'request', request, what, on: extra.on ?? false };
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

/** The lines a client names, as files and 0-based lines: a place that names no file's line is left out. */
function filesOf(places: readonly unknown[]): Array<{ file: string; line: number }> {
  return places.flatMap((place) => {
    const { uri, line } = (place ?? {}) as { uri?: unknown; line?: unknown };
    const file = typeof uri === 'string' ? uriToPath(uri) : null;
    return file && typeof line === 'number' && Number.isInteger(line) && line >= 0 ? [{ file, line }] : [];
  });
}

function uriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** The refs of runs that connected the service keeps, for a command that ended to say whether its reporter ran. */
const HEARD_REFS = 200;

export class RunSessions {
  private readonly sessions = new Map<string, Session>();
  /**
   * How many tests of each run that ended were ended at a stop, as its own process counted them, by ref: the latest
   * `MAX_KEPT_RUNS` that ended any (`endedAtStopOf`).
   */
  private readonly endedAtStop = new Map<string, number>();
  /** The refs of the runs whose reporter connected, latest last, `HEARD_REFS` at most (`heardFrom`). */
  private readonly heard = new Set<string>();
  /** The breakpoints a client sent for each run, as files and 0-based lines, newest last. */
  private readonly breakpoints = new Map<string, Array<{ file: string; line: number }>>();
  /**
   * The editor's breakpoints as the client last sent them (`setEditorBreakpoints`): a terminal's run starts with them.
   */
  private editorBreakpoints: Array<{ file: string; line: number }> = [];
  /** The refs whose command ended (`commandEnded`), the latest 50: a session of one is a rerun's. */
  private readonly endedCommands = new Set<string>();
  /** This window's runs are shared live (`share` with `scope: 'window'`), until the person stops or the window closes. */
  private shareAll = false;
  /**
   * The window's latest shared run that ended having streamed, by its instance's origin: the run on that instance the
   * window's next shared run continues.
   */
  private readonly lastShared = new Map<string, number>();
  /** The runs an agent follows (`followRun`), whose workers tell what their tests do, the latest 50. */
  private readonly followedRuns = new Set<string>();
  /** The surfaces that have the runs open (`presentOn`). */
  private readonly present = new Set<Viewer>();
  /** A number for each viewer, for what is present on a run (`presentKey`). */
  private readonly viewerIds = new WeakMap<Viewer, number>();
  private viewersNamed = 0;
  /** Each run's **Hold failures** as a person or an agent set it, by ref, the latest `MAX_KEPT_RUNS`. */
  private readonly holdsSet = new Map<string, RunHoldFailures>();
  /** The live traces a trace viewer is open on, or starting on, by what it opens: one viewer for each attempt. */
  private readonly traceViewers = new Set<string>();
  private lastRequest = 0;

  constructor(private readonly options: RunSessionsOptions) {}

  /**
   * Whether this host opens a lane's running test's trace in Playwright's trace viewer (`openTrace`): it starts one, on
   * a machine that shows its window.
   */
  get opensTraces(): boolean {
    return !!this.options.traceViewer && this.showsTraceViewer();
  }

  /** Whether this machine shows the trace viewer's window (`traceDisplay`). */
  private showsTraceViewer(): boolean {
    return this.options.traceDisplay ? this.options.traceDisplay() : hasDisplay();
  }

  /** What the sentences call the host the workers connect to. */
  private get host(): string {
    return this.options.host ?? 'the editor';
  }

  /**
   * Why a control reaches no worker of a run: none ever connected (no session, or one only its own process opened),
   * which a spec whose tests take `test` from Playwright explains, or those that did are gone.
   */
  private noWorker(session: Session | undefined): string {
    return session?.workersSeen
      ? `No worker of this run is connected to ${this.host} now: the run ended, or Playwright is starting another worker.`
      : `No worker of this run is connected to ${this.host}: none has started a test yet, or its tests import ` +
          "`test` from '@playwright/test' rather than from the file that extends Piwi's capture fixtures.";
  }

  /**
   * How many tests of the run of `ref` were ended at a stop (End the test), as its own process counted them: the live
   * run's, else the last that ended under the ref; 0 for none, and for a reporter that predates the count.
   */
  endedAtStopOf(ref: string): number {
    return this.sessions.get(ref)?.progress?.endedAtStop ?? this.endedAtStop.get(ref) ?? 0;
  }

  /** Whether the reporter of a run of `ref` ran: the run's own process reached the service (`run-begin`). */
  heardFrom(ref: string): boolean {
    return this.heard.has(ref);
  }

  /** A new session of the run `ref`, whose working directory is `cwd`. */
  private open(ref: string, cwd: string, runner: boolean): Session {
    const terminal = !!this.options.terminal?.(ref);
    const session: Session = {
      ref,
      root: this.options.rootOf(cwd),
      workers: new Map(),
      ended: false,
      terminal,
      runner: terminal && runner,
      workersSeen: false,
      heard: null,
      sent: '',
      present: '',
      sentAt: 0,
      paced: null,
      pacedAt: 0,
      linger: null,
      stoppedAt: 0,
      resumedSaid: false,
      // While this window's runs are shared, each new one is.
      share: this.shareAll ? true : null,
      byWindow: this.shareAll,
      announced: false,
      streamed: false,
      stopped: null,
      live: null,
      lanes: new Map(),
      laneStates: new Map(),
      laneLayers: new Map(),
      main: null,
      progress: null,
      page: null,
    };
    this.sessions.set(ref, session);
    // A terminal's run a person attends starts with the editor's breakpoints, as lines of its code: the files as they
    // stand now.
    if (terminal && this.holds(ref) && !this.breakpoints.has(ref)) this.keepBreakpoints(ref, this.editorBreakpoints);
    this.options.sessionStarted?.(ref, this.endedCommands.delete(ref));
    return session;
  }

  /**
   * The run's own process connected with `begin` (the reporter in Playwright's runner): its session, a new one when
   * none runs, holds how many tests the run has, then how many ended (`run-progress`) and how it ended (`run-end`), and
   * goes on while it is connected, between workers too. A second connection of a run while one is open is closed.
   */
  attachMain(socket: net.Socket, begin: RunBegin): (line: string) => void {
    this.heard.delete(begin.ref);
    this.heard.add(begin.ref);
    if (this.heard.size > HEARD_REFS) this.heard.delete(this.heard.values().next().value!);
    const session = this.sessions.get(begin.ref) ?? this.open(begin.ref, begin.cwd, begin.runner === true);
    if (session.main && !session.main.destroyed) {
      socket.destroy();
      return () => {};
    }
    if (session.terminal && begin.runner === true) session.runner = true;
    this.anotherRun(session);
    session.main = socket;
    if (session.linger) clearTimeout(session.linger);
    session.linger = null;
    session.progress = {
      total: begin.total,
      done: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
      status: 'running',
      failure: null,
    };
    socket.on('close', () => {
      if (session.main !== socket) return;
      session.main = null;
      // The process left without saying how the run ended: stopped, or killed.
      if (session.progress?.status === 'running') {
        session.progress = { ...session.progress, status: 'interrupted' };
        this.changed(session, true);
      }
      if (!session.ended && !session.workers.size) this.lingerOn(session);
    });
    this.changed(session, true);
    return (line) => {
      const message = parseRunMainToHub(line);
      if (!message || message.type === 'run-begin' || session.main !== socket || !session.progress) return;
      if (message.type === 'run-page') {
        const { type: _page, ...page } = message;
        if (!isPageOfInstance(page.url, this.options.instances?.() ?? [])) return;
        session.page = page;
        return this.changed(session, true);
      }
      if (message.type === 'run-ask') {
        this.options.askedToWatch?.({
          ref: session.ref,
          id: message.id,
          by: message.by,
          run: session.page?.id ?? null,
        });
        return;
      }
      const { type: _type, ...said } = message;
      session.progress = { ...session.progress, ...said, total: Math.max(session.progress.total, said.done) };
      if (message.type === 'run-end') {
        for (const [index, lane] of session.laneStates)
          session.laneStates.set(index, reduceLane(lane, { type: 'run-end' }));
      }
      this.changed(session, message.type === 'run-end');
    };
  }

  /**
   * A run's process, or a worker while the session lingers, reaches a session whose run's process connected before
   * and left: that run is over, and the run under its ref that starts holds lanes of its own, from nothing heard
   * (Playwright counts a run's workers from 0), and no progress until its process says it.
   */
  private anotherRun(session: Session): void {
    if (session.progress === null || (session.main && !session.main.destroyed)) return;
    session.laneStates.clear();
    session.progress = null;
  }

  /** The run ends once `SESSION_LINGER_MS` passed with no worker and no run process connected. */
  private lingerOn(session: Session): void {
    if (session.linger) clearTimeout(session.linger);
    session.linger = setTimeout(() => this.end(session), this.options.lingerMs ?? SESSION_LINGER_MS);
    session.linger.unref?.();
  }

  /**
   * A worker connected with `attach`: it joins its run's session, a new one when none runs, hears which of the stops it
   * holds only then the service shows (`attached`, to a worker that lists them: a failure's, unless its run holds none),
   * with what the service is called when it is not the editor (`host`), and the breakpoints sent for the run since it
   * started. Returns where its next lines go. A connection naming the index of a worker connected now is closed:
   * another process the run's environment reached (a test running Playwright itself) takes no worker's place. The
   * workers of a command that ended are let go with its session (`commandEnded`), so those of a rerun start a new one.
   */
  attach(socket: net.Socket, attach: RunAttach): (line: string) => void {
    let session = this.sessions.get(attach.ref);
    const holder = session?.workers.get(attach.workerIndex);
    if (holder && !holder.socket.destroyed) {
      socket.destroy();
      return () => {};
    }
    session ??= this.open(attach.ref, attach.cwd, attach.runner === true);
    // A run its own process announced first learns from its workers that an editor's test runner started it.
    if (session.terminal && attach.runner === true) session.runner = true;
    session.workersSeen = true;
    if (session.linger) this.anotherRun(session);
    if (session.linger) clearTimeout(session.linger);
    session.linger = null;
    const own = session;
    /** Its lane as it stands while it is the lane's worker; null otherwise. */
    const lane = () => laneOfWorker(own, attach.workerIndex, attach.parallelIndex);
    const worker: Worker = {
      socket,
      index: attach.workerIndex,
      parallelIndex: attach.parallelIndex,
      cwd: attach.cwd,
      get test() {
        return lane()?.test ?? null;
      },
      get stop() {
        return lane()?.stop ?? null;
      },
      get pausing() {
        return lane()?.state === 'pausing';
      },
      get waiting() {
        return lane()?.waiting ?? null;
      },
      takes: new Set(attach.takes),
      features: new Set(attach.features ?? []),
      reporter: attach.reporter,
      lane: null,
      layersSent: '',
      textAsk: null,
      requests: new Map(),
      view: null,
      askedBy: null,
      driver: null,
      carried: null,
      asksHolds: attach.holds ?? null,
      live: null,
    };
    session.workers.set(worker.index, worker);
    this.hear(session, worker, { type: 'joined', worker: worker.index });
    // A worker of that index whose connection closed, before its close was heard.
    if (holder) this.closeWorker(holder);
    socket.on('close', () => this.detach(own, worker));
    this.tellHolds(session, worker);
    const breakpoints = this.breakpoints.get(attach.ref);
    if (breakpoints) this.sendBreakpoints(worker, attach.ref, breakpoints, session.root);
    if (this.followedRuns.has(attach.ref) && worker.takes.has('events'))
      this.send(worker, { type: 'events', on: true });
    // A worker that comes later follows the sharing as a person left it.
    if (session.share !== null && worker.takes.has('share')) this.send(worker, this.shareMessage(session));
    // A worker Playwright starts in a lane someone watches shows it from its first test.
    if (session.lanes.get(worker.parallelIndex)?.size && worker.features.has('view-lane')) {
      void this.startLane(worker);
      this.sendLayers(session, worker);
    }
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
      this.unfollowRun(oldest);
    }
    this.tellEvents(ref, true);
    const session = this.sessions.get(ref);
    if (session) this.changed(session);
  }

  /**
   * No agent follows the run `ref` any more: its workers stop telling what their tests do, a later one too, and the
   * stops it drove are nobody's.
   */
  unfollowRun(ref: string): void {
    if (!this.followedRuns.delete(ref)) return;
    this.tellEvents(ref, false);
    const session = this.sessions.get(ref);
    if (!session) return;
    for (const worker of session.workers.values()) if (worker.driver === AGENT_VIEWER) worker.driver = null;
    this.changed(session);
  }

  /**
   * A surface has the runs open (`on`: a Runs window that follows them, the desktop app's window), or not any more:
   * each run names it in its `presence`.
   */
  presentOn(viewer: Viewer, on: boolean): void {
    if (on === this.present.has(viewer)) return;
    if (on) this.present.add(viewer);
    else this.present.delete(viewer);
    for (const session of this.sessions.values()) {
      // A surface that closes gives back the stops it drove.
      if (!on) {
        for (const worker of session.workers.values()) if (worker.driver === viewer) this.giveBack(session, worker);
      }
      this.changed(session);
    }
  }

  /**
   * A run's presence as `viewer` hears it, each tool marked `self` when it is that viewer: who has the run open, who
   * watches each worker's page, and who drives each worker's stop. Null for a run that is not live.
   */
  presenceFor(
    ref: string,
    viewer: Viewer,
  ): { presence: RunPresence[]; workers: Map<number, { watchers: RunPresence[]; driver: RunPresence | null }> } | null {
    const session = this.sessions.get(ref);
    if (!session) return null;
    const workers = new Map<number, { watchers: RunPresence[]; driver: RunPresence | null }>();
    for (const worker of session.workers.values()) {
      workers.set(worker.index, {
        watchers: this.watchersOf(session, worker, viewer),
        driver: worker.stop && worker.driver?.who ? presenceOf(worker.driver, viewer) : null,
      });
    }
    return { presence: this.presenceIn(session, viewer), workers };
  }

  /** Who is present on the run, viewer by viewer: what changes when any of them comes, goes or drives. */
  private presentKey(session: Session): string {
    const id = (viewer: Viewer) => {
      let known = this.viewerIds.get(viewer);
      if (known === undefined) this.viewerIds.set(viewer, (known = ++this.viewersNamed));
      return known;
    };
    const ids = (viewers: Iterable<Viewer>) => [...viewers].map(id).join(',');
    const workers = [...session.workers.values()].map(
      (w) =>
        `${w.index}:${ids(session.lanes.get(w.parallelIndex) ?? [])}/${ids(w.view?.viewers ?? [])}/` +
        `${w.driver ? id(w.driver) : ''}`,
    );
    return `${ids(this.present)}|${this.followedRuns.has(session.ref)}|${workers.join(';')}`;
  }

  /** Who has the run open: the surfaces present, and the agent while it follows the run. */
  private presenceIn(session: Session, self: Viewer | null): RunPresence[] {
    const viewers = [...this.present];
    if (this.followedRuns.has(session.ref)) viewers.push(AGENT_VIEWER);
    return presenceList(viewers, self);
  }

  /** Who watches a worker's page: its lane's viewers and its stop's. */
  private watchersOf(session: Session, worker: Worker, self: Viewer | null): RunPresence[] {
    const lane = session.lanes.get(worker.parallelIndex) ?? [];
    return presenceList([...lane, ...(worker.view?.viewers ?? [])], self);
  }

  /**
   * `by` drives the worker's stop: a person takes it from the agent, which hears so; the agent is refused while a
   * person drives it, with why. Null once `by` drives it.
   */
  private drive(session: Session, worker: Worker, by: Viewer): string | null {
    const now = worker.driver;
    if (now === by || !by.who) return null;
    if (by === AGENT_VIEWER && now) {
      const name = now.who?.name ?? 'a person';
      return (
        `${name.charAt(0).toUpperCase()}${name.slice(1)} drives this stop: a person took control there. ` +
        'Wait for them to answer it or give it back.'
      );
    }
    worker.driver = by;
    if (now === AGENT_VIEWER) {
      this.options.heard?.(session.ref, worker.index, { type: 'taken', by: by.who.name }, session.root);
    }
    this.changed(session);
    return null;
  }

  /** A viewer that no longer watches a worker's page gives its stop back, when it drove it. */
  private letGo(session: Session, worker: Worker, viewer: Viewer): void {
    if (worker.driver !== viewer || this.watching(worker, viewer)) return;
    this.giveBack(session, worker);
  }

  /** The person who drove a worker's stop gives it back: nobody drives it, and the agent hears so. */
  private giveBack(session: Session, worker: Worker): void {
    const was = worker.driver;
    worker.driver = null;
    if (worker.carried === was) worker.carried = null;
    if (was && was !== AGENT_VIEWER && worker.stop) {
      this.options.heard?.(session.ref, worker.index, { type: 'given-back' }, session.root);
    }
    this.changed(session);
  }

  /** The person who drives a worker's stop; null for nobody, or the agent. */
  private personDriving(worker: Worker): Viewer | null {
    return worker.driver && worker.driver !== AGENT_VIEWER ? worker.driver : null;
  }

  /**
   * The hub's `drive` and the editors' `piwi/driveStop`: at the stop `since` names, `viewer` drives it (`on`: an agent's
   * actions there are refused until it gives it back), or gives it back, as does any of the same tool's `others` that
   * drives it. Refused without the stop.
   */
  driveStop(
    params: StopParams & { since: string },
    viewer: Viewer,
    on: boolean,
    others: readonly Viewer[] = [],
  ): RunControlResult {
    if (typeof params?.since !== 'string' || !params.since) {
      return { ok: false, message: 'The command needs the stop it answers.' };
    }
    const at = this.stopped(params);
    if ('message' in at) return at;
    const { session, worker } = at;
    if (!viewer.who) return { ok: false, message: 'Only a tool a person uses drives a stop.' };
    if (on) {
      const fromAgent = worker.driver === AGENT_VIEWER;
      this.drive(session, worker, viewer);
      return {
        ok: true,
        message: fromAgent
          ? 'You drive this stop: the agent waits until you give it back.'
          : 'You drive this stop: an agent would wait until you give it back.',
      };
    }
    if (worker.driver !== viewer && !others.includes(worker.driver!)) {
      return { ok: true, message: 'You did not drive this stop.' };
    }
    this.giveBack(session, worker);
    return { ok: true, message: 'You gave this stop back: an agent may act on it.' };
  }

  /**
   * `piwi/holdRun`, the hub's `hold` and an agent's `run_follow`: the run's **Hold failures**, kept for the run of `ref`
   * whoever set it (`by`), a run whose first worker has not connected yet included. Off, a failure held now goes on.
   * Refused for a run nobody attends (`holdsFailures`).
   */
  hold(params: HoldRunParams, by: 'person' | 'agent'): RunControlResult {
    if (typeof params?.on !== 'boolean' || typeof params.ref !== 'string' || !params.ref) {
      return { ok: false, message: 'Hold failures needs the run and on: true or false.' };
    }
    if (!this.holds(params.ref)) {
      return {
        ok: false,
        message: 'Nobody attends a run of this kind: its failures go on at once, whoever watches it.',
      };
    }
    this.holdsSet.delete(params.ref);
    this.holdsSet.set(params.ref, { on: params.on, by });
    // Past the bound, the oldest set for a run that is not live goes first, then the oldest.
    for (const ref of [...this.holdsSet.keys()].filter((r) => !this.sessions.has(r))) {
      if (this.holdsSet.size <= MAX_KEPT_RUNS) break;
      this.holdsSet.delete(ref);
    }
    for (const oldest of this.holdsSet.keys()) {
      if (this.holdsSet.size <= MAX_KEPT_RUNS) break;
      this.holdsSet.delete(oldest);
    }
    const session = this.sessions.get(params.ref);
    if (session) {
      for (const worker of session.workers.values()) this.tellHolds(session, worker);
      if (!params.on) {
        for (const worker of session.workers.values()) {
          // A stop a person drives is theirs to answer: an agent's turning the hold off leaves it held.
          if (by === 'agent' && this.personDriving(worker)) continue;
          if (worker.stop && !worker.stop.view.bar && worker.stop.view.reason === 'failure') {
            this.resumeUnanswered(session, worker, worker.stop.place);
          }
        }
      }
      this.changed(session, true);
    }
    return {
      ok: true,
      message: params.on
        ? 'A failure no pause bar shows waits at its line in this run until someone answers it.'
        : 'A failure of this run no pause bar shows goes on at once.',
    };
  }

  /**
   * Tell a worker that listed them which stops it holds (`attached`), with what the service is called when it is not the
   * editor (`host`): a failure's only while its run's Hold failures is on.
   */
  private tellHolds(session: Session, worker: Worker): void {
    if (!worker.asksHolds) return;
    const failures = this.watches(session);
    const holds = SHOWN_HOLDS.filter((h) => worker.asksHolds!.includes(h) && (h !== 'failure' || failures));
    const named = this.options.workerHost?.() ?? this.options.host;
    this.send(worker, { type: 'attached', holds, ...(named ? { host: named } : {}) });
  }

  /**
   * The run's **Hold failures** now: as a person or an agent set it, else on from its start when built to be watched.
   * The same object until it is set again, so a caller can tell whether anyone set it since.
   */
  holdOf(ref: string): RunHoldFailures {
    return this.holdsSet.get(ref) ?? { on: !!this.options.watched?.(ref), by: 'start' };
  }

  /** Have the workers of the run `ref` whose reporter takes it tell their tests' events, or stop. */
  private tellEvents(ref: string, on: boolean): void {
    for (const worker of this.sessions.get(ref)?.workers.values() ?? []) {
      if (worker.takes.has('events')) this.send(worker, { type: 'events', on });
    }
  }

  /**
   * `piwi/shareRun`: share the run of `ref` live on the team instance its reporter reports to (`on`), or stop: each
   * worker that takes it opens or closes its stream there, and a worker that connects later follows. Sharing is
   * refused, with why, for a run with no worker connected, whose reporter predates it, or none of whose workers can be
   * shared; stopping never is, a worker that connects later included.
   */
  share(params: ShareRunParams): RunControlResult {
    const refuse = (message: string): RunControlResult => ({ ok: false, message });
    if (typeof params?.on !== 'boolean') return refuse('Share live needs on: true to share the run, false to stop.');
    if (params.scope === 'window') return this.shareWindow(params);
    const session = typeof params.ref === 'string' ? this.sessions.get(params.ref) : undefined;
    if (!session) return refuse(this.noWorker(session));
    const live = this.liveOf(session);
    const instance = live?.page ? instanceOf(live.page) : 'the instance';
    const workers = [...session.workers.values()].filter((w) => w.takes.has('share'));
    if (params.on) {
      if (!session.workers.size) return refuse(this.noWorker(session));
      if (!workers.length) {
        const reporter = [...session.workers.values()][0]!.reporter;
        return refuse(`@piwitests/reporter ${reporter}`.trimEnd() + ' cannot share a run live: update it.');
      }
      if (!workers.some((w) => w.live?.can)) return refuse(live?.refused ?? NOT_SAID);
    }
    session.share = params.on;
    session.stopped = null;
    for (const worker of workers) this.send(worker, this.shareMessage(session));
    this.changed(session, true);
    return {
      ok: true,
      message: params.on
        ? `Sharing the run live on ${instance}: whoever may open it there can watch its tests' pages while someone does.`
        : `Stopped sharing the run: nothing more goes to ${instance}.`,
    };
  }

  /**
   * `share` with `scope: 'window'`: this window's runs are shared until the person stops or the window closes, the run
   * of `ref` too when one is named; stopping stops every run of the window that is shared.
   */
  private shareWindow(params: ShareRunParams): RunControlResult {
    this.shareAll = params.on;
    // Said whether it changed or not, so a client that holds it otherwise hears how it stands.
    this.options.shareWindowChanged?.(params.on);
    if (!params.on) {
      for (const session of this.sessions.values()) {
        session.byWindow = false;
        if (session.share) this.share({ ref: session.ref, on: false });
      }
      this.lastShared.clear();
      return { ok: true, message: "Stopped sharing this window's runs live." };
    }
    const session = typeof params.ref === 'string' ? this.sessions.get(params.ref) : undefined;
    if (session && !session.ended) {
      session.byWindow = true;
      const shared = this.share({ ref: session.ref, on: true });
      if (!shared.ok) {
        return { ok: true, message: `This window's runs are shared live from the next one on: ${shared.message}` };
      }
    }
    return {
      ok: true,
      message:
        "Sharing this window's runs live until you stop or close the window: whoever may open them on the team instance can watch their tests' pages, each run continuing the one before.",
    };
  }

  /** Whether this window's runs are shared live. */
  get sharingWindow(): boolean {
    return this.shareAll;
  }

  /**
   * The share message a worker of `session` hears: with the run on its instance it continues, the window's latest
   * shared run there that ended, fixed for the run once its page is known; none before.
   */
  private shareMessage(session: Session): HubToRun {
    const on = session.share === true;
    if (on && session.byWindow && session.page && session.after === undefined) {
      const before = this.lastShared.get(pageOrigin(session.page.url));
      session.after = before !== undefined && before < session.page.id ? before : null;
    }
    const after = on && session.byWindow ? (session.after ?? null) : null;
    return after !== null ? { type: 'share', on, after } : { type: 'share', on };
  }

  /** A run of the window that ended having streamed is the one the window's next shared run continues. */
  private noteShared(session: Session): void {
    if (!session.byWindow || !session.streamed || !session.page) return;
    const origin = pageOrigin(session.page.url);
    this.lastShared.delete(origin);
    this.lastShared.set(origin, session.page.id);
    for (const oldest of this.lastShared.keys()) {
      if (this.lastShared.size <= MAX_KEPT_RUNS) break;
      this.lastShared.delete(oldest);
    }
  }

  /** `piwi/answerAsk`: the developer's **Not now** goes back to the teammate through the run's own process. */
  answerAsk(params: AnswerAskParams): RunControlResult {
    const answer = parseLiveAskAnswer(params);
    if (!answer) return { ok: false, message: 'Not an answer to an ask to watch.' };
    const session = typeof params.ref === 'string' ? this.sessions.get(params.ref) : undefined;
    const main = session?.main;
    if (!main || main.destroyed) {
      return { ok: false, message: 'The run no longer reaches the instance: its teammate sees no answer.' };
    }
    const line: HubToMain = { type: 'ask-answer', ...answer };
    main.write(`${JSON.stringify(line)}\n`);
    return { ok: true, message: 'They see “Not now”.' };
  }

  /**
   * How the run stands on the team instance's live view, summed up from what its workers said: shared while one of
   * them streams or opens its stream, why it cannot be when none of them can, why its sharing stopped though nobody
   * asked, its page, and the views open of its workers. Kept as it was while no worker that says it is connected (not
   * shared once a person stopped it); none for a run whose reporter predates it.
   */
  private liveOf(session: Session): RunLive | undefined {
    const states = [...session.workers.values()].flatMap((w) => (w.takes.has('share') && w.live ? [w.live] : []));
    if (!states.length) {
      if (!session.live) return undefined;
      return { ...session.live, shared: session.live.shared && session.share !== false, viewers: 0 };
    }
    const can = states.some((state) => state.can);
    const on = states.some((state) => state.on);
    session.live = {
      shared: on,
      refused: can ? null : (states.find((state) => state.why)?.why ?? NOT_SAID),
      stopped: on ? null : session.stopped,
      page: states.find((state) => state.page)?.page ?? null,
      viewers: states.reduce((sum, state) => sum + (state.on ? state.viewers : 0), 0),
    };
    return session.live;
  }

  /**
   * `piwi/runControl`: what the worker was asked, or why nothing was. `by` names an agent that asked (the service's MCP
   * server): the stop a Pause, a Step or a Run to it asked for is said to be its own.
   */
  control(params: RunControlParams, by: 'agent' | null = null): RunControlResult {
    const refuse = (message: string): RunControlResult => ({ ok: false, message });
    const session = typeof params?.ref === 'string' ? this.sessions.get(params.ref) : undefined;
    if (!session?.workers.size) return refuse(this.noWorker(session));
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
          this.hear(session, worker, { type: 'pause' });
          worker.askedBy = by;
        }
        this.changed(session, true);
        return {
          ok: true,
          message:
            asked.length > 1 ? `Pausing ${asked.length} workers at their next call.` : 'Pausing at the next call.',
        };
      }
      case 'give-up': {
        const pausing = workers.filter((w) => w.pausing && !w.stop && w.test);
        // A worker says the call it waits in only where it ends a test there.
        const waiting = pausing.filter((w) => w.waiting);
        const older = pausing.find((w) => !w.features.has('give-up'));
        if (!waiting.length && older) {
          return refuse(
            `@piwitests/reporter ${older.reporter || ''}`.trimEnd() +
              ' cannot end a test while it waits for a Pause: update it, or let the call finish.',
          );
        }
        if (!waiting.length) {
          return refuse(
            workers.some((w) => w.stop) ? 'The test is stopped: End the test answers its stop.' : NOT_WAITING,
          );
        }
        if (waiting.length > 1) return refuse(`${waiting.length} workers wait for a Pause: choose one.`);
        const worker = waiting[0]!;
        const call = worker.waiting;
        this.send(worker, { type: 'control', action: 'give-up', testId: worker.test!.id });
        this.hear(session, worker, { type: 'pause-ended' });
        worker.askedBy = null;
        this.changed(session, true);
        return {
          ok: true,
          message: call?.endable
            ? `Ending the test: ${call.title} is given up.`
            : `Ending the test as ${call?.title ?? 'its call'} returns.`,
        };
      }
      case 'step':
      case 'resume':
      case 'finish':
      case 'run-to':
      case 'end': {
        const worker = this.stoppedWorker(workers, named, params.since);
        if ('message' in worker) return worker;
        if (by === 'agent' && worker.driver && worker.driver !== AGENT_VIEWER) {
          return refuse(this.drive(session, worker, AGENT_VIEWER)!);
        }
        const stop = worker.stop!.id;
        if (params.action === 'end') {
          if (!worker.takes.has('end')) {
            return refuse(`@piwitests/reporter ${worker.reporter || ''}`.trimEnd() + ' cannot end a test: update it.');
          }
          this.send(worker, { type: 'control', action: 'end', stop });
          worker.askedBy = null;
          worker.carried = null;
          return {
            ok: true,
            message:
              worker.stop!.view.reason === 'failure'
                ? 'The test failed already: it ends as it failed.'
                : 'Ending the test: it is reported as skipped.',
          };
        }
        if (params.action === 'run-to') {
          const file = typeof params.place?.uri === 'string' ? uriToPath(params.place.uri) : null;
          const line = params.place?.line;
          if (!file || typeof line !== 'number' || !Number.isInteger(line) || line < 0) {
            return refuse('Run to needs a line of a file.');
          }
          const relative = this.relative(worker, file, session.root);
          if (!relative) return refuse(`${path.basename(file)} is outside the folder the run runs in.`);
          const text = this.options.runText?.(params.ref, file) ?? null;
          const to = text ? runToLine(text, line) : line;
          this.send(worker, { type: 'run-to', stop, place: { file: relative, line: to + 1 } });
          worker.askedBy = by;
          worker.carried = by === 'agent' ? null : this.personDriving(worker);
          return { ok: true, message: `Running to ${path.basename(file)}:${line + 1}.` };
        }
        this.send(worker, { type: 'control', action: params.action, stop });
        worker.askedBy = params.action === 'step' ? by : null;
        worker.carried = params.action === 'step' && by !== 'agent' ? this.personDriving(worker) : null;
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
    if (!session?.workers.size) return refuse(this.noWorker(session));
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
    const stop = worker.stop!.id;
    return this.ask(worker, params.what, stop).then((answer) => {
      const said = (answer as IntentAnswer | null) ?? { ok: false, message: 'The test did not answer.' };
      // An intent started from a surface is its person driving the stop, while the worker still stands at it.
      if (said.ok && params.viewer && worker.stop?.id === stop) this.drive(at.session, worker, params.viewer);
      return said;
    });
  }

  /**
   * Whether `viewer` watches the live view of the stop its worker stands at: its own view, or the worker's lane, which
   * shows the stop's page while the worker stands at it.
   */
  private watching(worker: Worker, viewer: Viewer | null): boolean {
    if (!viewer || !worker.stop) return false;
    if (worker.view?.stop === worker.stop.id && worker.view.viewers.has(viewer)) return true;
    // The lane shows a stop of its running test alone: one outside a test is no frame of it.
    return !!worker.lane?.on && !!worker.test && !!this.laneOf(worker)?.has(viewer);
  }

  /** The viewers of a worker's lane; undefined when nobody watches it. */
  private laneOf(worker: Worker): Set<Viewer> | undefined {
    for (const session of this.sessions.values()) {
      if (session.workers.get(worker.index) === worker) return session.lanes.get(worker.parallelIndex);
    }
    return undefined;
  }

  /**
   * Whether a lane's frame still goes to `viewer`: it watches the lane, the frame's worker is connected, and the stop
   * the frame shows (`since`) is the one that worker stands at; a frame of a test running names none.
   */
  laneFrameGoes(viewer: Viewer, frame: Pick<LaneViewFrame, 'ref' | 'lane' | 'worker' | 'since'>): boolean {
    const session = this.sessions.get(frame.ref);
    const worker = session?.workers.get(frame.worker);
    if (!session?.lanes.get(frame.lane)?.has(viewer) || !worker?.lane) return false;
    return frame.since === null || worker.stop?.view.since === frame.since;
  }

  /**
   * Start or stop watching a lane of a run: the page of its running test, of its stop while it stands at one, through
   * its tests and the workers Playwright starts in it, its frames going to `viewer.laneFrame` until it stops watching,
   * the run ends or it leaves. The lane's worker starts its lane view with the first viewer and stops it with the last;
   * a viewer that comes later is sent its latest frame again. Refused for a worker whose reporter does not show its
   * lane. A lane with no worker connected now is watched from the next one Playwright starts in it. The layers it asks
   * (`layers`, none when left out) go to `viewer.laneLayer` alone, from a worker that sends them: the worker hears what
   * the viewers ask together (`layers`) as it changes, which takes the page's text as it first lists it, and again as a
   * viewer asks for the call log or the filmstrip anew, which has it send them again. The page's text it takes again
   * only as asked (`laneText`).
   */
  async watchLane(params: LaneParams, viewer: Viewer): Promise<RunControlResult> {
    const session = typeof params?.ref === 'string' ? this.sessions.get(params.ref) : undefined;
    const lane = params?.lane;
    if (!Number.isInteger(lane) || lane < 0) return { ok: false, message: 'The command needs the lane it watches.' };
    if (!params.on) {
      if (session) this.unwatchLane(session, lane, viewer);
      return { ok: true, message: 'You no longer watch the lane.' };
    }
    if (!session || session.ended) return { ok: false, message: this.noWorker(session) };
    const worker = [...session.workers.values()].find((w) => w.parallelIndex === lane) ?? null;
    if (worker && !worker.features.has('view-lane')) {
      return {
        ok: false,
        message: 'Update the reporter to watch a running test: this one shows a stopped test alone.',
      };
    }
    // As many lanes as the run has workers, and a few more Playwright may start: a lane past them is no lane.
    if (!session.lanes.has(lane) && session.lanes.size >= MAX_WATCHED_LANES) {
      return { ok: false, message: `This run has no worker ${lane + 1} to watch.` };
    }
    const viewers = session.lanes.get(lane) ?? new Set<Viewer>();
    session.lanes.set(lane, viewers);
    const came = !viewers.has(viewer);
    viewers.add(viewer);
    const layered = session.laneLayers.get(lane) ?? new Map<Viewer, ReadonlySet<LaneLayer>>();
    session.laneLayers.set(lane, layered);
    const before = layered.get(viewer);
    const asked = new Set(LANE_LAYERS.filter((layer) => params.layers?.includes(layer)));
    layered.set(viewer, asked);
    // A viewer that newly asks for the call log or the filmstrip needs the latest call log and the filmstrip kept.
    const again = (['calls', 'filmstrip'] as const).some((layer) => asked.has(layer) && !before?.has(layer));
    const next = { ok: true, message: `You watch worker ${lane + 1} from its next test.` };
    if (!worker) return next;
    const own = worker.lane;
    // A viewer that comes to a lane view on, or newly asks for those layers: the worker sends again what it sent last,
    // the frame and the layers it keeps.
    if (own?.on && (came || again)) void this.ask(worker, 'view-lane', undefined, { on: true });
    const starting = own ? own.started : this.startLane(worker);
    this.sendLayers(session, worker);
    const answer = await starting;
    if (answer.ok || !session.lanes.get(lane)?.has(viewer)) return answer;
    // A worker that left before it answered: the viewer watches the next one Playwright starts in the lane.
    if (session.workers.get(worker.index) !== worker && !session.ended) return next;
    this.unwatchLane(session, lane, viewer);
    return answer;
  }

  /**
   * Ask a worker to start its lane view, once for every viewer waiting: an answer it gave too late, or a refusal, has it
   * stop the view again, so a view no viewer was told of never stays on.
   */
  private startLane(worker: Worker): Promise<IntentAnswer> {
    if (worker.lane) return worker.lane.started;
    const started = (this.ask(worker, 'view-lane', undefined, { on: true }) as Promise<IntentAnswer | null>).then(
      (answer) => {
        const said = answer ?? { ok: false, message: 'The test did not answer.' };
        if (worker.lane?.started !== started) return said;
        if (said.ok) worker.lane.on = true;
        else {
          worker.lane = null;
          this.stopLane(worker);
        }
        return said;
      },
    );
    worker.lane = { started, on: false };
    return started;
  }

  /** Have a worker stop its lane view and its layers, whatever it answers. */
  private stopLane(worker: Worker): void {
    if (worker.socket.destroyed) return;
    if (worker.features.has('layers') && worker.layersSent) this.send(worker, { type: 'layers', layers: [] });
    worker.layersSent = '';
    this.send(worker, { type: 'request', request: ++this.lastRequest, what: 'view-lane', on: false });
  }

  /**
   * Tell a worker that sends layers which its lane's viewers ask, together, in `LANE_LAYERS`' order, when that changed
   * since it last heard it: it takes the page's text as the list names it anew, which counts as that worker's latest ask
   * of it (`textAsk`).
   */
  private sendLayers(session: Session, worker: Worker): void {
    if (!worker.features.has('layers') || worker.socket.destroyed) return;
    const asked = new Set<LaneLayer>();
    for (const layers of session.laneLayers.get(worker.parallelIndex)?.values() ?? []) {
      for (const layer of layers) asked.add(layer);
    }
    const layers = LANE_LAYERS.filter((layer) => asked.has(layer));
    const sent = worker.layersSent;
    if (layers.join() === sent) return;
    worker.layersSent = layers.join();
    if (asked.has('text') && !sent.split(',').includes('text')) {
      worker.textAsk = { at: Date.now(), answer: Promise.resolve(TEXT_ON_ITS_WAY), pending: false };
    }
    this.send(worker, { type: 'layers', layers });
  }

  /** A viewer stops watching a lane: the last one to go has its worker stop the lane view. */
  private unwatchLane(session: Session, lane: number, viewer: Viewer): void {
    const viewers = session.lanes.get(lane);
    if (!viewers?.delete(viewer)) return;
    const layered = session.laneLayers.get(lane);
    layered?.delete(viewer);
    if (!layered?.size) session.laneLayers.delete(lane);
    for (const worker of session.workers.values()) {
      if (worker.parallelIndex === lane) this.letGo(session, worker, viewer);
    }
    if (viewers.size) {
      for (const worker of session.workers.values()) {
        if (worker.parallelIndex === lane && worker.lane) this.sendLayers(session, worker);
      }
      this.changed(session);
      return;
    }
    session.lanes.delete(lane);
    this.changed(session);
    for (const worker of session.workers.values()) {
      if (worker.parallelIndex !== lane || !worker.lane) continue;
      worker.lane = null;
      this.stopLane(worker);
    }
  }

  /**
   * Ask the worker of a lane `viewer` watches with its page's text (`layers` lists `text`) for that text now: it comes
   * as a `lane-layer` to the lane's viewers that asked for the text. Answered as the worker answers, or with why not.
   * An ask while the worker's latest is answered, or within `laneTextMs` of it, is that one's: the worker hears none.
   */
  async laneText(params: Omit<LaneParams, 'on' | 'layers'>, viewer: Viewer): Promise<RunControlResult> {
    const session = typeof params?.ref === 'string' ? this.sessions.get(params.ref) : undefined;
    const lane = params?.lane;
    if (!session || session.ended || !Number.isInteger(lane) || !session.lanes.get(lane)?.has(viewer)) {
      return { ok: false, message: 'Watch the worker first.' };
    }
    if (!session.laneLayers.get(lane)?.get(viewer)?.has('text')) {
      return { ok: false, message: 'Show the page’s text first.' };
    }
    const worker = [...session.workers.values()].find((w) => w.parallelIndex === lane && w.lane?.on);
    if (!worker) return { ok: false, message: `Worker ${lane + 1} shows no page now.` };
    if (!worker.features.has('layers')) {
      return { ok: false, message: 'Update the reporter to read the page’s text: this one sends its images alone.' };
    }
    const last = worker.textAsk;
    const now = Date.now();
    if (last && (last.pending || now - last.at < (this.options.laneTextMs ?? LANE_TEXT_MS))) return last.answer;
    const asked: NonNullable<Worker['textAsk']> = {
      at: now,
      pending: true,
      answer: (this.ask(worker, 'text') as Promise<IntentAnswer | null>).then((answer) => {
        asked.pending = false;
        return answer ?? { ok: false, message: 'The test did not answer.' };
      }),
    };
    worker.textAsk = asked;
    return asked.answer;
  }

  /**
   * **Open the trace so far** of the lane `lane` of the run `ref`: the trace this host reads (`laneTrace`), and
   * Playwright's trace viewer started on it from the run's folder as this host knows it, one for each attempt at a time
   * (`traceViewer`). Answered in a sentence that never names the file, which no message, log or answer of the host
   * carries.
   */
  async openTrace(params: OpenTraceParams): Promise<RunControlResult> {
    const launch = this.options.traceViewer;
    const lane = params?.lane;
    if (!Number.isInteger(lane) || lane < 0) return { ok: false, message: 'The command needs the lane of the trace.' };
    if (!launch) return { ok: false, message: `${capitalized(this.host)} cannot open a trace.` };
    if (!this.showsTraceViewer()) return { ok: false, message: NO_DISPLAY };
    const found = await this.laneTrace(params);
    if (!found.ok) return found;
    const live = path.join(found.traces, `${found.base}.json`);
    if (this.traceViewers.has(live)) {
      return {
        ok: false,
        message:
          "Playwright's trace viewer is open on this test's trace already: close it to open the trace as it stands now.",
      };
    }
    this.traceViewers.add(live);
    const started = await launch({ folder: found.root, trace: live }).catch(
      (error: unknown): { ok: false; reason: string } => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    if (!started.ok) {
      this.traceViewers.delete(live);
      const reason = withoutPaths(started.reason, [found.file, path.dirname(found.file), found.traces]);
      return { ok: false, message: `Playwright's trace viewer could not start: ${reason}.` };
    }
    void started.closed.finally(() => this.traceViewers.delete(live));
    return { ok: true, message: "Playwright's trace viewer opened on the trace so far." };
  }

  /**
   * The trace of the running attempt of the lane `lane` of the run `ref`, for this host to read itself: its worker names
   * where it grows, to this host alone, and the file passes `checkTraceFile` from the run's folder as this host knows
   * it (`session.root`, never the folder the worker names; a run without one has none); else why not, in a sentence
   * that never names the file. No hub command, client request nor agent's tool answers with it: `openTrace` starts the
   * viewer on it, and the desktop app's server reads its snapshots for its own window's **Inspect**.
   */
  async laneTrace(params: OpenTraceParams): Promise<LaneTrace | { ok: false; message: string }> {
    const session = typeof params?.ref === 'string' ? this.sessions.get(params.ref) : undefined;
    const lane = params?.lane;
    if (!Number.isInteger(lane) || lane < 0) return { ok: false, message: 'The command needs the lane of the trace.' };
    if (!session || session.ended) return { ok: false, message: this.noWorker(session) };
    const root = session.root;
    if (root === null) return { ok: false, message: NO_ROOT };
    const worker = [...session.workers.values()].find((w) => w.parallelIndex === lane);
    if (!worker) return { ok: false, message: `This run has no worker ${lane + 1} now.` };
    if (!worker.features.has('trace')) return { ok: false, message: CANNOT_TRACE };
    if (!worker.test) return { ok: false, message: NO_TEST };
    const test = worker.test;
    const answer = (await this.ask(worker, 'trace')) as TraceAnswer | null;
    if (!answer) return { ok: false, message: 'The test did not answer.' };
    if (!answer.ok) return { ok: false, message: answer.message };
    if (worker.test?.id !== test.id || worker.test.retry !== test.retry) {
      return { ok: false, message: 'The test ended: open the trace of the one that runs now.' };
    }
    const checked = checkTraceFile(answer.file, {
      folder: root,
      worker: worker.index,
      testId: test.id,
      retry: test.retry,
    });
    if (!checked.ok) return { ok: false, message: checked.message };
    return {
      ok: true,
      root,
      traces: checked.traces,
      base: checked.base,
      file: answer.file,
      worker: worker.index,
      test: { id: test.id, retry: test.retry },
    };
  }

  /** Whether `viewer` watches the lane `lane` of the run `ref`, which ends with the run. */
  watchesLane(viewer: Viewer, ref: string, lane: number): boolean {
    const session = this.sessions.get(ref);
    return !!session && !session.ended && !!session.lanes.get(lane)?.has(viewer);
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
      this.unwatch(at.session, worker, viewer);
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
    this.changed(at.session);
    const answer = await view.started;
    if (!answer.ok) {
      view.viewers.delete(viewer);
      this.changed(at.session);
      return { ok: false, message: answer.message };
    }
    if (worker.view === view) return { ok: true, message: answer.message };
    // The stop ended meanwhile, or the viewer left it, the last one.
    return { ok: false, message: worker.stop?.id === stop ? 'You no longer watch the page.' : 'The test went on.' };
  }

  /**
   * A viewer stops watching a worker's stop, giving it back when it drove it: the last one to go has the worker stop
   * the view.
   */
  private unwatch(session: Session, worker: Worker, viewer: Viewer): void {
    const view = worker.view;
    if (!view?.viewers.delete(viewer)) return;
    this.letGo(session, worker, viewer);
    this.changed(session);
    if (view.viewers.size) return;
    worker.view = null;
    void this.ask(worker, 'view', view.stop, { on: false });
  }

  /** A viewer left (its connection closed): it watches nothing any more, drives no stop, and has no run open. */
  unwatchAll(viewer: Viewer): void {
    this.presentOn(viewer, false);
    for (const session of this.sessions.values()) {
      for (const worker of session.workers.values()) this.unwatch(session, worker, viewer);
      for (const lane of [...session.lanes.keys()]) this.unwatchLane(session, lane, viewer);
      for (const worker of session.workers.values()) {
        if (worker.driver === viewer) this.giveBack(session, worker);
        if (worker.carried === viewer) worker.carried = null;
      }
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
    // A person's click, key, text or wheel drives the stop, taking it from the agent; a pointer passing over does not.
    if (events.some((e) => !(e.type === 'mouse' && e.action === 'move'))) this.drive(at.session, at.worker, viewer);
    const answer = (await this.ask(at.worker, 'input', at.worker.stop!.id, { events })) as IntentAnswer | null;
    return answer ?? { ok: false, message: 'The test did not answer.' };
  }

  /**
   * `piwi/pickAt`, and the hub's `pick-at`: the element under the point `x`, `y` (CSS pixels of the stopped page's
   * viewport) of the stop a client names, its locator sent where a pick goes; why there is none otherwise.
   */
  async pickAt(params: PickAtParams, viewer?: Viewer): Promise<PickAtResult> {
    const refuse = (message: string): PickAtResult => ({ ok: false, message, locator: null });
    if (typeof params?.since !== 'string' || !params.since) return refuse('The command needs the stop it answers.');
    const { x, y } = params;
    if (!isViewPoint(x, y)) return refuse('Pick on the image needs the point, in CSS pixels of the page.');
    const at = this.stopped(params);
    if ('message' in at) return refuse(at.message);
    const refused = this.refusesQuery(at.worker, 'pick-at');
    if (refused) return refuse(refused);
    if (viewer) this.drive(at.session, at.worker, viewer);
    const answer = (await this.ask(at.worker, 'pick-at', at.worker.stop!.id, { x, y })) as PickAtAnswer | null;
    return answer ?? refuse('The test did not answer.');
  }

  /**
   * Show the browser: at the stop a client names, the test's window comes to the front. Refused at a stop no pause bar
   * shows (a headless run, whose browser has no window, or a stop whose page is not known), and for a reporter that
   * does not take it. Answers once the
   * worker did, or after `PAUSED_PAGE_WAIT_MS`.
   */
  async front(params: StopParams): Promise<RunControlResult> {
    const at = this.stopped(params);
    if ('message' in at) return at;
    if (!at.worker.stop!.view.bar) {
      return {
        ok: false,
        message: "The test's window cannot be shown: it runs headless, or its stop names no page. Run it headed.",
      };
    }
    if (!at.worker.features.has('front')) {
      return {
        ok: false,
        message:
          `@piwitests/reporter ${at.worker.reporter || ''}`.trimEnd() +
          " cannot bring the test's window forward: update it.",
      };
    }
    const answer = (await this.ask(at.worker, 'front', at.worker.stop!.id)) as IntentAnswer | null;
    return answer ?? { ok: false, message: 'The test did not answer.' };
  }

  /**
   * For an agent: the ARIA snapshot in AI mode of the page of the stop a client names, `depth` levels deep at most (the
   * whole tree for null), with its image when `image` is true; why there is none otherwise.
   */
  async snapshot(params: StopParams, depth: number | null, image: boolean): Promise<AgentAnswer<SnapshotAnswer>> {
    const none = { url: '', title: '', snapshot: null, cut: false, image: null, answered: false };
    const at = this.stopped(params);
    if ('message' in at) return { ...at, ...none };
    const refused = this.refusesQuery(at.worker, 'snapshot');
    if (refused) return { ok: false, message: refused, ...none };
    const answer = (await this.ask(at.worker, 'snapshot', at.worker.stop!.id, {
      depth,
      image,
    })) as SnapshotAnswer | null;
    return answer ? { ...answer, answered: true } : { ok: false, message: 'The test did not answer.', ...none };
  }

  /** For an agent: the element `ref` names on the page of the stop a client names, and its locators ranked. */
  async refLocator(params: StopParams, ref: string): Promise<AgentAnswer<RefLocatorAnswer>> {
    return this.refQuery(params, 'ref-locator', { ref });
  }

  /**
   * For an agent: act on the element `ref` names on the page of the stop `since` names, as trusted input, the element
   * as it stood before in the answer; refused without the stop. An action the page did not answer in time is answered
   * `late`, and `played` hears it if it is played after all.
   */
  async act(
    params: StopParams & { since: string },
    act: { ref: string; action: RunActAction; value: string | null },
    played?: (answer: ActAnswer) => void,
  ): Promise<AgentAnswer<ActAnswer>> {
    if (typeof params?.since !== 'string' || !params.since) {
      return noElement('The command needs the stop it answers.');
    }
    const at = this.stopped(params);
    if (!('message' in at) && !this.refusesQuery(at.worker, 'act')) {
      // One driver at a time: the agent acts only while no person drives the stop, and drives it as it does.
      const taken = this.drive(at.session, at.worker, AGENT_VIEWER);
      if (taken) return noElement(taken);
    }
    const late = played
      ? (value: Answered) => (value as ActAnswer | null)?.ok && played(value as ActAnswer)
      : undefined;
    return this.refQuery(params, 'act', act, late);
  }

  private async refQuery(
    params: StopParams,
    what: 'ref-locator' | 'act',
    extra: RequestExtra,
    late?: (value: Answered) => void,
  ): Promise<AgentAnswer<ActAnswer>> {
    const at = this.stopped(params);
    if ('message' in at) return noElement(at.message);
    const refused = this.refusesQuery(at.worker, what);
    if (refused) return noElement(refused);
    const answer = (await this.ask(at.worker, what, at.worker.stop!.id, extra, late)) as ActAnswer | null;
    if (answer) return { ...answer, answered: true };
    // An action the worker did not answer in time may still be played.
    return what === 'act' ? { ...noElement(NO_ANSWER_YET), late: true } : noElement(NO_ANSWER_YET);
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
    return worker.takes.has(takeOf(what))
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
      ...(found.features.has('front') ? (['front'] as const) : []),
      ...(found.takes.has('end') ? (['end'] as const) : []),
      ...(found.features.has('view-lane') ? (['watch'] as const) : []),
      // End the test while a Pause waits for its call.
      ...(found.waiting ? (['give-up'] as const) : []),
    ];
  }

  /**
   * What the stop of a run's worker takes from `viewer` now, of `intentsOf`: the input (and the click counts it carries,
   * `input-clicks`) only while `viewer` watches its live view, at a stop no pause bar shows the actions in the test's
   * window (Pick, Record, Assert, Assert a region) only then too, driven through that view, and End the test but at a
   * failure, which Resume ends as it failed.
   */
  stopIntentsOf(ref: string, worker: number, viewer: Viewer | null): HubAction[] {
    const found = this.sessions.get(ref)?.workers.get(worker);
    if (!found?.stop) return [];
    const watching = this.watching(found, viewer);
    const inWindow = found.stop.view.bar || watching;
    return this.intentsOf(ref, worker).filter((what) =>
      what === 'watch'
        ? false
        : what === 'input' || what === 'input-clicks'
          ? watching
          : what === 'end'
            ? found.stop!.view.reason !== 'failure'
            : what === 'front'
              ? found.stop!.view.bar
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

  /** Whether a worker stands at a failure no bar shows in a run whose **Hold failures** is off: it goes on at once. */
  private unwatchedFailure(session: Session, worker: Worker): boolean {
    return worker.stop?.view.reason === 'failure' && !this.watches(session);
  }

  /** Whether the run's failures wait for an answer: its **Hold failures** is on, in a run that may hold one. */
  private watches(session: Session): boolean {
    return this.holds(session.ref) && this.holdOf(session.ref).on;
  }

  /** Whether a failure of the run of `ref` may be held at all. */
  private holds(ref: string): boolean {
    return this.options.holdsFailures?.(ref) ?? true;
  }

  /**
   * `piwi/setRunBreakpoints`: the run's workers stop at these lines from now on, a worker that starts later too. A run
   * nobody attends (`holdsFailures`) stops at none.
   */
  setBreakpoints(params: SetRunBreakpointsParams): void {
    if (typeof params?.ref !== 'string' || !Array.isArray(params.places) || !this.holds(params.ref)) return;
    const files = filesOf(params.places);
    this.keepBreakpoints(params.ref, files);
    const session = this.sessions.get(params.ref);
    for (const worker of session?.workers.values() ?? [])
      this.sendBreakpoints(worker, params.ref, files, session!.root);
  }

  /** `piwi/setBreakpoints`: the editor's breakpoints as it holds them now, which a terminal's run starts with. */
  setEditorBreakpoints(params: SetBreakpointsParams): void {
    if (Array.isArray(params?.places)) this.editorBreakpoints = filesOf(params.places);
  }

  /** Keep a run's breakpoints, for its workers that connect later, those of the 50 latest runs. */
  private keepBreakpoints(ref: string, files: Array<{ file: string; line: number }>): void {
    this.breakpoints.delete(ref);
    this.breakpoints.set(ref, files);
    for (const oldest of this.breakpoints.keys()) {
      if (this.breakpoints.size <= MAX_KEPT_RUNS) break;
      this.breakpoints.delete(oldest);
    }
  }

  /** `piwi/pausedPage`: an image of a stopped worker's page, null when there is none. */
  pausedPage(params: PausedPageParams): Promise<PausedPageResult> {
    const worker = typeof params?.ref === 'string' ? this.sessions.get(params.ref)?.workers.get(params.worker) : null;
    if (!worker?.stop || params.what !== 'image') return Promise.resolve({ image: null });
    return this.ask(worker, 'image').then((image) => ({ image: image as PausedImage | null }));
  }

  /** Ask a worker, and settle with its answer, or null after `PAUSED_PAGE_WAIT_MS` or when it leaves. */
  /**
   * Ask a worker `what`, its answer or null once `requestMs` passed. With `late`, a request it did not answer in time,
   * or answered `late`, is heard `LATE_ANSWER_MS` more, its next answer going to `late`.
   */
  private ask(
    worker: Worker,
    what: Asked,
    stop?: number,
    extra: RequestExtra = {},
    late?: (value: Answered) => void,
  ): Promise<Answered> {
    const request = ++this.lastRequest;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        worker.requests.delete(request);
        if (late) this.hearLate(worker, request, what, late);
        resolve(null);
      }, this.options.requestMs ?? PAUSED_PAGE_WAIT_MS);
      timer.unref?.();
      worker.requests.set(request, {
        what,
        settle: (value) => {
          clearTimeout(timer);
          if (late && (value as { late?: unknown } | null)?.late === true) this.hearLate(worker, request, what, late);
          resolve(value);
        },
      });
      this.send(worker, requestOf(request, what, stop ?? 0, extra));
    });
  }

  /** A request the worker may still answer, once what it started took effect: `late` hears that answer, if one comes. */
  private hearLate(worker: Worker, request: number, what: Asked, late: (value: Answered) => void): void {
    const timer = setTimeout(() => worker.requests.delete(request), LATE_ANSWER_MS);
    timer.unref?.();
    worker.requests.set(request, {
      what,
      settle: (value) => {
        clearTimeout(timer);
        if (value) late(value);
      },
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
      session.main?.destroy();
      session.main = null;
    }
    this.sessions.clear();
  }

  private read(session: Session, worker: Worker, line: string): void {
    if (session.workers.get(worker.index) !== worker) return;
    const message = parseRunToHub(line);
    if (!message) return;
    switch (message.type) {
      case 'test-begin': {
        const test: RunTest = {
          id: message.testId,
          title: message.title,
          uri: this.uri(worker, message.file, session.root),
          line: message.line - 1,
          project: message.project,
          retry: message.retry,
          cannotPause: message.cannotPause,
        };
        this.hear(session, worker, { type: 'test-begin', test, endsPause: !!message.cannotPause });
        worker.view = null;
        this.options.heard?.(session.ref, worker.index, { type: 'test-begin', test }, session.root);
        return this.changed(session);
      }
      case 'stopped':
        // A failure nobody watches goes on at once, unseen: no client hears of it.
        if (message.reason === 'failure' && !message.bar && (!this.options.answersStops() || !this.watches(session))) {
          return this.send(worker, { type: 'control', action: 'resume', stop: message.stop });
        }
        worker.view = null;
        const stop: HeldStop = {
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
        this.hear(session, worker, { type: 'stopped', stop });
        // The agent drives a stop it asked for, a person the stop their Step or Run to came to; nobody drives any other
        // until someone acts on it.
        worker.driver = worker.askedBy === 'agent' ? AGENT_VIEWER : worker.carried;
        worker.carried = null;
        worker.askedBy = null;
        this.changed(session, true);
        this.options.heard?.(session.ref, worker.index, { type: 'stopped', stop: stop.view }, session.root);
        if (!message.bar && !this.holds(session.ref) && UNASKED_STOPS.has(message.reason)) {
          this.resumeUnattended(session, worker, message.place);
        } else if (!message.bar && !this.options.answersStops()) this.resumeUnanswered(session, worker, message.place);
        return;
      case 'waiting': {
        // Said while a Pause waits for the call, by a reporter that ends a test there; a null title once it waits in
        // none.
        if (message.title === null) {
          if (!worker.waiting) return;
          this.hear(session, worker, { type: 'waiting', call: null });
          return this.changed(session, true);
        }
        if (!worker.pausing || worker.stop || !worker.test || !worker.features.has('give-up')) return;
        const { place, ms } = message;
        const call: RunWaiting = {
          title: message.title,
          uri: place ? this.uri(worker, place.file, session.root) : null,
          line: place ? place.line - 1 : null,
          since: ms === null ? null : new Date(Date.now() - ms).toISOString(),
          endable: message.endable,
        };
        this.hear(session, worker, { type: 'waiting', call });
        return this.changed(session, true);
      }
      case 'running': {
        if (worker.stop?.id !== message.stop) return;
        const since = worker.stop.view.since;
        this.hear(session, worker, { type: 'resumed', stop: message.stop });
        worker.view = null;
        this.changed(session, true);
        return this.options.heard?.(session.ref, worker.index, { type: 'running', since }, session.root);
      }
      case 'test-end':
        this.hear(session, worker, { type: 'test-end', test: message.testId, status: message.status });
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
      case 'lane-frame': {
        // A frame of the worker's lane, for its lane's viewers alone, or why none comes.
        const viewers = session.lanes.get(worker.parallelIndex);
        if (!viewers?.size || !worker.lane) return;
        const since = message.stop !== null && worker.stop?.id === message.stop ? worker.stop.view.since : null;
        const at = { ref: session.ref, lane: worker.parallelIndex, worker: worker.index, since };
        const frame: LaneViewFrame =
          'refused' in message
            ? { ...at, test: message.test, refused: message.refused }
            : { ...at, test: message.test, width: message.width, height: message.height, data: message.data };
        for (const viewer of viewers) viewer.laneFrame?.(frame);
        return;
      }
      case 'lane-layer': {
        // A layer of the worker's lane, for the lane's viewers that asked for it alone.
        const viewers = session.lanes.get(worker.parallelIndex);
        const layered = session.laneLayers.get(worker.parallelIndex);
        if (!viewers?.size || !layered?.size || !worker.lane) return;
        const { type: _type, ...data } = message;
        const layer = { ref: session.ref, lane: worker.parallelIndex, worker: worker.index, ...data } as LaneViewLayer;
        for (const [viewer, layers] of layered) {
          if (layers.has(message.layer) && viewers.has(viewer)) viewer.laneLayer?.(layer);
        }
        return;
      }
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
      case 'acting': {
        // An action that takes Escape as its own runs in the test's window at the stop the worker stands at.
        const stop = worker.stop;
        if (stop?.id !== message.stop || (stop.view.acting ?? null) === message.what) return;
        const { acting: _acting, ...view } = stop.view;
        stop.view = message.what ? { ...view, acting: message.what } : view;
        return this.changed(session, true);
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
      case 'live': {
        const before = worker.live;
        const { type: _type, ...state } = message;
        worker.live = state;
        // A sharing that stopped though nobody asked ends with the run's last streaming worker: said once, where the
        // person shared it, and a worker that connects later no longer shares.
        const streaming = [...session.workers.values()].some((w) => w.live?.on);
        if (session.share && before?.on && !state.on && state.why && !streaming) {
          session.share = false;
          session.stopped = state.why;
          this.options.notice(session.root ?? worker.cwd, 'warning', state.why);
        }
        if (state.on) session.streamed = true;
        // A run of the window's shared runs says so as it is shared.
        if (session.byWindow && state.on && !session.announced) {
          session.announced = true;
          const run = session.page ? `Run #${session.page.id}` : 'This run';
          const where = state.page ? ` on ${instanceOf(state.page)}` : '';
          this.options.notice(
            session.root ?? worker.cwd,
            'information',
            `${run} is shared live${where}, as this window's runs are until you stop sharing them.`,
          );
        }
        return this.changed(session, true);
      }
    }
  }

  /**
   * A stop no one can answer: no pause bar shows it, the client shows no stop, and no Piwi Picker hears the runs. It
   * goes on, said once a run.
   */
  /**
   * A run nobody attends lets a stop no one asked for go on (a breakpoint, a `page.pause()`): said once per run. A Pause,
   * a Step or a Run to someone asked for waits for them.
   */
  private resumeUnattended(session: Session, worker: Worker, place: Place): void {
    this.send(worker, { type: 'control', action: 'resume', stop: worker.stop!.id });
    if (session.resumedSaid) return;
    session.resumedSaid = true;
    this.options.notice(
      session.root ?? worker.cwd,
      'information',
      `Piwi let the test stopped at ${path.basename(place.file)}:${place.line} go on: nobody attends this run.`,
    );
  }

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

  /** What `worker` said of its lane: the lane as it stands after it (`@piwitests/core/live-lane`). */
  private hear(session: Session, worker: Worker, event: HubLaneEvent): void {
    const lanes = session.laneStates;
    const lane =
      lanes.get(worker.parallelIndex) ??
      emptyLane<RunTest, HeldStop, RunWaiting>({ run: session.ref, shard: null, lane: worker.parallelIndex });
    const said: HubLaneEvent = event.type === 'run-end' ? event : { ...event, worker: worker.index };
    lanes.set(worker.parallelIndex, reduceLane(lane, said));
  }

  /**
   * A worker's connection closes, which lets a stop no pause bar shows go on, and its requests are answered with
   * nothing.
   */
  private closeWorker(worker: Worker): void {
    worker.view = null;
    worker.lane = null;
    worker.socket.destroy();
    for (const asked of worker.requests.values()) asked.settle(null);
    worker.requests.clear();
  }

  private detach(session: Session, worker: Worker): void {
    if (session.workers.get(worker.index) !== worker) return;
    this.hear(session, worker, { type: 'left', worker: worker.index });
    session.workers.delete(worker.index);
    this.closeWorker(worker);
    if (session.ended) return;
    this.changed(session, true);
    this.options.heard?.(session.ref, worker.index, { type: 'left' }, session.root);
    if (session.workers.size || (session.main && !session.main.destroyed)) return;
    this.lingerOn(session);
  }

  /** The run ended: the client hears it last, and a later worker of its ref starts a new session. */
  private end(session: Session): void {
    if (session.ended) return;
    session.ended = true;
    this.noteShared(session);
    if (session.linger) clearTimeout(session.linger);
    session.linger = null;
    const workers = [...session.workers.values()];
    session.workers.clear();
    session.lanes.clear();
    session.laneLayers.clear();
    session.main?.destroy();
    session.main = null;
    // A run that ends before its process said how: its command ended, or nothing connected for a while.
    if (session.progress?.status === 'running') session.progress = { ...session.progress, status: 'interrupted' };
    this.endedAtStop.delete(session.ref);
    if (session.progress?.endedAtStop) {
      this.endedAtStop.set(session.ref, session.progress.endedAtStop);
      for (const oldest of this.endedAtStop.keys()) {
        if (this.endedAtStop.size <= MAX_KEPT_RUNS) break;
        this.endedAtStop.delete(oldest);
      }
    }
    for (const worker of workers) this.closeWorker(worker);
    if (this.sessions.get(session.ref) === session) {
      this.sessions.delete(session.ref);
      // A rerun under the ref starts from its own start's Hold failures.
      this.holdsSet.delete(session.ref);
    }
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
    const view: RunSession = {
      ref: session.ref,
      root: session.root,
      workers: [...session.workers.values()]
        .sort((a, b) => a.index - b.index)
        .map((worker) => ({
          worker: worker.index,
          parallelIndex: worker.parallelIndex,
          state: workerState(laneOfWorker(session, worker.index, worker.parallelIndex)),
          test: worker.test,
          stop: worker.stop
            ? {
                ...worker.stop.view,
                ...(worker.driver?.who ? { driver: presenceOf(worker.driver, null) } : {}),
              }
            : null,
          pausing: worker.pausing,
          waiting: worker.waiting,
          takes: [...worker.takes],
          watchable: worker.features.has('view-lane'),
          layers: worker.features.has('view-lane') && worker.features.has('layers'),
          showsWindow: worker.features.has('front'),
          ...(worker.features.has('trace') && session.root !== null && this.opensTraces ? { traces: true } : {}),
          ...watchersField(this.watchersOf(session, worker, null)),
        })),
      ended: session.ended,
      ...(session.terminal ? { terminal: true } : {}),
      ...(session.runner ? { runner: true } : {}),
    };
    const live = this.liveOf(session);
    if (live) view.live = live;
    if (session.progress) view.progress = { ...session.progress };
    if (session.page) view.page = { ...session.page };
    if (this.holds(session.ref)) view.hold = { ...this.holdOf(session.ref) };
    const presence = this.presenceIn(session, null);
    if (presence.length) view.presence = presence;
    return view;
  }

  private flush(session: Session): void {
    if (session.paced) clearTimeout(session.paced);
    session.paced = null;
    const view = this.view(session);
    const text = JSON.stringify(view);
    const present = this.presentKey(session);
    const moved = present !== session.present;
    session.present = present;
    if (text === session.sent) {
      if (moved) this.options.presenceChanged?.(view);
      return;
    }
    session.heard = view;
    session.sent = text;
    session.sentAt = Date.now();
    this.options.notify(view);
  }

  private send(worker: Worker, message: HubToRun): void {
    if (!worker.socket.destroyed) worker.socket.write(`${JSON.stringify(message)}\n`);
  }

  private sendBreakpoints(
    worker: Worker,
    ref: string,
    files: Array<{ file: string; line: number }>,
    root: string | null,
  ): void {
    const places = new Map<string, Place>();
    const texts = new Map<string, string | null>();
    for (const { file, line } of files) {
      const relative = this.relative(worker, file, root);
      if (!relative) continue;
      if (!texts.has(file)) texts.set(file, this.options.runText?.(ref, file) ?? null);
      const text = texts.get(file);
      for (const at of text ? breakpointLines(text, line) : [line]) {
        places.set(`${relative}:${at}`, { file: relative, line: at + 1 });
      }
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

/** The lane `parallelIndex` of a run as it stands while the worker `index` is its worker; null otherwise. */
function laneOfWorker(session: Session, index: number, parallelIndex: number): HubLane | null {
  const lane = session.laneStates.get(parallelIndex);
  return lane?.worker === index ? lane : null;
}

/** A lane's state as a worker of the session says it: `running` while a Pause waits for its test too. */
function workerState(lane: HubLane | null): RunSession['workers'][number]['state'] {
  if (lane?.state === 'stopped') return 'stopped';
  return lane?.test ? 'running' : 'between';
}

/** The origin of a run's page on its instance, which names the instance: its URL as given when it does not read. */
function pageOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
