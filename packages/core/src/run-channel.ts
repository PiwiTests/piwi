/**
 * The run channel: each worker of a test run the editor started keeps one connection, from before its first test to
 * its end, to the local socket the editor service listens on for the record channel's hand-offs
 * (`@piwitests/core/ide-recorder`). The run's environment names it as `PIWI_RUN_CHANNEL`, `<socket path>#<token>`
 * as `PIWI_RECORD_CHANNEL` is (`formatRecordChannel`, `parseRecordChannel`). Its first line, `run-attach`, tells it
 * from a hand-off's `attach`. Over it the worker says which test it runs and where it stopped, and the editor service
 * steers it: pause, step, resume, finish, run to a line, the breakpoints, an image of the stopped page, and, at a stop
 * the pause bar shows, the bar's own **Pick a locator** and **Record here**, the check panel's **Check an element** and
 * a region's ARIA snapshot, started from outside the page; at any stop, the responses the test kept (an interactive
 * run keeps the text bodies of its pages' fetch and XHR answers), one of them to mock, and a locator's matches; and, for
 * a viewer outside the page, the stopped page's live view (`@piwitests/core/run-view`: its frames, the input played on
 * it) and the locator of the element under a point of an image of it; and, for an agent (the editor's MCP server), the
 * stopped page's ARIA snapshot in AI mode, an action on one of its elements by its ref, that element's ranked locators,
 * what the run does as it goes (`events`), and its browser bound for Playwright's own tools on request (`bind`). A
 * worker holds a failure for the editor only
 * once the service said it shows and answers one (`holds` in its `run-attach`, answered by `attached`): a service that
 * predates it says nothing, and the failure goes on. Each message is one line of JSON, at most `MAX_HANDOFF_LINE` long
 * (`lineReader`), checked field by field on both sides. A side ignores a message it cannot read.
 */
import { isViewFrameData, isViewKeyCombo, isViewPoint, isViewSize, readViewInput, type ViewInput } from './run-view';

export const RUN_CHANNEL_ENV = 'PIWI_RUN_CHANNEL';

/**
 * The name a run's workers give the hub in `run-attach` (`ref`, letters, digits, `_` and `-`, 64 at most), for a
 * launcher whose `PIWI_ORIGIN_REF` names what the run was launched for rather than the run itself: the desktop app,
 * whose reproduce and bisect runs carry the failure cluster's id there. Without it, `PIWI_ORIGIN_REF` names the run.
 */
export const RUN_REF_ENV = 'PIWI_RUN_REF';

/**
 * A line of the user's code: its file relative to the run's working directory, with forward slashes (`..` for a file
 * above it), and the 1-based line and column.
 */
export interface Place {
  file: string;
  line: number;
  column?: number;
}

/**
 * Why a test stopped: a breakpoint's line, the first call after Step, a pause asked from outside, the line it was run
 * to, `page.pause()`, or the test failed (`failure`): its page is held before its context closes, at the failing line,
 * and any answer lets the test end as it failed.
 */
export type StopReason = 'breakpoint' | 'step' | 'pause' | 'run-to' | 'page-pause' | 'failure';

/**
 * A stop a worker holds only when the service says it shows and answers it (`attached`): `failure`, a failed test's
 * page held at its failing line.
 */
export type RunHold = 'failure';

/** The stops this version holds when the service says it shows them. */
export const RUN_HOLDS: readonly RunHold[] = ['failure'];

/**
 * An image of a stopped page: a JPEG, base64, and the page's viewport in CSS pixels (`width`, `height`), which a point
 * on the image is mapped to (`x * width / naturalWidth`) for `pick-at`; a reporter that predates them names neither.
 */
export interface PausedImage {
  mime: 'image/jpeg';
  data: string;
  width?: number;
  height?: number;
}

/**
 * What a stop the pause bar shows starts from outside the page, in the test's window: the bar's **Pick a locator**
 * (`pick`) and **Record here** (`record`), their results going where the bar's go; the check panel's **Check an
 * element** (`assert`), through the record channel's hand-off in its `check` mode, the editor service writing the
 * check; and a region picked with the bar's picker (`assert-region`), whose ARIA snapshot the worker reads and sends
 * (`region`).
 */
export type RunIntent = 'pick' | 'record' | 'assert' | 'assert-region';

/**
 * What a stopped worker answers with what it holds, at a headless stop too: the responses its test kept (`requests`),
 * one of them with its body (`mock`), and how many elements a locator matches on the stopped page (`locator`).
 */
export type RunQuery = 'requests' | 'mock' | 'locator';

/**
 * What a stopped worker does for a viewer outside the page: start and stop the stopped page's live view (`view`), play
 * a viewer's input on it (`input`), with the click count a button's `down` and `up` carry (`input-clicks`, so a double
 * click is sent as the browser counted it, at once), and find the locator of the element under a point of an image of
 * it (`pick-at`).
 */
export type RunViewTake = 'view' | 'input' | 'input-clicks' | 'pick-at';

/**
 * What a stopped worker does for an agent outside the page: read the stopped page for it (`agent`: the requests
 * `snapshot`, its ARIA snapshot in AI mode, to a depth, with an image of it when asked; `act`, an action on an element
 * of the snapshot by its ref, as trusted input; and `ref-locator`, the locators of such an element ranked, and what it
 * holds); tell a follower what the run does as it goes, each call, navigation, console error and failed request
 * (`events`); and bind its browser for Playwright's own tools (`bind`, `browser.bind`), until the test ends.
 */
export type RunAgentTake = 'agent' | 'events' | 'bind';

/** What a worker's `run-attach` lists in `takes`. */
export type RunTake = RunIntent | RunQuery | RunViewTake | RunAgentTake;

/** The intents a worker takes. */
export const RUN_INTENTS: readonly RunIntent[] = ['pick', 'record', 'assert', 'assert-region'];

/**
 * Everything a worker takes, as its `run-attach` lists it: a worker of an older reporter lists fewer, or none. An
 * editor service released before `agent` reads a list of more than 16 entries as none, so this one holds 16 at most:
 * a new capability joins an entry (as the agent's requests share `agent`) rather than growing the list past it.
 */
export const RUN_TAKES: readonly RunTake[] = [
  ...RUN_INTENTS,
  'requests',
  'mock',
  'locator',
  'view',
  'input',
  'input-clicks',
  'pick-at',
  'agent',
  'events',
  'bind',
];

/** The most entries a `run-attach` lists in `takes` that this side reads; a longer list is read as none. */
const MAX_TAKES = 64;

/** What each intent starts, as a sentence names it. */
export const RUN_INTENT_NAMES: Record<RunIntent, string> = {
  pick: 'Pick a locator',
  record: 'Record here',
  assert: 'Assert',
  'assert-region': 'Assert a region',
};

/** Whether an intent started, or why not, in one sentence. */
export interface IntentAnswer {
  ok: boolean;
  message: string;
}

/** The most responses a worker keeps for its test: the latest ones. */
export const MAX_KEPT_RESPONSES = 50;
/** The longest body a worker keeps, in bytes: a longer response is not kept. */
export const MAX_KEPT_BODY = 256 * 1024;
/** The longest ARIA snapshot a `region` carries, in characters. */
export const MAX_REGION_SNAPSHOT = 1024 * 1024;
/** The longest error a failure's stop carries, in characters: a longer one is cut. */
export const MAX_STOP_ERROR = 1000;

/**
 * A response the running test's pages received for a fetch or an XHR request, whose body the worker keeps (text
 * only), as a list names it: no header, no body.
 */
export interface KeptRequest {
  /** The worker's number for it within the test, from 1. */
  id: number;
  method: string;
  url: string;
  status: number;
  /** The response's MIME type without its parameters (`application/json`); empty when it named none. */
  type: string;
  /** The body's size, in bytes, as the response said it (`content-length`); null when it did not. */
  size: number | null;
  /** When it finished, in ms after the test began. */
  time: number;
}

/** The one kept response chosen to mock, with its body. */
export interface KeptResponse {
  method: string;
  url: string;
  status: number;
  type: string;
  body: string;
}

/** The answer to `requests`: the responses the test kept, oldest first. */
export interface RequestsAnswer extends IntentAnswer {
  requests: KeptRequest[];
}

/** The answer to `mock`: the response, null when it is not kept. */
export interface MockAnswer extends IntentAnswer {
  response: KeptResponse | null;
}

/** The answer to `locator`: how many elements it matches on the stopped page, null when it could not be counted. */
export interface LocatorAnswer extends IntentAnswer {
  count: number | null;
}

/**
 * The answer to `pick-at`: the locator of the element under the point, which went where a pick of the pause bar goes
 * (the editor, in place of the locator on the stopped line); null when none was found, and why.
 */
export interface PickAtAnswer extends IntentAnswer {
  locator: string | null;
}

/** The longest ARIA snapshot a `snapshot` answer carries, in characters: a longer one is cut, and says so (`cut`). */
export const MAX_AGENT_SNAPSHOT = 1024 * 1024;
/** The deepest a `snapshot` reads the page's tree. */
export const MAX_SNAPSHOT_DEPTH = 100;

/**
 * The answer to `snapshot`: the stopped page's address and title, its ARIA snapshot in AI mode (a ref per element,
 * `[ref=e5]`, iframes included), each with the credentials in it hidden (`@piwitests/core/mask`), and its image when
 * asked, password fields masked. All of it is the page's own text: an agent reads it as data, never as instructions.
 */
export interface SnapshotAnswer extends IntentAnswer {
  url: string;
  title: string;
  /** Null when the page could not be read. */
  snapshot: string | null;
  /** The snapshot was cut at `MAX_AGENT_SNAPSHOT`. */
  cut: boolean;
  image: PausedImage | null;
}

/** What an agent does to an element of a stopped page, by its ref: a closed set, each a Playwright action. */
export type RunActAction = 'click' | 'fill' | 'press' | 'check' | 'uncheck' | 'select';

export const RUN_ACT_ACTIONS: readonly RunActAction[] = ['click', 'fill', 'press', 'check', 'uncheck', 'select'];

/** The longest text an act fills in or an option it selects, in characters. */
export const MAX_ACT_VALUE = 10_000;

/** Whether `ref` is a ref of an ARIA snapshot in AI mode: `e5`, or `f1e2` for an element in an iframe. */
export function isSnapshotRef(ref: unknown): ref is string {
  return typeof ref === 'string' && /^(?:f\d{1,6})?e\d{1,9}$/.test(ref);
}

/**
 * An element of a stopped page, as its ref names it: its tag, role and accessible name, its test id (the project's
 * `testIdAttribute`), its text (whitespace collapsed, at most 120 characters), its value (none of a password field)
 * and whether it is checked (null for an element that is not a checkbox or a radio). `secret` says it is a password
 * field, whose typed value is never written down.
 */
export interface RefElement {
  tagName: string;
  role: string | null;
  name: string | null;
  testId: string | null;
  text: string | null;
  value: string | null;
  checked: boolean | null;
  secret: boolean;
}

/** A locator of an element, ranked as the pause bar's Pick a locator ranks it, and whether it finds that element alone. */
export interface RankedRefLocator {
  locator: string;
  method: string;
  score: number;
  unique: boolean;
}

/** The answer to `ref-locator`: the element and its locators, best first; none when the ref names no element. */
export interface RefLocatorAnswer extends IntentAnswer {
  element: RefElement | null;
  locators: RankedRefLocator[];
}

/** The answer to `act`: whether it was played, and the element it acted on as it stood before, ranked, for its step. */
export type ActAnswer = RefLocatorAnswer;

/** The answer to `bind`: the name the browser was bound under and its endpoint, or why not; both null once unbound. */
export interface BindAnswer extends IntentAnswer {
  name: string | null;
  endpoint: string | null;
}

/** The longest text an event carries, in characters: a longer one is cut. */
export const MAX_RUN_EVENT_TEXT = 1000;
/** The most events a worker sends in a second: the others are counted, and said as `dropped`. */
export const MAX_RUN_EVENT_RATE = 50;

/**
 * What a worker tells a follower of its run as the running test goes (`events`), the credentials in each text hidden:
 * a call of the test ended (Playwright's name for it, the place in the user's code that made it, whether it passed,
 * its error, its duration in ms); the page navigated; it logged an error or a warning; it threw an error nothing
 * caught; a request it made failed or was answered with an error status; and how many events were not sent, past
 * `MAX_RUN_EVENT_RATE`. The texts of all but `call` and `dropped` are the page's own.
 */
export type RunEvent =
  | { kind: 'call'; title: string; place: Place | null; ok: boolean; error: string | null; ms: number }
  | { kind: 'navigation'; url: string }
  | { kind: 'console'; level: 'error' | 'warning'; text: string }
  | { kind: 'page-error'; text: string }
  | { kind: 'request-failed'; method: string; url: string; status: number | null; failure: string | null }
  | { kind: 'dropped'; count: number };

/** What a worker sends the editor service on its run connection. */
export type RunToHub =
  /**
   * The first line: the channel's token, the ref of the command that started the run (`PIWI_ORIGIN_REF`), the run's
   * working directory, which every `Place` is relative to, the worker (Playwright's `workerIndex` and
   * `parallelIndex`, its process), the versions of Playwright and of the reporter, the intents and queries it
   * takes (`takes`), none for a worker of a reporter that predates them, and the stops it holds only once the service
   * says it shows them (`holds`), which the service answers with `attached`; absent from a reporter that predates them.
   */
  | {
      type: 'run-attach';
      token: string;
      ref: string;
      cwd: string;
      workerIndex: number;
      parallelIndex: number;
      pid: number;
      playwright: string;
      reporter: string;
      takes?: RunTake[];
      holds?: RunHold[];
    }
  /**
   * A test starts: Playwright's id, its describe blocks' titles and its own, its file and 1-based line, its project,
   * the retry (0 for the first attempt), and why it never stops (CI, Playwright's own debugger), null when it can.
   */
  | {
      type: 'test-begin';
      testId: string;
      title: string[];
      file: string;
      line: number;
      project: string;
      retry: number;
      cannotPause: string | null;
    }
  /**
   * The test stopped before a call, until a `running` with the same `stop` (the worker's own number for it, from 1):
   * why, the call as Playwright titles it, its place, the locator it acts on (null for none), and whether Piwi's pause
   * bar shows in the page, where it can be answered too. A worker is stopped at one call at a time. `other` is a reason
   * this side does not know, from a newer reporter: a plain stop. A failure's stop names its error (`error`): the
   * failing error's first lines as plain text, at most `MAX_STOP_ERROR` characters; a reporter that predates it sends
   * none, and its `title` alone says how the test failed.
   */
  | {
      type: 'stopped';
      stop: number;
      reason: StopReason | 'other';
      title: string;
      place: Place;
      locator: string | null;
      bar: boolean;
      error?: string;
    }
  /** The stop ended, whoever answered it: the bar, the editor, or the test ending under it. */
  | { type: 'running'; stop: number }
  /** The test ended: its status as Playwright gives it, and how long it stood stopped. */
  | { type: 'test-end'; testId: string; status: string; pausedMs: number }
  /** The answer to a `request`: an image of the stopped page, null when there is none. */
  | { type: 'answer'; request: number; what: 'image'; value: PausedImage | null }
  /** The answer to an intent's `request`: whether it started in the test's window, or why not. */
  | { type: 'answer'; request: number; what: RunIntent; value: IntentAnswer }
  /** The answer to `requests`. */
  | { type: 'answer'; request: number; what: 'requests'; value: RequestsAnswer }
  /** The answer to `mock`. */
  | { type: 'answer'; request: number; what: 'mock'; value: MockAnswer }
  /** The answer to `locator`. */
  | { type: 'answer'; request: number; what: 'locator'; value: LocatorAnswer }
  /** The answer to `view` and to `input`: whether the view started or stopped, the input was played, or why not. */
  | { type: 'answer'; request: number; what: 'view' | 'input'; value: IntentAnswer }
  /** The answer to `pick-at`. */
  | { type: 'answer'; request: number; what: 'pick-at'; value: PickAtAnswer }
  /** The answer to `snapshot`. */
  | { type: 'answer'; request: number; what: 'snapshot'; value: SnapshotAnswer }
  /** The answer to `ref-locator` and to `act`. */
  | { type: 'answer'; request: number; what: 'ref-locator' | 'act'; value: RefLocatorAnswer }
  /** The answer to `bind`. */
  | { type: 'answer'; request: number; what: 'bind'; value: BindAnswer }
  /** Something the running test did, while the editor asked for its events (`events`). */
  | { type: 'event'; event: RunEvent }
  /**
   * A frame of the live view of the stop `stop`, while a `view` asked for it: a JPEG as the page painted it, base64, at
   * most `MAX_VIEW_FRAME` bytes, and the page's viewport in CSS pixels (`width`, `height`), which input and `pick-at`
   * name their points in. Sent at most `MAX_VIEW_FPS` a second, only while that stop holds, never stored; the latest
   * one is sent again as `view` asks again for a view on (a viewer that comes later).
   */
  | { type: 'frame'; stop: number; width: number; height: number; data: string }
  /**
   * The live view of the stop `stop` sends no frame now, and why (`refused`, at most 500 characters): each image of the
   * page is longer than `MAX_VIEW_FRAME`, a lighter one included. Sent once until a frame goes again; a side that
   * predates it reads none, and its viewers wait for a frame.
   */
  | { type: 'frame'; stop: number; refused: string }
  /**
   * At the stop `stop`, after `assert-region`: the region picked in the test's window, as the locator the person
   * confirmed, and its ARIA snapshot (`locator.ariaSnapshot()`), at most `MAX_REGION_SNAPSHOT` characters; or why no
   * snapshot came of the region picked (`refused`: its locator finds several elements, its snapshot is too long).
   */
  | { type: 'region'; stop: number; locator: string; snapshot: string }
  | { type: 'region'; stop: number; refused: string }
  /** Something the person should know: a message of the editor's this worker did not apply, and why. */
  | { type: 'notice'; message: string };

/** What the editor service sends a worker on its run connection. */
export type HubToRun =
  /**
   * The answer to a `run-attach` that lists `holds`: of those stops, the ones the service shows and answers (`holds`),
   * which the worker holds from then on. Sent once, before any other message, and only to a worker that listed them.
   */
  | { type: 'attached'; holds: RunHold[] }
  /** The run's breakpoints from now on, in place of `PIWI_PAUSE_AT` and of the ones sent before. */
  | { type: 'breakpoints'; places: Place[] }
  /** Stop before the next call of the running test, or of the next test. */
  | { type: 'control'; action: 'pause' }
  /**
   * Answer the stop `stop`: go on and stop before the next call, go on to the next breakpoint, or go on with no
   * breakpoint more in this attempt. A stop that already ended is left as it is.
   */
  | { type: 'control'; action: 'step' | 'resume' | 'finish'; stop: number }
  /** Answer the stop `stop`: go on, and stop at the first call on that line, or at a breakpoint before it. */
  | { type: 'run-to'; stop: number; place: Place }
  /** An image of the stopped page; answered with `answer`, null when the worker is not stopped. */
  | { type: 'request'; request: number; what: 'image' }
  /**
   * At the stop `stop`, start an intent in the test's window; answered with `answer` at once, saying whether it
   * started. Sent only to a worker whose `run-attach` takes it, as each request below.
   */
  | { type: 'request'; request: number; what: RunIntent; stop: number }
  /** At the stop `stop`: the responses the test kept, without their bodies. */
  | { type: 'request'; request: number; what: 'requests'; stop: number }
  /** At the stop `stop`: the kept response `id`, with its body and status, the one to mock. */
  | { type: 'request'; request: number; what: 'mock'; stop: number; id: number }
  /**
   * At the stop `stop`: count the elements `locator` (a chain as `@piwitests/core/locator-chain` reads it, without its
   * page) matches on the stopped page and, where the pause bar shows, outline them until the test goes on or the next
   * `locator` request; null takes the outline down.
   */
  | { type: 'request'; request: number; what: 'locator'; stop: number; locator: string | null }
  /**
   * At the stop `stop`: start the live view of its page (`on`), its frames sent as `frame` until a `view` turns it off,
   * the stop ends, or its page or the connection closes; or stop it.
   */
  | { type: 'request'; request: number; what: 'view'; stop: number; on: boolean }
  /**
   * At the stop `stop`, while its view is on: play a viewer's input on its page, in order, as trusted input
   * (`page.mouse`, `page.keyboard`), at most `MAX_VIEW_EVENT_RATE` events a second; answered once it was played.
   */
  | { type: 'request'; request: number; what: 'input'; stop: number; events: ViewInput[] }
  /**
   * At the stop `stop`: the element under the point `x`, `y` of its page (CSS pixels of its viewport), ranked as the
   * pause bar's Pick a locator ranks one, its locator sent where a pick goes.
   */
  | { type: 'request'; request: number; what: 'pick-at'; stop: number; x: number; y: number }
  /**
   * At the stop `stop`: the stopped page's ARIA snapshot in AI mode, `depth` levels deep at most (null for the whole
   * tree), with an image of the page when `image` is true.
   */
  | { type: 'request'; request: number; what: 'snapshot'; stop: number; depth: number | null; image: boolean }
  /**
   * At the stop `stop`: act on the element `ref` names, as trusted input through internal calls, with `value` for a
   * fill (the text), a press (a key, as `isViewKeyCombo` takes it) and a select (an option's value or label).
   */
  | {
      type: 'request';
      request: number;
      what: 'act';
      stop: number;
      ref: string;
      action: RunActAction;
      value: string | null;
    }
  /** At the stop `stop`: the element `ref` names, and its locators ranked. */
  | { type: 'request'; request: number; what: 'ref-locator'; stop: number; ref: string }
  /**
   * At the stop `stop`: bind the worker's browser for Playwright's own tools (`on`), under `piwi-<ref>-w<worker>`, until
   * the test ends; or unbind it.
   */
  | { type: 'request'; request: number; what: 'bind'; stop: number; on: boolean }
  /** Send the running tests' events from now on (`on`), or stop. */
  | { type: 'events'; on: boolean };

/** A message of a type, or a control action or request, of a newer side: answered with a `notice`, never applied. */
export interface UnknownMessage {
  type: 'unknown';
  what: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isInt(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

/** A text of at most `max` characters, longer ones cut; null for anything else. */
function text(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

/** A path of the run: not empty, no NUL, at most 4,096 characters. */
function filePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

/** A place, checked field by field; null when it is not one. */
function readPlace(value: unknown): Place | null {
  if (!isObject(value) || !filePath(value.file) || !isInt(value.line, 1)) return null;
  if (value.column === undefined) return { file: value.file, line: value.line };
  return isInt(value.column, 1) ? { file: value.file, line: value.line, column: value.column } : null;
}

const STOP_REASONS: readonly string[] = ['breakpoint', 'step', 'pause', 'run-to', 'page-pause', 'failure'];

function isIntent(value: unknown): value is RunIntent {
  return (RUN_INTENTS as readonly unknown[]).includes(value);
}

/** What a `run-attach` lists, those this side knows; none for anything but a list. */
function readTakes(value: unknown): RunTake[] {
  if (!Array.isArray(value) || value.length > MAX_TAKES) return [];
  return RUN_TAKES.filter((take) => value.includes(take));
}

/** The stops a message lists in `holds`, those this side knows; none for a list too long, undefined for no list. */
function readHolds(value: unknown): RunHold[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.length > 16 ? [] : RUN_HOLDS.filter((hold) => value.includes(hold));
}

/** An answer's `ok` and `message`, the message cut short; null when it lacks either. */
function readAnswer(value: unknown): IntentAnswer | null {
  if (!isObject(value) || typeof value.ok !== 'boolean' || typeof value.message !== 'string') return null;
  return { ok: value.ok, message: value.message.slice(0, 500) };
}

/** An HTTP method: letters only, at most 16. */
function isMethod(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z]{1,16}$/.test(value);
}

/** A kept response's URL: at most 8,192 characters, none of them a line break or NUL. */
function isUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\r\n\0]/.test(value);
}

/** An HTTP status, 100 to 599. */
function isStatus(value: unknown): value is number {
  return isInt(value, 100) && value <= 599;
}

/** A MIME type without parameters: empty, or `type/subtype` in the characters a token takes. */
function isMime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[\w.+-]{1,100}\/[\w.+-]{1,99})?$/.test(value);
}

function readKeptRequest(value: unknown): KeptRequest | null {
  if (!isObject(value)) return null;
  const { id, method, url, status, type, size, time } = value;
  if (!isInt(id, 1) || !isMethod(method) || !isUrl(url) || !isStatus(status) || !isMime(type)) return null;
  if ((size !== null && (!isInt(size, 0) || size > MAX_KEPT_BODY)) || !isInt(time, 0)) return null;
  return { id, method: method.toUpperCase(), url, status, type, size, time };
}

function readKeptResponse(value: unknown): KeptResponse | null {
  if (!isObject(value)) return null;
  const { method, url, status, type, body } = value;
  if (!isMethod(method) || !isUrl(url) || !isStatus(status) || !isMime(type)) return null;
  if (typeof body !== 'string' || body.length > MAX_KEPT_BODY) return null;
  return { method: method.toUpperCase(), url, status, type, body };
}

/** A locator chain's source as a message carries it: not empty, one line, at most 1,000 characters. */
function isLocatorText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\r\n\u2028\u2029]/.test(value);
}

/** An image's fields, checked as an `image` answer's are; null when it is not one. */
function readImage(value: unknown): PausedImage | null {
  if (!isObject(value) || value.mime !== 'image/jpeg') return null;
  if (typeof value.data !== 'string' || !value.data || !BASE64.test(value.data)) return null;
  const image: PausedImage = { mime: 'image/jpeg', data: value.data };
  // The viewport alone, both or neither.
  if (isViewSize(value.width, value.height)) {
    image.width = value.width as number;
    image.height = value.height as number;
  }
  return image;
}

/** A text an element or an event carries: null stays null, a longer one is cut; undefined for anything else. */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function readRefElement(value: unknown): RefElement | null {
  if (!isObject(value) || typeof value.tagName !== 'string' || !/^[\w-]{1,64}$/.test(value.tagName)) return null;
  const role = optionalText(value.role, 64);
  const name = optionalText(value.name, 1000);
  const testId = optionalText(value.testId, 1000);
  const text = optionalText(value.text, 120);
  const kept = optionalText(value.value, MAX_ACT_VALUE);
  if (role === undefined || name === undefined || testId === undefined || text === undefined || kept === undefined) {
    return null;
  }
  if ((value.checked !== null && typeof value.checked !== 'boolean') || typeof value.secret !== 'boolean') return null;
  return {
    tagName: value.tagName,
    role,
    name,
    testId,
    text,
    // A password field's value never travels.
    value: value.secret ? null : kept,
    checked: value.checked as boolean | null,
    secret: value.secret,
  };
}

function readRankedRefLocator(value: unknown): RankedRefLocator | null {
  if (!isObject(value) || !isLocatorText(value.locator) || typeof value.method !== 'string') return null;
  if (!/^[A-Za-z]{1,32}$/.test(value.method) || typeof value.score !== 'number' || !Number.isFinite(value.score)) {
    return null;
  }
  if (typeof value.unique !== 'boolean') return null;
  return { locator: value.locator, method: value.method, score: value.score, unique: value.unique };
}

/** The most locators a `ref-locator` answer lists. */
const MAX_REF_LOCATORS = 16;

function readRefLocatorAnswer(value: unknown): RefLocatorAnswer | null {
  const said = readAnswer(value);
  if (!said || !isObject(value)) return null;
  const element = value.element === null ? null : readRefElement(value.element);
  if (value.element !== null && !element) return null;
  if (!Array.isArray(value.locators) || value.locators.length > MAX_REF_LOCATORS) return null;
  const locators = value.locators.map(readRankedRefLocator);
  if (!locators.every((l): l is RankedRefLocator => l !== null)) return null;
  return { ...said, element, locators };
}

function readSnapshotAnswer(value: unknown): SnapshotAnswer | null {
  const said = readAnswer(value);
  if (!said || !isObject(value)) return null;
  const { url, title, snapshot, cut, image } = value;
  if (typeof url !== 'string' || url.length > 8192 || /[\r\n\0]/.test(url) || typeof title !== 'string') return null;
  if ((snapshot !== null && typeof snapshot !== 'string') || typeof cut !== 'boolean') return null;
  if (typeof snapshot === 'string' && snapshot.length > MAX_AGENT_SNAPSHOT) return null;
  const read = image === null ? null : readImage(image);
  if (image !== null && !read) return null;
  return { ...said, url, title: title.slice(0, 1000), snapshot, cut, image: read };
}

function readBindAnswer(value: unknown): BindAnswer | null {
  const said = readAnswer(value);
  if (!said || !isObject(value)) return null;
  const name = optionalText(value.name, 200);
  const endpoint = optionalText(value.endpoint, 4096);
  if (name === undefined || endpoint === undefined) return null;
  if (name !== null && !/^[\w.-]{1,200}$/.test(name)) return null;
  return { ...said, name, endpoint };
}

function readRunEvent(value: unknown): RunEvent | null {
  if (!isObject(value)) return null;
  const short = (v: unknown) => text(v, MAX_RUN_EVENT_TEXT);
  switch (value.kind) {
    case 'call': {
      const { title, ok, ms } = value;
      const place = value.place === null ? null : readPlace(value.place);
      const error = optionalText(value.error, MAX_RUN_EVENT_TEXT);
      if (typeof title !== 'string' || !title || typeof ok !== 'boolean' || error === undefined) return null;
      if ((value.place !== null && !place) || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
      return { kind: 'call', title: title.slice(0, 300), place, ok, error, ms: Math.round(ms) };
    }
    case 'navigation':
      return isUrl(value.url) ? { kind: 'navigation', url: value.url } : null;
    case 'console': {
      const said = short(value.text);
      if (said === null || (value.level !== 'error' && value.level !== 'warning')) return null;
      return { kind: 'console', level: value.level, text: said };
    }
    case 'page-error': {
      const said = short(value.text);
      return said === null ? null : { kind: 'page-error', text: said };
    }
    case 'request-failed': {
      const { method, url, status } = value;
      const failure = optionalText(value.failure, 500);
      if (!isMethod(method) || !isUrl(url) || (status !== null && !isStatus(status)) || failure === undefined) {
        return null;
      }
      return { kind: 'request-failed', method: method.toUpperCase(), url, status: status as number | null, failure };
    }
    case 'dropped':
      return isInt(value.count, 1) ? { kind: 'dropped', count: value.count } : null;
    default:
      return null;
  }
}

/** The most breakpoints one message carries. */
const MAX_PLACES = 10_000;

/** The requests at a stop that are no intent. */
const QUERIES = [
  'requests',
  'mock',
  'locator',
  'view',
  'input',
  'pick-at',
  'snapshot',
  'act',
  'ref-locator',
  'bind',
] as const;

/** Base64, as an image's data is written. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A line a worker sent, checked field by field; null when it is not one. */
export function parseRunToHub(line: string): RunToHub | null {
  const value = readJson(line);
  if (!value) return null;
  switch (value.type) {
    case 'run-attach': {
      const { token, ref, cwd, workerIndex, parallelIndex, pid } = value;
      const holds = readHolds(value.holds);
      if (typeof token !== 'string' || typeof ref !== 'string' || !/^[\w-]{1,64}$/.test(ref)) return null;
      if (!filePath(cwd) || !isInt(workerIndex, 0) || !isInt(parallelIndex, 0) || !isInt(pid, 0)) return null;
      return {
        type: 'run-attach',
        token,
        ref,
        cwd,
        workerIndex,
        parallelIndex,
        pid,
        playwright: text(value.playwright, 64) ?? '',
        reporter: text(value.reporter, 64) ?? '',
        takes: readTakes(value.takes),
        ...(holds === undefined ? {} : { holds }),
      };
    }
    case 'test-begin': {
      const { testId, title, file, line: at, project, retry, cannotPause } = value;
      if (typeof testId !== 'string' || !testId || testId.length > 256) return null;
      if (!Array.isArray(title) || !title.length || title.length > 64) return null;
      if (!title.every((t) => typeof t === 'string')) return null;
      if (!filePath(file) || !isInt(at, 1) || typeof project !== 'string' || !isInt(retry, 0)) return null;
      if (cannotPause !== null && typeof cannotPause !== 'string') return null;
      return {
        type: 'test-begin',
        testId,
        title: title.map((t: string) => t.slice(0, 1000)),
        file,
        line: at,
        project: project.slice(0, 200),
        retry,
        cannotPause: cannotPause === null ? null : cannotPause.slice(0, 500),
      };
    }
    case 'stopped': {
      const { stop, reason, title, locator, bar } = value;
      const place = readPlace(value.place);
      if (!isInt(stop, 1) || typeof reason !== 'string' || !reason || typeof title !== 'string' || !place) return null;
      if ((locator !== null && typeof locator !== 'string') || typeof bar !== 'boolean') return null;
      // A failure's error alone: another stop's, or one that is no text, is left out.
      const error =
        reason === 'failure' && typeof value.error === 'string' && value.error.trim()
          ? value.error.slice(0, MAX_STOP_ERROR)
          : null;
      return {
        type: 'stopped',
        stop,
        reason: STOP_REASONS.includes(reason) ? (reason as StopReason) : 'other',
        title: title.slice(0, 1000),
        place,
        locator: locator === null ? null : locator.slice(0, 1000),
        bar,
        ...(error === null ? {} : { error }),
      };
    }
    case 'running':
      return isInt(value.stop, 1) ? { type: 'running', stop: value.stop } : null;
    case 'test-end': {
      const { testId, status, pausedMs } = value;
      if (typeof testId !== 'string' || !testId || typeof status !== 'string' || !/^[a-zA-Z]{1,32}$/.test(status)) {
        return null;
      }
      if (typeof pausedMs !== 'number' || !Number.isFinite(pausedMs) || pausedMs < 0) return null;
      return { type: 'test-end', testId, status, pausedMs };
    }
    case 'answer': {
      const { request, what, value: answered } = value;
      if (!isInt(request, 1)) return null;
      if (isIntent(what)) {
        const said = readAnswer(answered);
        return said ? { type: 'answer', request, what, value: said } : null;
      }
      if (what === 'requests') {
        const said = readAnswer(answered);
        const listed = isObject(answered) ? answered.requests : null;
        if (!said || !Array.isArray(listed) || listed.length > MAX_KEPT_RESPONSES) return null;
        const requests = listed.map(readKeptRequest);
        if (!requests.every((r): r is KeptRequest => r !== null)) return null;
        return { type: 'answer', request, what, value: { ...said, requests } };
      }
      if (what === 'mock') {
        const said = readAnswer(answered);
        const kept = isObject(answered) ? answered.response : undefined;
        const response = kept === null ? null : readKeptResponse(kept);
        if (!said || (kept !== null && !response)) return null;
        return { type: 'answer', request, what, value: { ...said, response } };
      }
      if (what === 'locator') {
        const said = readAnswer(answered);
        const count = isObject(answered) ? answered.count : undefined;
        if (!said || (count !== null && !isInt(count, 0))) return null;
        return { type: 'answer', request, what, value: { ...said, count: count as number | null } };
      }
      if (what === 'view' || what === 'input') {
        const said = readAnswer(answered);
        return said ? { type: 'answer', request, what, value: said } : null;
      }
      if (what === 'pick-at') {
        const said = readAnswer(answered);
        const locator = isObject(answered) ? answered.locator : undefined;
        if (!said || (locator !== null && !isLocatorText(locator))) return null;
        return { type: 'answer', request, what, value: { ...said, locator: locator as string | null } };
      }
      if (what === 'snapshot') {
        const read = readSnapshotAnswer(answered);
        return read ? { type: 'answer', request, what, value: read } : null;
      }
      if (what === 'ref-locator' || what === 'act') {
        const read = readRefLocatorAnswer(answered);
        return read ? { type: 'answer', request, what, value: read } : null;
      }
      if (what === 'bind') {
        const read = readBindAnswer(answered);
        return read ? { type: 'answer', request, what, value: read } : null;
      }
      if (what !== 'image') return null;
      if (answered === null) return { type: 'answer', request, what, value: null };
      const image = readImage(answered);
      return image ? { type: 'answer', request, what, value: image } : null;
    }
    case 'event': {
      const event = readRunEvent(value.event);
      return event ? { type: 'event', event } : null;
    }
    case 'frame': {
      const { stop, width, height, data, refused } = value;
      if (isInt(stop, 1) && typeof refused === 'string' && refused.trim()) {
        return { type: 'frame', stop, refused: refused.slice(0, 500) };
      }
      if (!isInt(stop, 1) || !isViewSize(width, height) || !isViewFrameData(data)) return null;
      return { type: 'frame', stop, width: width as number, height: height as number, data };
    }
    case 'region': {
      const { stop, locator, snapshot, refused } = value;
      if (isInt(stop, 1) && typeof refused === 'string' && refused.trim()) {
        return { type: 'region', stop, refused: refused.slice(0, 500) };
      }
      if (!isInt(stop, 1) || !isLocatorText(locator)) return null;
      if (typeof snapshot !== 'string' || !snapshot.trim() || snapshot.length > MAX_REGION_SNAPSHOT) return null;
      return { type: 'region', stop, locator, snapshot };
    }
    case 'notice':
      return typeof value.message === 'string' ? { type: 'notice', message: value.message.slice(0, 500) } : null;
    default:
      return null;
  }
}

/**
 * A line the editor service sent, checked field by field; null when it is not one, `unknown` for a type, a control
 * action or a request this version does not know.
 */
export function parseHubToRun(line: string): HubToRun | UnknownMessage | null {
  const value = readJson(line);
  if (!value) return null;
  const unknown = (what: string): UnknownMessage => ({ type: 'unknown', what: what.slice(0, 64) });
  switch (value.type) {
    case 'attached': {
      const holds = readHolds(value.holds);
      return holds ? { type: 'attached', holds } : null;
    }
    case 'breakpoints': {
      if (!Array.isArray(value.places) || value.places.length > MAX_PLACES) return null;
      const places = value.places.map(readPlace);
      return places.every((p): p is Place => p !== null) ? { type: 'breakpoints', places } : null;
    }
    case 'control': {
      const { action, stop } = value;
      if (action === 'pause') return { type: 'control', action };
      if (action === 'step' || action === 'resume' || action === 'finish') {
        return isInt(stop, 1) ? { type: 'control', action, stop } : null;
      }
      return typeof action === 'string' ? unknown(`control ${action}`) : null;
    }
    case 'run-to': {
      const place = readPlace(value.place);
      return isInt(value.stop, 1) && place ? { type: 'run-to', stop: value.stop, place } : null;
    }
    case 'request': {
      const { request, what, stop } = value;
      if (!isInt(request, 1)) return null;
      if (what === 'image') return { type: 'request', request, what: 'image' };
      if (typeof what !== 'string') return null;
      if (!isIntent(what) && !(QUERIES as readonly string[]).includes(what)) return unknown(`request ${what}`);
      if (!isInt(stop, 1)) return null;
      if (isIntent(what) || what === 'requests') return { type: 'request', request, what, stop };
      if (what === 'mock') return isInt(value.id, 1) ? { type: 'request', request, what, stop, id: value.id } : null;
      if (what === 'view')
        return typeof value.on === 'boolean' ? { type: 'request', request, what, stop, on: value.on } : null;
      if (what === 'input') {
        const events = readViewInput(value.events);
        return typeof events === 'string' ? null : { type: 'request', request, what, stop, events };
      }
      if (what === 'pick-at') {
        const { x, y } = value;
        return isViewPoint(x, y) ? { type: 'request', request, what, stop, x: x as number, y: y as number } : null;
      }
      if (what === 'snapshot') {
        const { depth, image } = value;
        if ((depth !== null && (!isInt(depth, 1) || depth > MAX_SNAPSHOT_DEPTH)) || typeof image !== 'boolean') {
          return null;
        }
        return { type: 'request', request, what, stop, depth: depth as number | null, image };
      }
      if (what === 'act') {
        const act = readAct(value);
        return act ? { type: 'request', request, what, stop, ...act } : null;
      }
      if (what === 'ref-locator') {
        return isSnapshotRef(value.ref) ? { type: 'request', request, what, stop, ref: value.ref } : null;
      }
      if (what === 'bind') {
        return typeof value.on === 'boolean' ? { type: 'request', request, what, stop, on: value.on } : null;
      }
      const { locator } = value;
      return locator === null || isLocatorText(locator)
        ? { type: 'request', request, what: 'locator', stop, locator }
        : null;
    }
    case 'events':
      return typeof value.on === 'boolean' ? { type: 'events', on: value.on } : null;
    default:
      return typeof value.type === 'string' && value.type ? unknown(value.type) : null;
  }
}

/**
 * An act's element, action and value, checked: a fill's text (at most `MAX_ACT_VALUE` characters), a press's key (one
 * `isViewKeyCombo` takes), a select's option (one line, at most `MAX_ACT_VALUE`); none for a click, a check or an
 * uncheck. Null when it is not one.
 */
export function readAct(value: unknown): { ref: string; action: RunActAction; value: string | null } | null {
  if (!isObject(value) || !isSnapshotRef(value.ref)) return null;
  const action = value.action;
  if (typeof action !== 'string' || !(RUN_ACT_ACTIONS as readonly string[]).includes(action)) return null;
  const given = value.value;
  switch (action as RunActAction) {
    case 'fill':
      return typeof given === 'string' && given.length <= MAX_ACT_VALUE
        ? { ref: value.ref, action: 'fill', value: given }
        : null;
    case 'press':
      return isViewKeyCombo(given) ? { ref: value.ref, action: 'press', value: given } : null;
    case 'select':
      return typeof given === 'string' && given.length <= MAX_ACT_VALUE && !/[\r\n\0]/.test(given)
        ? { ref: value.ref, action: 'select', value: given }
        : null;
    default:
      return given === null || given === undefined
        ? { ref: value.ref, action: action as RunActAction, value: null }
        : null;
  }
}
