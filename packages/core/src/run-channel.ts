/**
 * The run channel: each worker of a test run the editor started keeps one connection, from before its first test to
 * its end, to the local socket the editor service listens on for the record channel's hand-offs
 * (`@piwitests/core/ide-recorder`). The run's environment names it as `PIWI_RUN_CHANNEL`, `<socket path>#<token>`
 * as `PIWI_RECORD_CHANNEL` is (`formatRecordChannel`, `parseRecordChannel`). Its first line, `run-attach`, tells it
 * from a hand-off's `attach`. Over it the worker says which test it runs and where it stopped, and the editor service
 * steers it: pause, step, resume, finish, run to a line, the breakpoints, an image of the stopped page, and, at a stop
 * the pause bar shows, the bar's own **Pick a locator** and **Record here**, the check panel's **Check an element** and
 * a region's ARIA snapshot, started from outside the page; at any stop, the responses the test kept (an interactive
 * run keeps the text bodies of its pages' fetch and XHR answers), one of them to mock, and a locator's matches. Each
 * message is one line of JSON, at most `MAX_HANDOFF_LINE` long (`lineReader`), checked field by field on both sides. A
 * side ignores a message it cannot read.
 */
export const RUN_CHANNEL_ENV = 'PIWI_RUN_CHANNEL';

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

/** An image of a stopped page: a JPEG, base64. */
export interface PausedImage {
  mime: 'image/jpeg';
  data: string;
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

/** What a worker's `run-attach` lists in `takes`. */
export type RunTake = RunIntent | RunQuery;

/** The intents a worker takes. */
export const RUN_INTENTS: readonly RunIntent[] = ['pick', 'record', 'assert', 'assert-region'];

/** Everything a worker takes, as its `run-attach` lists it: a worker of an older reporter lists fewer, or none. */
export const RUN_TAKES: readonly RunTake[] = [...RUN_INTENTS, 'requests', 'mock', 'locator'];

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

/** What a worker sends the editor service on its run connection. */
export type RunToHub =
  /**
   * The first line: the channel's token, the ref of the command that started the run (`PIWI_ORIGIN_REF`), the run's
   * working directory, which every `Place` is relative to, the worker (Playwright's `workerIndex` and
   * `parallelIndex`, its process), the versions of Playwright and of the reporter, and the intents and queries it
   * takes (`takes`), none for a worker of a reporter that predates them.
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
  /**
   * At the stop `stop`, after `assert-region`: the region picked in the test's window, as the locator the person
   * confirmed, and its ARIA snapshot (`locator.ariaSnapshot()`), at most `MAX_REGION_SNAPSHOT` characters.
   */
  | { type: 'region'; stop: number; locator: string; snapshot: string }
  /** Something the person should know: a message of the editor's this worker did not apply, and why. */
  | { type: 'notice'; message: string };

/** What the editor service sends a worker on its run connection. */
export type HubToRun =
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
  | { type: 'request'; request: number; what: 'locator'; stop: number; locator: string | null };

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
  if (!Array.isArray(value) || value.length > 16) return [];
  return RUN_TAKES.filter((take) => value.includes(take));
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

/** The most breakpoints one message carries. */
const MAX_PLACES = 10_000;

/** Base64, as an image's data is written. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A line a worker sent, checked field by field; null when it is not one. */
export function parseRunToHub(line: string): RunToHub | null {
  const value = readJson(line);
  if (!value) return null;
  switch (value.type) {
    case 'run-attach': {
      const { token, ref, cwd, workerIndex, parallelIndex, pid } = value;
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
      if (what !== 'image') return null;
      if (answered === null) return { type: 'answer', request, what, value: null };
      if (!isObject(answered) || answered.mime !== 'image/jpeg') return null;
      if (typeof answered.data !== 'string' || !answered.data || !BASE64.test(answered.data)) return null;
      return { type: 'answer', request, what, value: { mime: 'image/jpeg', data: answered.data } };
    }
    case 'region': {
      const { stop, locator, snapshot } = value;
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
      if (!isIntent(what) && what !== 'requests' && what !== 'mock' && what !== 'locator') {
        return unknown(`request ${what}`);
      }
      if (!isInt(stop, 1)) return null;
      if (isIntent(what) || what === 'requests') return { type: 'request', request, what, stop };
      if (what === 'mock') return isInt(value.id, 1) ? { type: 'request', request, what, stop, id: value.id } : null;
      const { locator } = value;
      return locator === null || isLocatorText(locator) ? { type: 'request', request, what, stop, locator } : null;
    }
    default:
      return typeof value.type === 'string' && value.type ? unknown(value.type) : null;
  }
}
