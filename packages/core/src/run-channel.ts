/**
 * The run channel: each worker of a test run the editor started keeps one connection, from before its first test to
 * its end, to the local socket the editor service listens on for the record channel's hand-offs
 * (`@piwitests/core/ide-recorder`). The run's environment names it as `PIWI_RUN_CHANNEL`, `<socket path>#<token>`
 * as `PIWI_RECORD_CHANNEL` is (`formatRecordChannel`, `parseRecordChannel`). Its first line, `run-attach`, tells it
 * from a hand-off's `attach`. Over it the worker says which test it runs and where it stopped, and the editor service
 * steers it: pause, step, resume, finish, run to a line, the breakpoints, an image of the stopped page. Each message
 * is one line of JSON, at most `MAX_HANDOFF_LINE` long (`lineReader`), checked field by field on both sides. A side
 * ignores a message it cannot read.
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
 * to, or `page.pause()`.
 */
export type StopReason = 'breakpoint' | 'step' | 'pause' | 'run-to' | 'page-pause';

/** An image of a stopped page: a JPEG, base64. */
export interface PausedImage {
  mime: 'image/jpeg';
  data: string;
}

/** What a worker sends the editor service on its run connection. */
export type RunToHub =
  /**
   * The first line: the channel's token, the ref of the command that started the run (`PIWI_ORIGIN_REF`), the run's
   * working directory, which every `Place` is relative to, the worker (Playwright's `workerIndex` and
   * `parallelIndex`, its process), and the versions of Playwright and of the reporter.
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
   * this side does not know, from a newer reporter: a plain stop.
   */
  | {
      type: 'stopped';
      stop: number;
      reason: StopReason | 'other';
      title: string;
      place: Place;
      locator: string | null;
      bar: boolean;
    }
  /** The stop ended, whoever answered it: the bar, the editor, or the test ending under it. */
  | { type: 'running'; stop: number }
  /** The test ended: its status as Playwright gives it, and how long it stood stopped. */
  | { type: 'test-end'; testId: string; status: string; pausedMs: number }
  /** The answer to a `request`: an image of the stopped page, null when there is none. */
  | { type: 'answer'; request: number; what: 'image'; value: PausedImage | null }
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
  | { type: 'request'; request: number; what: 'image' };

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

const STOP_REASONS: readonly string[] = ['breakpoint', 'step', 'pause', 'run-to', 'page-pause'];

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
      return {
        type: 'stopped',
        stop,
        reason: STOP_REASONS.includes(reason) ? (reason as StopReason) : 'other',
        title: title.slice(0, 1000),
        place,
        locator: locator === null ? null : locator.slice(0, 1000),
        bar,
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
      if (!isInt(request, 1) || what !== 'image') return null;
      if (answered === null) return { type: 'answer', request, what, value: null };
      if (!isObject(answered) || answered.mime !== 'image/jpeg') return null;
      if (typeof answered.data !== 'string' || !answered.data || !BASE64.test(answered.data)) return null;
      return { type: 'answer', request, what, value: { mime: 'image/jpeg', data: answered.data } };
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
      if (!isInt(value.request, 1)) return null;
      if (value.what === 'image') return { type: 'request', request: value.request, what: 'image' };
      return typeof value.what === 'string' ? unknown(`request ${value.what}`) : null;
    }
    default:
      return typeof value.type === 'string' && value.type ? unknown(value.type) : null;
  }
}
