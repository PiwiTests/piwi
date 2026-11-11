/**
 * The hub's WebSocket: how Piwi Picker follows and steers the runs an editor service started. Each service listens
 * on `127.0.0.1` alone, on a free port, and names the address and a token in its discovery file
 * (`@piwitests/core/editor-discovery`); the editor's Send to editor endpoint hands them to the paired extension
 * (`GET /piwi/live`, `GET /api/piwi/live`: `LiveAnswer`). The hub takes a handshake only with its own `Host`
 * (`127.0.0.1:<port>` or `localhost:<port>`) and an extension's `Origin` (`chrome-extension://<id>`,
 * `moz-extension://<uuid>`); the first message must be `hello` with the token, within `HUB_HELLO_MS`. Every later
 * message is a command with an `id`, answered once with that `id` (`HubAnswer`); `subscribe` has the hub push each run
 * as it changes (`HubSessionMessage`), what each action that writes code at a stop came to, whichever surface
 * started it (`HubCodeMessage`: its sentence, never the code), and the other live hubs of the machine as they come and
 * go (`HubPeersMessage`: their addresses, never their tokens); `welcome` and the desktop app's live answer list what
 * the hub does beyond every hub (`features`); `follow` says whether a person watches the runs there (a Runs window
 * is open), which holds nothing; `hold` turns a run's **Hold failures** on or off, whichever surface asks; `view` has
 * it push the frames of a stopped page's
 * live view to that connection alone (`HubFrameMessage`), and `input` plays the connection's input on the page it
 * views; `share` shares a run live on the team instance its reporter reports to (**Share live**), or stops, as a person
 * asks. The hub sends `keepalive` every `HUB_KEEPALIVE_MS`, and a frame longer than `MAX_HUB_FRAME` closes the
 * connection. Messages are text frames of JSON, checked field by field on both sides. Nothing a command asks evaluates
 * code, reads a file or reaches an instance.
 */
import type { EditorDiscovery, HubAddress } from './editor-discovery';
import {
  MAX_RUN_FAILURE_TEXT,
  MAX_STOP_ERROR,
  readRunPage,
  type KeptRequest,
  type RunCounts,
  type RunEndStatus,
  type RunPage,
} from './run-channel';
import { isViewFrameData, isViewPoint, isViewSize, readViewInput, type ViewInput } from './run-view';

/** The WebSocket's path. */
export const HUB_PATH = '/piwi/hub';
/** How often the hub sends `keepalive`: within the 30 s an MV3 worker stays alive after a WebSocket message. */
export const HUB_KEEPALIVE_MS = 20_000;
/** How long the hub waits for `hello`. */
export const HUB_HELLO_MS = 5_000;
/** The longest frame the hub reads, in bytes: a longer one closes the connection (1009). */
export const MAX_HUB_FRAME = 64 * 1024;
/** The commands a connection may have waiting for their answer at once: one more is refused. */
export const MAX_HUB_PENDING = 16;
/** The longest command line a `session` carries: the hub cuts a longer one, marking the cut. */
export const MAX_HUB_COMMAND = 20_000;
/** The most workspace folders a `welcome` names: the hub names the first ones. */
export const MAX_HUB_ROOTS = 64;
/** The longest Piwi project name a `session` carries: the hub cuts a longer one. */
export const MAX_HUB_PROJECT = 500;
/** The longest client name a `welcome` carries: the hub cuts a longer one. */
export const MAX_HUB_CLIENT = 200;
/** The longest sentence an answer or a `code` carries: the hub cuts a longer one. */
export const MAX_HUB_MESSAGE = 1000;
/** The most warnings a `code` carries: the hub sends the first ones. */
export const MAX_HUB_WARNINGS = 16;
/** The most hubs a `peers` names: the hub names the first ones. */
export const MAX_HUB_PEERS = 64;
/** The most tools a run's or a worker's presence names: the hub names the first ones. */
export const MAX_HUB_PRESENCE = 16;

/**
 * What a hub does beyond what every hub does, as `welcome` and the desktop app's live answer list it: it names the
 * other live hubs of the machine as they come and go (`peers`), shows a lane of a run while it runs (`lanes`: the
 * command `watch`, its frames `lane-frame`), keeps **Hold failures** for each run (`hold`: the command `hold`, the
 * session's `hold`), says who is present on each run, lane and stop, one driving a stop at a time (`presence`: the
 * command `drive`, the session's `presence`, a worker's `watchers`, a stop's `driver`), and stops a whole run the way the
 * tool that started it does (`stop`: the command `stop`, for a run `canStopRun` names). A reader keeps those it knows; a
 * hub that predates the list does none of them, and a hub whose host cannot stop its runs leaves `stop` out.
 */
export type HubFeature = 'peers' | 'lanes' | 'hold' | 'presence' | 'stop';

/** The features of a hub of this version whose host can stop its runs. */
export const HUB_FEATURES: readonly HubFeature[] = ['peers', 'lanes', 'hold', 'presence', 'stop'];

/**
 * Whether a hub with the `stop` feature can stop a run: one still live that its host started, never one whose own
 * process said it ended (`progress.status`), nor one started in a terminal (`terminal`, an editor's test runner's run
 * included), whose Stop stays where it was started.
 */
export function canStopRun(session: Pick<HubSession, 'ended' | 'terminal' | 'progress'>): boolean {
  return !session.ended && !session.terminal && (session.progress?.status ?? 'running') === 'running';
}

/**
 * What a tool present on a run is: a Runs window of Piwi Picker (`picker`), an editor (`editor`), the desktop app's
 * window (`desktop`), or an agent through a hub's MCP tools (`agent`); `other` for a kind of a newer hub.
 */
export type HubPresenceKind = 'picker' | 'editor' | 'desktop' | 'agent' | 'other';

const PRESENCE_KINDS: readonly HubPresenceKind[] = ['picker', 'editor', 'desktop', 'agent'];

/**
 * A tool present on a run, a lane or a stop: its kind, its name as the hub knows it (`Visual Studio Code`, at most
 * `MAX_HUB_CLIENT` characters), and `self` when it is the connection that hears it.
 */
export interface HubPresence {
  kind: HubPresenceKind;
  name: string;
  self?: true;
}

/**
 * Who set a run's **Hold failures** last: the run's own start (`start`: a run built to be watched, a debug run, a
 * reproduction), a person on a surface (`person`), or an agent (`agent`).
 */
export type HubHoldBy = 'start' | 'person' | 'agent';

/** Whether a failure no pause bar shows waits at its line in a run (`on`), and who said so last (`by`). */
export interface HubHold {
  on: boolean;
  by: HubHoldBy;
}

const HOLD_BY: readonly HubHoldBy[] = ['start', 'person', 'agent'];

/** Why the hub closed a connection, as the WebSocket's close code. */
export const HUB_CLOSE = {
  /** The service stops. */
  goingAway: 1001,
  /** A binary frame. */
  unsupported: 1003,
  /** A frame longer than `MAX_HUB_FRAME`. */
  tooBig: 1009,
  /** The first message was not `hello` with the hub's token. */
  unauthorized: 4001,
  /** No `hello` within `HUB_HELLO_MS`. */
  helloTimeout: 4002,
  /** A message that is no command: not JSON, not an object, or without an `id`. */
  malformed: 4003,
} as const;

/**
 * Why a test stopped (`RunStopReason` in the editor's protocol): `failure`, the test failed and its page is held at
 * the failing line, where Resume lets it end as it failed; `other` for a reason of a newer reporter.
 */
export type HubStopReason = 'breakpoint' | 'step' | 'pause' | 'run-to' | 'page-pause' | 'failure' | 'other';

/** Where a worker stands stopped: before a call, which runs as soon as the stop is answered. */
export interface HubStop {
  reason: HubStopReason;
  /** The call about to run, as Playwright titles it: `Click getByRole('button', { name: 'Pay' })`. */
  title: string;
  /** The file of the call's line, a spec or a page object, as a `file:` URI, and the 0-based line and character. */
  uri: string;
  line: number;
  character: number | null;
  /** The locator the call acts on, as source; null for none. */
  locator: string | null;
  /** Whether Piwi's pause bar shows in the test's window: false in a headless run, where Pick and Record need one. */
  bar: boolean;
  /** Names the stop: a control passes it back as `since`, and one that no worker stands at any more is refused. */
  since: string;
  /**
   * What this stop takes now from the connection that hears it, of its worker's `intents`: the input on the view only
   * while this connection watches the stop's live view (`view`); at a stop the pause bar shows, all the others; at one
   * it does not (a headless run), Pick, Record, Assert and Assert a region only while it watches too, driven through
   * that view. Following the runs (`follow`) grants none of them. Absent from a service that predates it, where those
   * need the bar.
   */
  intents?: HubAction[];
  /**
   * A failure's error: the failing error's first lines as plain text, at most `MAX_STOP_ERROR` characters. Absent for
   * another stop, and from a service or a reporter that predates it, whose `title` alone says how the test failed.
   */
  error?: string;
  /** `agent` for a stop an agent asked for through a host's MCP tools (its Pause, Step or Run to); absent otherwise. */
  by?: 'agent';
  /**
   * Who drives the stop now, one at a time: the agent that asked for it or acted on its page, or the tool whose person
   * took it (a click, a key or text on its view, a pick, an intent, or `drive`), which takes it from the agent. An
   * agent's actions there are refused while a person drives. Absent while nobody drives, and from a hub without
   * `presence`.
   */
  driver?: HubPresence;
}

/** A test a worker runs. */
export interface HubTest {
  /** Playwright's id of the test. */
  id: string;
  /** Its `test.describe` blocks' titles, then its own. */
  title: string[];
  /** Its spec as a `file:` URI, and the 0-based line of its `test(…)` call. */
  uri: string;
  line: number;
  /** Its Playwright project; empty for a config without projects. */
  project: string;
  /** 0 on its first attempt. */
  retry: number;
  /** Why it never stops; null when it can. */
  cannotPause: string | null;
}

/** What a stop of a worker can start from outside the page, in the test's window: the pause bar's Pick a locator and Record here. */
export type HubIntent = 'pick' | 'record';

/**
 * What a stop of a worker can start in the test's window for the editor to write: the check panel's Check an element
 * (`assert`) and a region's ARIA snapshot (`assert-region`).
 */
export type HubCodeIntent = 'assert' | 'assert-region';

/**
 * What a stop can do for a viewer outside the page: show its live view (`view`), play the viewer's input on it
 * (`input`), the click count of a button's `down` and `up` included (`input-clicks`: a double click goes as the
 * browser counted it, at once, where a stop without it takes a held `click` of `clickCount` 2), and send the locator of
 * the element under a point of an image of it where a pick goes (`pick-at`).
 */
export type HubViewAction = 'view' | 'input' | 'input-clicks' | 'pick-at';

/** What a stop its pause bar shows can do for a viewer elsewhere: bring the test's window to the front (`front`). */
export type HubWindowAction = 'front';

/**
 * What a stop can take from the Runs page: the intents, Mock a request (`mock`, with the `requests` it lists), the
 * live view's actions, Show the browser (`front`) at a stop its pause bar shows, and End the test (`end`, the `runControl` that skips the rest of the test), which a stop at a
 * failure leaves out: Resume ends it as it failed. `watch` is the worker's, stopped or not: its lane can be watched
 * while it runs (`watch`, at a hub whose features list `lanes`); `give-up` too, while a Pause waits for the call its
 * test runs: End the test there (`runControl` `give-up`).
 */
export type HubAction =
  | HubIntent
  | HubCodeIntent
  | 'mock'
  | HubViewAction
  | HubWindowAction
  | 'end'
  | 'watch'
  | 'give-up';

/**
 * The actions that write code at a stop, in the editor: the intents', Mock a request, and an agent's (the editor's MCP
 * server): the steps it took on the stopped page (`steps`) and a locator in place of the stopped line's (`locator`).
 */
export type HubCodeAction = HubCodeIntent | 'mock' | 'steps' | 'locator';

const HUB_CODE_ACTIONS: readonly string[] = ['assert', 'assert-region', 'mock', 'steps', 'locator'];

const HUB_INTENTS: readonly string[] = ['pick', 'record', 'assert', 'assert-region'];

/** The actions this version knows, in the order a worker's `intents` lists them. */
export const HUB_ACTIONS: readonly HubAction[] = [
  'pick',
  'record',
  'assert',
  'assert-region',
  'mock',
  'view',
  'input',
  'input-clicks',
  'pick-at',
  'front',
  'end',
  'watch',
  'give-up',
];

/**
 * A response the stopped test's pages received for a fetch or an XHR request, whose text body the worker keeps for
 * Mock a request: no header, no body.
 */
export type HubKeptRequest = KeptRequest;

/** A worker of a run. */
export interface HubWorker {
  /** Playwright's worker index, which the commands name. */
  worker: number;
  parallelIndex: number;
  /** `other` for a state of a newer service, which a reader shows as running. */
  state: 'running' | 'stopped' | 'between' | 'other';
  test: HubTest | null;
  stop: HubStop | null;
  /** A Pause reached it and it has not stopped yet. */
  pausing: boolean;
  /**
   * While pausing, the call its test waits in before it can stop, as its reporter says it; absent otherwise, and from
   * a service or a reporter that predates it.
   */
  waiting?: HubWaiting;
  /**
   * The actions its reporter takes, Assert, Assert a region and Mock a request only while the editor writes the code
   * from a stop: none for a reporter that predates them, whose stops every action is refused at.
   */
  intents: HubAction[];
  /**
   * The tools that watch its page now, its lane's view or its stop's, each connection once: absent while none does,
   * and from a hub without `presence`.
   */
  watchers?: HubPresence[];
}

/**
 * The call a pausing worker's test waits in: its title (`Click getByRole('button', { name: 'Pay' })`), its file as a
 * `file:` URI and 0-based line (null when the worker names none), when it began by the hub's clock (`since`, ISO 8601;
 * null when the worker cannot tell), and whether End the test gives it up (`endable`), else lets it finish first.
 */
export interface HubWaiting {
  title: string;
  uri: string | null;
  line: number | null;
  since: string | null;
  endable: boolean;
}

/**
 * How a run stands on the team instance's live view (**Share live**): whether it is shared now, why it cannot be, why
 * its sharing stopped though nobody asked, its page on the instance for a teammate to open, and how many views of its
 * workers are open there.
 */
export interface HubLive {
  shared: boolean;
  /** One sentence; null when the run can be shared. At most `MAX_HUB_MESSAGE` characters. */
  refused: string | null;
  /** One sentence, until a person shares the run again or stops it; null otherwise (and from an older hub). */
  stopped: string | null;
  /** The run's page on the instance (`<instance>/test-runs/<id>`); null when the run holds no key. */
  page: string | null;
  viewers: number;
}

/** A run the editor started, with its workers. */
export interface HubSession {
  /** The ref of the command that started it: the commands name the run by it. */
  ref: string;
  /** The folder of the run's Playwright config, absolute; null when no config of the workspace holds it. */
  root: string | null;
  /** That folder as the editor names it (`shop`, `shop/e2e`); null without one. */
  label: string | null;
  /** The command the editor ran (`npx playwright test tests/cart.spec.ts:3 --headed`); null when it does not know. */
  command: string | null;
  /** The name of the Piwi project the folder reads; null without one. */
  project: string | null;
  /** Its workers connected now; none for a moment while Playwright starts a new one. */
  workers: HubWorker[];
  /** The run ended: its last message. A later run of the same ref is a new session. */
  ended: boolean;
  /**
   * The run was started in a terminal, not by the editor: it found the editor through its discovery file, and its
   * `command` is null. Absent from a service that predates it, and for a run the editor started.
   */
  terminal?: boolean;
  /**
   * Of the runs `terminal` names, one the editor's own test runner started (a JetBrains IDE's Playwright run
   * configuration, its gutter's Run included) rather than a terminal. Absent otherwise, and from a service or a
   * reporter that predates it.
   */
  runner?: boolean;
  /**
   * How the run stands on the team instance's live view, for a run whose reporter shares it: absent from a service
   * or a reporter that predates **Share live**.
   */
  live?: HubLive;
  /**
   * How far the run is, as its own process says (`run-begin`, `run-progress`, `run-end` of
   * `@piwitests/core/run-channel`): absent from a service or a reporter that predates it.
   */
  progress?: HubProgress;
  /**
   * The run's page on the instance it reports to, its number and address, once its own process knows it (`run-page`):
   * absent before, for a run that reports to none, and from a service or a reporter that predates it.
   */
  page?: RunPage;
  /**
   * Whether a failure no pause bar shows waits at its line in this run (**Hold failures**), and who said so: absent
   * for a run nobody attends, whose failures always go on at once, and from a hub without the `hold` feature, whose
   * failures wait while a Runs window follows the runs.
   */
  hold?: HubHold;
  /**
   * The tools that have the run open, beyond the hub's own editor: each Runs window that follows the runs, the desktop
   * app's window, and an agent that follows this run. Absent while none does, and from a hub without `presence`.
   */
  presence?: HubPresence[];
}

/**
 * How far a run is: how many tests it holds (`total`), how many ended and with what outcome (`RunCounts`), whether it
 * still runs or how it ended (`status`), and its first failure, once it ended (the test's title and its error's first
 * line, null for none).
 */
export interface HubProgress extends RunCounts {
  total: number;
  status: 'running' | RunEndStatus;
  failure: { title: string; error: string | null } | null;
}

/**
 * An image of a stopped page: a JPEG, base64, and the page's viewport in CSS pixels (`width`, `height`), which
 * `pick-at` names its point in; absent from a reporter that predates them.
 */
export interface HubImage {
  mime: 'image/jpeg';
  data: string;
  width?: number;
  height?: number;
}

/**
 * The controls the extension sends; Run to a line stays in the editor, which has the file. `end` ends the test at the
 * stop, for a worker whose `intents` list it; `give-up` ends it while a Pause waits for its call, for a pausing worker
 * whose `intents` list it, naming no stop.
 */
export type HubControlAction = 'pause' | 'step' | 'resume' | 'finish' | 'end' | 'give-up';

/** The first message: the token of the hub's discovery file. */
export interface HubHello {
  type: 'hello';
  token: string;
}

/** A command, after `hello`: `id` (1 to 2147483647) names its answer. */
export type HubCommand =
  /** Hear every run of the editor: one `session` for each live now, after the answer, then each change. */
  | { type: 'subscribe'; id: number }
  /**
   * Whether a person watches the runs through this connection now (`on`): a Runs window is open, which each run names
   * in its `presence` (a hub with the `presence` feature). It holds no failure: a hub with the `hold` feature holds
   * them by each run's **Hold failures** (`hold`), whoever watches.
   */
  | { type: 'follow'; id: number; on: boolean }
  /**
   * Turn the run's **Hold failures** on (`on`: a failure no pause bar shows waits at its line for an answer) or off
   * (it goes on at once, one held now included), as a person asks on a surface. Refused for a run nobody attends.
   */
  | { type: 'hold'; id: number; ref: string; on: boolean }
  /**
   * Stop the whole run, as the tool that started it stops it (an editor's task or process, the desktop app's run): its
   * tests end now, and its last message follows. A hub with the `stop` feature; refused for a run `canStopRun` leaves
   * out.
   */
  | { type: 'stop'; id: number; ref: string }
  /**
   * At the stop `since` names (of the one stopped worker, or `worker`), drive it (`on`: an agent's actions there are
   * refused until this connection gives it back), or give it back (an agent may act again). Driving takes it from an
   * agent, which hears so; the input, a pick and an intent this connection sends there drive it too.
   */
  | { type: 'drive'; id: number; ref: string; worker: number | null; since: string; on: boolean }
  /**
   * Steer a run, as `piwi/runControl` does: `pause` every running worker (or `worker`), or answer the stop of the one
   * stopped (`worker`, needed when several are): `step`, `resume`, `finish`, `end`. `since` names the stop the
   * extension showed, and these need it: one that went on is refused (`The test went on.`), so a click twice does not
   * skip the next stop. `pause` takes none.
   */
  | {
      type: 'runControl';
      id: number;
      ref: string;
      worker: number | null;
      action: HubControlAction;
      since: string | null;
    }
  /** An image of a stopped worker's page, without the pause bar: the answer's `image`. */
  | { type: 'pausedPage'; id: number; ref: string; worker: number }
  /**
   * At the stop `since` names (of the one stopped worker, or `worker`), start an intent in the test's window: the
   * picked locator goes to the editor in place of the locator on the stopped line (`pick`), the recorded steps above
   * that line (`record`), and so does the check the person makes with the check panel (`assert`) or the ARIA snapshot
   * of the region they pick (`assert-region`), written by the editor, never sent here. Refused at a stop no pause bar
   * shows (a headless run), at a stop the test went on from, and, for `assert` and `assert-region`, when the editor
   * cannot write code from a stop.
   */
  | { type: HubIntent | HubCodeIntent; id: number; ref: string; worker: number | null; since: string }
  /**
   * At the stop `since` names, bring the test's window to the front (**Show the browser**). Refused at a stop no pause
   * bar shows (a headless run), at a stop the test went on from, and for a reporter that does not take it.
   */
  | { type: HubWindowAction; id: number; ref: string; worker: number | null; since: string }
  /** The responses the test kept as it stood at the stop `since` names: the answer's `requests`. */
  | { type: 'requests'; id: number; ref: string; worker: number | null; since: string }
  /**
   * At the stop `since` names, Mock a request: the kept response `request` (a `HubKeptRequest`'s `id`) becomes
   * `await page.route(…)` written by the editor above the stopped line; the code never comes here.
   */
  | { type: 'mock'; id: number; ref: string; worker: number | null; since: string; request: number }
  /**
   * At the stop `since` names, start (`on`) or stop watching its page's live view: the frames come to this connection
   * alone (`HubFrameMessage`) until it stops watching, the stop ends or the connection closes. Several connections
   * may watch one stop.
   */
  | { type: 'view'; id: number; ref: string; worker: number | null; since: string; on: boolean }
  /**
   * At the stop `since` names, while this connection watches its live view: play the events on its page, in order, as
   * a person's input, at most `MAX_VIEW_EVENTS` a message and `MAX_VIEW_EVENT_RATE` a second.
   */
  | { type: 'input'; id: number; ref: string; worker: number | null; since: string; events: ViewInput[] }
  /**
   * At the stop `since` names: the element under the point `x`, `y` of any image of its page (CSS pixels of its
   * viewport, as the image's `width` and `height` name it), its locator sent to the editor where a pick goes, in
   * place of the locator on the stopped line; the answer's `locator`.
   */
  | { type: 'pick-at'; id: number; ref: string; worker: number | null; since: string; x: number; y: number }
  /**
   * Share the run live on the team instance its reporter reports to (`on`), for whoever may open it there, or stop
   * sharing it: a person's own choice, asked after the surface's warning. Refused, with why, for a run that cannot be
   * shared.
   */
  | { type: 'share'; id: number; ref: string; on: boolean }
  /**
   * Start (`on`) or stop watching the lane `lane` (Playwright's `parallelIndex`) of the run: the page of its running
   * test, of its stop while it stands at one, through its tests, its stops and a worker Playwright starts in its place,
   * its frames coming to this connection alone (`HubLaneFrameMessage`) until it stops watching, the run ends or the
   * connection closes. Refused for a lane whose worker's `intents` lack `watch`, saying why. At a stop the frames
   * show, input, `pick-at` and the actions a viewer may start are this connection's as with `view`.
   */
  | { type: 'watch'; id: number; ref: string; lane: number; on: boolean };

/** What `parseHubCommand` reads: a command, or one answered as refused. */
export type ParsedHubCommand =
  | HubCommand
  /** A command of a type this version does not know. */
  | { type: 'unknown'; id: number; what: string }
  /** A command of a known type with a field it cannot take, and why. */
  | { type: 'invalid'; id: number; message: string };

/** The answer to a command: whether it was done, or why not, in one sentence a person can read. */
export interface HubAnswer {
  type: 'answer';
  id: number;
  ok: boolean;
  message: string;
  /** For `pausedPage`: the image, null when there is none. */
  image?: HubImage | null;
  /** For `requests`: the responses the test kept, oldest first; empty when it was refused. */
  requests?: HubKeptRequest[];
  /** For `pick-at`: the locator sent to the editor, null when none was found. */
  locator?: string | null;
  /** For `pick-at`: whether an editor took the locator; absent when the run's reporter does not say. */
  taken?: boolean;
}

/** Sent once `hello` was accepted: the service the connection reached. */
export interface HubWelcome {
  type: 'welcome';
  pid: number;
  version: string;
  client: string | null;
  roots: string[];
  keepaliveMs: number;
  /** What it does beyond every hub; read as none from a hub that predates the list. */
  features: HubFeature[];
}

/** A run that changed, or every run live as `subscribe` is answered. */
export interface HubSessionMessage {
  type: 'session';
  session: HubSession;
}

/**
 * What an action that writes code at a stop came to, sent to every subscribed connection once, whichever surface
 * started it (the editor or a Runs page): the code was sent to the editor to write (`ok`, its sentence, such as `Piwi
 * sent the check to Visual Studio Code to write above checkout.spec.ts:5.`, and what to check in it, `warnings`; the
 * editor, which can still refuse the write, says itself whether it wrote it), or the action was refused once it had
 * started (`ok: false`, why: the check could not be written, the region picked brought no snapshot). The stop is the
 * one `since` names, of the worker `worker`; a page shows it while that worker stands there. The code itself never
 * comes.
 */
export interface HubCodeMessage {
  type: 'code';
  ref: string;
  worker: number;
  since: string;
  action: HubCodeAction;
  ok: boolean;
  message: string;
  /** At most `MAX_HUB_WARNINGS`; absent for none. */
  warnings?: string[];
}

/**
 * A frame of the live view of the stop `since` names, of the worker `worker`, sent only to a connection that watches
 * it (`view`): a JPEG as the page painted it, base64, and the page's viewport in CSS pixels (`width`, `height`), which
 * `input` and `pick-at` name their points in. At most `MAX_VIEW_FPS` a second; a connection whose socket is backed up
 * gets the latest frame once it is not, the others dropped. The hub keeps none.
 */
export interface HubFrameMessage {
  type: 'frame';
  ref: string;
  worker: number;
  since: string;
  width: number;
  height: number;
  data: string;
}

/**
 * The live view of the stop `since` names, of the worker `worker`, sends no frame now, and why (`refused`, at most
 * `MAX_HUB_MESSAGE` characters): each image of the page is too long, a lighter one included. It goes as a frame does,
 * to a connection that watches the stop, once until a frame comes again; a side that predates it reads none.
 */
export interface HubFrameRefusal {
  type: 'frame';
  ref: string;
  worker: number;
  since: string;
  refused: string;
}

/**
 * A frame of the lane `lane` of the run, while this connection watches it (`watch`), as `frame` carries one: the page of
 * the worker `worker` at the stop `since` names, null while the test it shows (`test`, Playwright's id) runs. At most
 * `MAX_VIEW_FPS` a second, the latest alone while the connection is backed up; the hub keeps none.
 */
export interface HubLaneFrameMessage {
  type: 'lane-frame';
  ref: string;
  lane: number;
  worker: number;
  test: string;
  since: string | null;
  width: number;
  height: number;
  data: string;
}

/**
 * The lane `lane` sends no frame now, and why (`refused`, at most `MAX_HUB_MESSAGE` characters): each image of the page
 * is too long, or masks the reporter cannot read hide it. Sent once until a frame comes again.
 */
export interface HubLaneFrameRefusal {
  type: 'lane-frame';
  ref: string;
  lane: number;
  worker: number;
  test: string | null;
  since: string | null;
  refused: string;
}

/** A live hub as another one names it (`peers`): where it listens and whose it is, never its token. */
export type PeerHub = Omit<LiveHub, 'token' | 'features'>;

/**
 * The other live hubs of the machine, as the hub reads them from the editors' discovery folder: sent to a subscribed
 * connection after the runs `subscribe` answers with, then each time the list changes, the whole list each time. A
 * client that holds no token for one asks the editor's `GET …/live` again, which names it with its token.
 */
export interface HubPeersMessage {
  type: 'peers';
  hubs: PeerHub[];
}

/** What the hub sends. */
export type HubMessage =
  | HubWelcome
  | HubAnswer
  | HubSessionMessage
  | HubCodeMessage
  | HubFrameMessage
  | HubFrameRefusal
  | HubLaneFrameMessage
  | HubLaneFrameRefusal
  | HubPeersMessage
  | { type: 'keepalive' };

/** A live hub, as the Send to editor endpoint's `GET …/live` lists it. */
export interface LiveHub extends HubAddress {
  pid: number;
  version: string;
  client: string | null;
  roots: string[];
  startedAt: string;
  /** What it does beyond every hub, where the answer says (the desktop app's); a hub's `welcome` says it too. */
  features?: HubFeature[];
}

/** The body of `GET /piwi/live` and `GET /api/piwi/live`. */
export interface LiveAnswer {
  hubs: LiveHub[];
}

/** The hubs of the live services' discovery files (`readLiveEditors`), as `GET …/live` lists them. */
export function liveHubsOf(editors: readonly EditorDiscovery[]): LiveHub[] {
  return editors.flatMap((editor) =>
    editor.hub
      ? [
          {
            url: editor.hub.url,
            token: editor.hub.token,
            pid: editor.pid,
            version: editor.version,
            client: editor.client,
            roots: editor.roots,
            startedAt: editor.startedAt,
          },
        ]
      : [],
  );
}

/** The hubs a hub names to its clients as its peers: the others, without their tokens, at most `MAX_HUB_PEERS`. */
export function hubPeersOf(hubs: readonly LiveHub[], self: string): PeerHub[] {
  return hubs
    .filter((hub) => hub.url !== self)
    .slice(0, MAX_HUB_PEERS)
    .map(({ url, pid, version, client, roots, startedAt }) => ({
      url,
      pid,
      version,
      client: cutName(client),
      roots: roots.slice(0, MAX_HUB_ROOTS),
      startedAt,
    }));
}

/** A client name cut to `MAX_HUB_CLIENT`. */
function cutName(client: string | null): string | null {
  return client === null || client.length <= MAX_HUB_CLIENT ? client : client.slice(0, MAX_HUB_CLIENT);
}

/** The live endpoint beside a Send to editor endpoint: `…/piwi/send` → `…/piwi/live`; null for another address. */
export function liveUrlOf(sendUrl: string): string | null {
  return sendUrl.endsWith('/send') ? `${sendUrl.slice(0, -'/send'.length)}/live` : null;
}

/** A hub's address as `GET …/live` lists it: a loopback name, the port, the path. */
const HUB_URL = /^ws:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})(\/[\w/-]{0,64})$/;

const CHROME_EXTENSION = /^chrome-extension:\/\/[a-p]{32}$/;
const FIREFOX_EXTENSION = /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether an `Origin` is a browser extension's: Chrome's and Edge's ids, Firefox's per-install UUIDs; never a page's. */
export function isExtensionOrigin(origin: string | null | undefined): boolean {
  return typeof origin === 'string' && (CHROME_EXTENSION.test(origin) || FIREFOX_EXTENSION.test(origin));
}

/** The most ports an editor names as forwarded to one listener: a remote window forwards it once. */
export const MAX_FORWARDED_PORTS = 8;

/**
 * The port a request's `Host` names the listener at: `127.0.0.1` or `localhost` with the port it listens on, or with
 * one of the ports the editor forwards to it (`forwarded`: a remote window's, where the browser's machine reaches it);
 * null for any other name, a page under another name (DNS rebinding) included.
 */
export function hubHostPort(
  host: string | null | undefined,
  port: number,
  forwarded: readonly number[] = [],
): number | null {
  if (typeof host !== 'string') return null;
  const match = /^(?:127\.0\.0\.1|localhost):([1-9]\d{0,4})$/.exec(host.toLowerCase());
  const named = match ? Number(match[1]) : null;
  return named !== null && (named === port || forwarded.includes(named)) ? named : null;
}

/** Whether a handshake's `Host` names the hub itself, at its port or one forwarded to it (`hubHostPort`). */
export function isHubHost(host: string | null | undefined, port: number, forwarded: readonly number[] = []): boolean {
  return hubHostPort(host, port, forwarded) !== null;
}

/** The ports a client names as forwarded to a listener, those that are ports, at most `MAX_FORWARDED_PORTS`. */
export function forwardedPorts(ports: unknown): number[] {
  if (!Array.isArray(ports)) return [];
  const valid = ports.filter((p): p is number => isInt(p, 1, 65_535));
  return [...new Set(valid)].slice(0, MAX_FORWARDED_PORTS);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isInt(value: unknown, min: number, max = 2_147_483_647): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

const REF = /^[\w-]{1,64}$/;
const ACTIONS: readonly string[] = ['pause', 'step', 'resume', 'finish', 'end', 'give-up'];
/** Why a command that answers a stop and names none is refused. */
const NEEDS_STOP = 'The command needs the stop it answers.';

/** The token of a `hello`; null for any other message. */
export function parseHubHello(text: string): string | null {
  const value = readJson(text);
  return value?.type === 'hello' && typeof value.token === 'string' && value.token.length <= 256 ? value.token : null;
}

/** A message after `hello`, checked field by field; null for one that is no command (it closes the connection). */
export function parseHubCommand(text: string): ParsedHubCommand | null {
  const value = readJson(text);
  if (!value || !isInt(value.id, 1)) return null;
  const { id } = value;
  const invalid = (message: string): ParsedHubCommand => ({ type: 'invalid', id, message });
  if (typeof value.type !== 'string' || !value.type) return invalid('A command needs a type.');
  if (value.type === 'subscribe') return { type: 'subscribe', id };
  if (value.type === 'follow') {
    return typeof value.on === 'boolean' ? { type: 'follow', id, on: value.on } : invalid('on must be true or false.');
  }
  if (value.type === 'hold') {
    if (typeof value.ref !== 'string' || !REF.test(value.ref)) return invalid('The command needs the ref of a run.');
    return typeof value.on === 'boolean'
      ? { type: 'hold', id, ref: value.ref, on: value.on }
      : invalid('hold needs on: true to hold the failures, false to let them go on.');
  }
  if (value.type === 'stop') {
    if (typeof value.ref !== 'string' || !REF.test(value.ref)) return invalid('The command needs the ref of a run.');
    return { type: 'stop', id, ref: value.ref };
  }
  if (value.type === 'share') {
    if (typeof value.ref !== 'string' || !REF.test(value.ref)) return invalid('The command needs the ref of a run.');
    return typeof value.on === 'boolean'
      ? { type: 'share', id, ref: value.ref, on: value.on }
      : invalid('share needs on: true to share the run live, false to stop.');
  }
  if (value.type === 'watch') {
    if (typeof value.ref !== 'string' || !REF.test(value.ref)) return invalid('The command needs the ref of a run.');
    if (!isInt(value.lane, 0)) return invalid('watch needs the lane: a parallelIndex, from 0.');
    return typeof value.on === 'boolean'
      ? { type: 'watch', id, ref: value.ref, lane: value.lane, on: value.on }
      : invalid('watch needs on: true to watch the lane, false to stop watching it.');
  }
  if (
    ![
      'runControl',
      'pausedPage',
      'requests',
      'mock',
      'view',
      'input',
      'pick-at',
      'drive',
      'front',
      ...HUB_INTENTS,
    ].includes(value.type)
  ) {
    return { type: 'unknown', id, what: value.type.slice(0, 64) };
  }
  if (typeof value.ref !== 'string' || !REF.test(value.ref)) return invalid('The command needs the ref of a run.');
  const { ref } = value;
  const worker = value.worker === undefined || value.worker === null ? null : value.worker;
  if (worker !== null && !isInt(worker, 0)) return invalid('worker must be a worker index or null.');
  const since = value.since === undefined || value.since === null ? null : value.since;
  if (since !== null && (typeof since !== 'string' || !since || since.length > 64)) {
    return invalid('since must name a stop or be null.');
  }
  switch (value.type) {
    case 'runControl': {
      const { action } = value;
      if (action === 'run-to') return invalid('Run to a line stays in the editor: use Run to Cursor there.');
      if (typeof action !== 'string' || !ACTIONS.includes(action)) {
        return invalid('action must be pause, step, resume, finish, end or give-up.');
      }
      if (action !== 'pause' && action !== 'give-up' && since === null) return invalid(NEEDS_STOP);
      return { type: 'runControl', id, ref, worker, action: action as HubControlAction, since };
    }
    case 'pausedPage':
      return worker === null ? invalid('pausedPage needs the worker.') : { type: 'pausedPage', id, ref, worker };
    case 'mock': {
      if (since === null) return invalid(NEEDS_STOP);
      const { request } = value;
      return isInt(request, 1)
        ? { type: 'mock', id, ref, worker, since, request }
        : invalid('mock needs the response to mock: the id of one of those requests lists.');
    }
    case 'requests':
      return since === null ? invalid(NEEDS_STOP) : { type: 'requests', id, ref, worker, since };
    case 'drive':
      if (since === null) return invalid(NEEDS_STOP);
      return typeof value.on === 'boolean'
        ? { type: 'drive', id, ref, worker, since, on: value.on }
        : invalid('drive needs on: true to drive the stop, false to give it back.');
    case 'view':
      if (since === null) return invalid(NEEDS_STOP);
      return typeof value.on === 'boolean'
        ? { type: 'view', id, ref, worker, since, on: value.on }
        : invalid('view needs on: true to watch the stop, false to stop watching it.');
    case 'input': {
      if (since === null) return invalid(NEEDS_STOP);
      const events = readViewInput(value.events);
      return typeof events === 'string' ? invalid(events) : { type: 'input', id, ref, worker, since, events };
    }
    case 'pick-at': {
      if (since === null) return invalid(NEEDS_STOP);
      const { x, y } = value;
      return isViewPoint(x, y)
        ? { type: 'pick-at', id, ref, worker, since, x: x as number, y: y as number }
        : invalid('pick-at needs x and y, the point in CSS pixels of the page.');
    }
    default:
      return since === null
        ? invalid(NEEDS_STOP)
        : { type: value.type as HubIntent | HubCodeIntent | HubWindowAction, id, ref, worker, since };
  }
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

/** A text or null; undefined for anything else. */
function nullableStr(value: unknown, max: number): string | null | undefined {
  return value === null ? null : (str(value, max) ?? undefined);
}

const STOP_REASONS: readonly string[] = ['breakpoint', 'step', 'pause', 'run-to', 'page-pause', 'failure'];
const WORKER_STATES: readonly string[] = ['running', 'stopped', 'between'];
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A kept request as an answer lists it, field by field; null when it is not one. */
function readKeptRequest(value: unknown): HubKeptRequest | null {
  if (!isObject(value)) return null;
  const { id, method, url, status, type, size, time } = value;
  if (!isInt(id, 1) || typeof method !== 'string' || !/^[A-Z]{1,16}$/.test(method)) return null;
  if (str(url, 8192) === null || !isInt(status, 100, 599) || str(type, 200) === null) return null;
  if ((size !== null && !isInt(size, 0)) || !isInt(time, 0)) return null;
  return { id, method, url: url as string, status, type: type as string, size, time };
}

function readImage(value: unknown): HubImage | null | undefined {
  if (value === null) return null;
  if (!isObject(value) || value.mime !== 'image/jpeg') return undefined;
  if (typeof value.data !== 'string' || !value.data || !BASE64.test(value.data)) return undefined;
  return isViewSize(value.width, value.height)
    ? { mime: 'image/jpeg', data: value.data, width: value.width as number, height: value.height as number }
    : { mime: 'image/jpeg', data: value.data };
}

/** A frame of a live view, or why none comes, field by field; null when it is neither. */
function readFrame(value: Record<string, unknown>): HubFrameMessage | HubFrameRefusal | null {
  const { ref, worker, since, width, height, data, refused } = value;
  if (typeof ref !== 'string' || !REF.test(ref) || !isInt(worker, 0) || str(since, 64) === null || !since) return null;
  if (refused !== undefined) {
    return typeof refused === 'string' && refused.trim() && refused.length <= MAX_HUB_MESSAGE
      ? { type: 'frame', ref, worker, since: since as string, refused }
      : null;
  }
  if (!isViewSize(width, height) || !isViewFrameData(data)) return null;
  return {
    type: 'frame',
    ref,
    worker,
    since: since as string,
    width: width as number,
    height: height as number,
    data,
  };
}

/** A frame of a lane, or why none comes, field by field; null when it is neither. */
function readLaneFrame(value: Record<string, unknown>): HubLaneFrameMessage | HubLaneFrameRefusal | null {
  const { ref, lane, worker, test, since, width, height, data, refused } = value;
  if (typeof ref !== 'string' || !REF.test(ref) || !isInt(lane, 0) || !isInt(worker, 0)) return null;
  if (since !== null && (str(since, 64) === null || !since)) return null;
  if (test !== null && (str(test, 256) === null || !test)) return null;
  const at = { ref, lane, worker, test: test as string | null, since: since as string | null };
  if (refused !== undefined) {
    return typeof refused === 'string' && refused.trim() && refused.length <= MAX_HUB_MESSAGE
      ? { type: 'lane-frame', ...at, refused }
      : null;
  }
  if (at.test === null || !isViewSize(width, height) || !isViewFrameData(data)) return null;
  return {
    type: 'lane-frame',
    ...at,
    test: at.test,
    width: width as number,
    height: height as number,
    data,
  };
}

/** The actions of a list, those this version knows, in their order; none for anything but a list. */
function readActions(value: unknown): HubAction[] {
  return Array.isArray(value) ? HUB_ACTIONS.filter((action) => value.includes(action)) : [];
}

function readStop(value: unknown): HubStop | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const { reason, title, uri, line, character, locator, bar, since } = value;
  if (typeof reason !== 'string' || str(title, 1000) === null || str(uri, 8192) === null) return undefined;
  if (!isInt(line, 0) || (character !== null && !isInt(character, 0)) || typeof bar !== 'boolean') return undefined;
  if ((locator !== null && str(locator, 1000) === null) || str(since, 64) === null) return undefined;
  const { error } = value;
  if (error !== undefined && str(error, MAX_STOP_ERROR) === null) return undefined;
  return {
    reason: STOP_REASONS.includes(reason) ? (reason as HubStopReason) : 'other',
    title: title as string,
    uri: uri as string,
    line,
    character: character as number | null,
    locator: locator as string | null,
    bar,
    since: since as string,
    ...(error === undefined ? {} : { error: error as string }),
    ...(value.intents === undefined ? {} : { intents: readActions(value.intents) }),
    ...(value.by === 'agent' ? { by: 'agent' as const } : {}),
    ...(value.driver === undefined || !readPresence(value.driver) ? {} : { driver: readPresence(value.driver)! }),
  };
}

/** A tool present on a run, field by field: a kind of a newer hub reads as `other`; null when it is not one. */
function readPresence(value: unknown): HubPresence | null {
  if (!isObject(value) || typeof value.kind !== 'string' || value.kind.length > 64) return null;
  if (str(value.name, MAX_HUB_CLIENT) === null || !value.name) return null;
  const kind = PRESENCE_KINDS.find((known) => known === value.kind) ?? 'other';
  return { kind, name: value.name as string, ...(value.self === true ? { self: true as const } : {}) };
}

/** The tools of a presence list this version reads, at most `MAX_HUB_PRESENCE`; null when it is no list. */
function readPresenceList(value: unknown): HubPresence[] | null {
  if (!Array.isArray(value) || value.length > MAX_HUB_PRESENCE) return null;
  return value.map(readPresence).filter((p): p is HubPresence => p !== null);
}

/** What an action that writes code came to, field by field; null when it is not one. */
function readCode(value: Record<string, unknown>): HubCodeMessage | null {
  const { ref, worker, since, action, ok, message, warnings } = value;
  if (typeof ref !== 'string' || !REF.test(ref) || !isInt(worker, 0) || str(since, 64) === null || !since) return null;
  if (typeof action !== 'string' || !HUB_CODE_ACTIONS.includes(action) || typeof ok !== 'boolean') return null;
  if (str(message, MAX_HUB_MESSAGE) === null) return null;
  const code: HubCodeMessage = {
    type: 'code',
    ref,
    worker,
    since: since as string,
    action: action as HubCodeAction,
    ok,
    message: message as string,
  };
  if (warnings === undefined) return code;
  if (!Array.isArray(warnings) || warnings.length > MAX_HUB_WARNINGS) return null;
  if (!warnings.every((w) => str(w, MAX_HUB_MESSAGE) !== null)) return null;
  return { ...code, warnings: warnings as string[] };
}

function readTest(value: unknown): HubTest | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const { id, title, uri, line, project, retry, cannotPause } = value;
  if (str(id, 256) === null || str(uri, 8192) === null || str(project, 200) === null) return undefined;
  if (!Array.isArray(title) || title.length > 64 || !title.every((t) => str(t, 1000) !== null)) return undefined;
  if (!isInt(line, 0) || !isInt(retry, 0) || (cannotPause !== null && str(cannotPause, 500) === null)) {
    return undefined;
  }
  return {
    id: id as string,
    title: title as string[],
    uri: uri as string,
    line,
    project: project as string,
    retry,
    cannotPause: cannotPause as string | null,
  };
}

function readWorker(value: unknown): HubWorker | null {
  if (!isObject(value)) return null;
  const { worker, parallelIndex, state, pausing } = value;
  if (!isInt(worker, 0) || !isInt(parallelIndex, 0) || typeof pausing !== 'boolean') return null;
  if (typeof state !== 'string' || state.length > 64) return null;
  const test = readTest(value.test);
  const stop = readStop(value.stop);
  if (test === undefined || stop === undefined) return null;
  const waiting = pausing && value.waiting !== undefined ? readWaiting(value.waiting) : null;
  return {
    worker,
    parallelIndex,
    state: WORKER_STATES.includes(state) ? (state as HubWorker['state']) : 'other',
    test,
    stop,
    pausing,
    intents: readActions(value.intents),
    ...(waiting ? { waiting } : {}),
    ...(value.watchers === undefined || !readPresenceList(value.watchers)?.length
      ? {}
      : { watchers: readPresenceList(value.watchers)! }),
  };
}

/** The call a pausing worker waits in, field by field; null when it is not one. */
function readWaiting(value: unknown): HubWaiting | null {
  if (!isObject(value)) return null;
  const { title, uri, line, since, endable } = value;
  if (str(title, MAX_HUB_MESSAGE) === null || !title || typeof endable !== 'boolean') return null;
  if (since !== null && (typeof since !== 'string' || since.length > 64 || Number.isNaN(Date.parse(since))))
    return null;
  if (uri !== null && (typeof uri !== 'string' || !uri.startsWith('file:') || uri.length > 4096)) return null;
  if (line !== null && !isInt(line, 0)) return null;
  return {
    title: title as string,
    uri: uri as string | null,
    line: line as number | null,
    since: since as string | null,
    endable,
  };
}

/** A run and those of its workers this version reads; null when the run itself is not one. */
function readSession(value: unknown): HubSession | null {
  if (!isObject(value) || typeof value.ref !== 'string' || !REF.test(value.ref) || typeof value.ended !== 'boolean') {
    return null;
  }
  const root = nullableStr(value.root, 4096);
  const label = nullableStr(value.label, 4096);
  const command = nullableStr(value.command, MAX_HUB_COMMAND);
  const project = nullableStr(value.project, MAX_HUB_PROJECT);
  if (root === undefined || label === undefined || command === undefined || project === undefined) return null;
  if (!Array.isArray(value.workers) || value.workers.length > 1000) return null;
  const workers = value.workers.map(readWorker).filter((w): w is HubWorker => w !== null);
  const session: HubSession = { ref: value.ref, root, label, command, project, workers, ended: value.ended };
  if (value.terminal === true) session.terminal = true;
  if (value.terminal === true && value.runner === true) session.runner = true;
  const live = value.live === undefined ? null : readLive(value.live);
  if (live) session.live = live;
  const progress = value.progress === undefined ? null : readProgress(value.progress);
  if (progress) session.progress = progress;
  const page = value.page === undefined ? null : readRunPage(value.page);
  if (page) session.page = page;
  const hold = value.hold === undefined ? null : readHold(value.hold);
  if (hold) session.hold = hold;
  const presence = value.presence === undefined ? null : readPresenceList(value.presence);
  if (presence?.length) session.presence = presence;
  return session;
}

const PROGRESS_STATUSES: readonly string[] = ['running', 'passed', 'failed', 'timedout', 'interrupted', 'other'];

/** How far a run is, field by field: a status of a newer service reads as `other`; null when it is not one. */
function readProgress(value: unknown): HubProgress | null {
  if (!isObject(value)) return null;
  const { total, done, failed, flaky, skipped, status, failure } = value;
  if (![total, done, failed, flaky, skipped].every((n) => isInt(n, 0))) return null;
  if (
    (done as number) > (total as number) ||
    (failed as number) + (flaky as number) + (skipped as number) > (done as number)
  ) {
    return null;
  }
  if (typeof status !== 'string') return null;
  let first: HubProgress['failure'] = null;
  if (failure !== null) {
    if (!isObject(failure) || str(failure.title, MAX_RUN_FAILURE_TEXT) === null || !failure.title) return null;
    const error = nullableStr(failure.error, MAX_RUN_FAILURE_TEXT);
    if (error === undefined) return null;
    first = { title: failure.title as string, error };
  }
  return {
    total: total as number,
    done: done as number,
    failed: failed as number,
    flaky: flaky as number,
    skipped: skipped as number,
    status: (PROGRESS_STATUSES.includes(status) ? status : 'other') as HubProgress['status'],
    failure: first,
  };
}

/** A run's **Hold failures**, field by field; null when it is not one. */
function readHold(value: unknown): HubHold | null {
  if (!isObject(value) || typeof value.on !== 'boolean') return null;
  const by = HOLD_BY.find((known) => known === value.by);
  return by ? { on: value.on, by } : null;
}

/** A run's live view on the team instance, field by field; null when it is not one. */
function readLive(value: unknown): HubLive | null {
  if (!isObject(value)) return null;
  const { shared, refused, stopped = null, page, viewers } = value;
  if (typeof shared !== 'boolean' || !isInt(viewers, 0, 1_000_000)) return null;
  if (refused !== null && str(refused, MAX_HUB_MESSAGE) === null) return null;
  if (stopped !== null && str(stopped, MAX_HUB_MESSAGE) === null) return null;
  if (page !== null && (str(page, 2048) === null || !/^https?:\/\//.test(page as string))) return null;
  return {
    shared,
    refused: refused as string | null,
    stopped: stopped as string | null,
    page: page as string | null,
    viewers,
  };
}

/** A message from the hub, checked field by field; null when it is not one, or of a type this version does not know. */
export function parseHubMessage(text: string): HubMessage | null {
  const value = readJson(text);
  if (!value) return null;
  switch (value.type) {
    case 'welcome': {
      const { pid, version, client, roots, keepaliveMs } = value;
      if (!isInt(pid, 1) || str(version, 64) === null || !isInt(keepaliveMs, 1)) return null;
      if (client !== null && str(client, MAX_HUB_CLIENT) === null) return null;
      if (!Array.isArray(roots) || roots.length > MAX_HUB_ROOTS || !roots.every((r) => str(r, 4096) !== null)) {
        return null;
      }
      return {
        type: 'welcome',
        pid,
        version: version as string,
        client: client as string | null,
        roots: roots as string[],
        keepaliveMs,
        features: readFeatures(value.features),
      };
    }
    case 'answer': {
      const { id, ok, message } = value;
      if (!isInt(id, 1) || typeof ok !== 'boolean' || str(message, MAX_HUB_MESSAGE) === null) return null;
      const answer: HubAnswer = { type: 'answer', id, ok, message: message as string };
      if (value.requests !== undefined) {
        if (!Array.isArray(value.requests) || value.requests.length > 50) return null;
        const requests = value.requests.map(readKeptRequest);
        if (!requests.every((r): r is HubKeptRequest => r !== null)) return null;
        answer.requests = requests;
      }
      if (value.locator !== undefined) {
        if (value.locator !== null && str(value.locator, 1000) === null) return null;
        answer.locator = value.locator as string | null;
      }
      if (typeof value.taken === 'boolean') answer.taken = value.taken;
      if (value.image === undefined) return answer;
      const image = readImage(value.image);
      return image === undefined ? null : { ...answer, image };
    }
    case 'frame':
      return readFrame(value);
    case 'lane-frame':
      return readLaneFrame(value);
    case 'session': {
      const session = readSession(value.session);
      return session ? { type: 'session', session } : null;
    }
    case 'code':
      return readCode(value);
    case 'peers':
      return Array.isArray(value.hubs) && value.hubs.length <= MAX_HUB_PEERS
        ? { type: 'peers', hubs: value.hubs.flatMap((hub) => readPeer(hub) ?? []) }
        : null;
    case 'keepalive':
      return { type: 'keepalive' };
    default:
      return null;
  }
}

/**
 * The hubs of a `GET …/live` answer, checked field by field: an entry it cannot read is left out; null for no answer.
 * Every hub is on `127.0.0.1`, as a service listens: one named under `localhost` is read there, since `localhost` may
 * resolve to `[::1]`, where another program could listen on the same port and take the token `hello` sends.
 */
export function parseLiveAnswer(body: unknown): LiveHub[] | null {
  if (!isObject(body) || !Array.isArray(body.hubs)) return null;
  return body.hubs.flatMap((hub): LiveHub[] => {
    const peer = readPeer(hub);
    if (!peer || !isObject(hub)) return [];
    const { token } = hub;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) return [];
    return [hub.features === undefined ? { ...peer, token } : { ...peer, token, features: readFeatures(hub.features) }];
  });
}

/** A hub as a live answer or `peers` names it, but its token, field by field, on `127.0.0.1`; null when it is not one. */
function readPeer(hub: unknown): PeerHub | null {
  if (!isObject(hub)) return null;
  const { pid, version, client, roots, startedAt } = hub;
  const named = typeof hub.url === 'string' ? HUB_URL.exec(hub.url) : null;
  if (!named || !isInt(pid, 1)) return null;
  if (str(version, 64) === null || str(startedAt, 64) === null) return null;
  if (client !== null && str(client, 200) === null) return null;
  if (!Array.isArray(roots) || !roots.every((r) => str(r, 4096) !== null)) return null;
  return {
    url: `ws://127.0.0.1:${named[1]}${named[2]}`,
    pid,
    version: version as string,
    client: client as string | null,
    roots: roots as string[],
    startedAt: startedAt as string,
  };
}

/** The features of a list, those this version knows, in its order; none for anything but a list. */
function readFeatures(value: unknown): HubFeature[] {
  return Array.isArray(value) ? HUB_FEATURES.filter((feature) => value.includes(feature)) : [];
}
