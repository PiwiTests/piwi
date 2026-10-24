/**
 * A recording started from an editor: the editor service's launcher opens a browser with the project's own
 * Playwright and loads the recorder's IDE bundle (`record-ide.js`) into every page. The bundle reads its
 * `chrome.*` surface from {@link IDE_CHROME_GLOBAL}, which it builds over the {@link IDE_RECORDER_BINDING}
 * binding the launcher exposes; every request below goes through that binding.
 */

/** The page binding the launcher exposes in every page of the recording browser. */
export const IDE_RECORDER_BINDING = '__piwiRecorder';

/** The global the IDE bundle's `chrome` references are rewritten to at build time. */
export const IDE_CHROME_GLOBAL = '__piwiIdeChrome';

/**
 * The global the IDE bundle's host installs to hand the recorder a message from the launcher, as
 * `chrome.runtime.onMessage` hands an extension's: {@link IdeRecorderPaused} when the editor pauses or resumes.
 */
export const IDE_DISPATCH_GLOBAL = '__piwiIdeDispatch';

/** The message that pauses or resumes a recording, in both directions: the recorder's Pause, the editor's. */
export const IDE_PAUSED_MESSAGE = 'piwi-recording-paused';

/** While a recording is paused, nothing done in the browser is recorded, and the editor writes nothing. */
export interface IdeRecorderPaused {
  type: typeof IDE_PAUSED_MESSAGE;
  paused: boolean;
}

/** `chrome.storage.local` key under which the launcher hands the recorder its settings. */
export const IDE_SETTINGS_KEY = 'piwiIdeSettings';

/** What the launcher tells the recorder. */
export interface IdeRecorderSettings {
  /** The name of the file the steps are written into, shown in the recorder's panel; null when unknown. */
  file: string | null;
  /** The project's `testIdAttribute`; null for Playwright's default, `data-testid`. */
  testIdAttribute: string | null;
}

/** A call from the page to the launcher. */
export type IdeRecorderRequest =
  | { kind: 'message'; message: unknown }
  | { kind: 'local-get'; keys: string | string[] | Record<string, unknown> | null }
  | { kind: 'local-set'; items: Record<string, unknown> }
  | { kind: 'local-remove'; keys: string | string[] };

/**
 * A test paused in a run the editor started hands its page to the editor's recorder over the record channel: a local
 * socket the editor service listens on (a Unix socket in a private folder, a named pipe on Windows), which the run's
 * environment names as `PIWI_RECORD_CHANNEL`, `<socket path>#<token>`. Each message is one line of JSON. The test's
 * worker asks first (`attach`); once the editor takes the recording, it loads the recorder's IDE bundle into the page,
 * relays each call of the binding to the editor service, which answers it as the launcher does, and hands the page
 * what the editor sends, until the recording stops.
 */
export const RECORD_CHANNEL_ENV = 'PIWI_RECORD_CHANNEL';

/** Where a test reaches the editor's recorder: the socket's path, and the token every attach carries. */
export interface RecordChannel {
  path: string;
  token: string;
}

/** The longest line either side reads; a line past it ends the channel. */
export const MAX_HANDOFF_LINE = 4_000_000;

/** The value of `PIWI_RECORD_CHANNEL`. */
export function formatRecordChannel(channel: RecordChannel): string {
  return `${channel.path}#${channel.token}`;
}

/** Read `PIWI_RECORD_CHANNEL`; null unless it names a path and a token of at least 16 URL-safe characters. */
export function parseRecordChannel(value: string | null | undefined): RecordChannel | null {
  const text = value?.trim() ?? '';
  const hash = text.lastIndexOf('#');
  if (hash <= 0) return null;
  const token = text.slice(hash + 1);
  const path = text.slice(0, hash);
  return /^[A-Za-z0-9_-]{16,}$/.test(token) && !path.includes('\0') ? { path, token } : null;
}

/** Why a test hands its page over: a breakpoint's pause bar, or `page.pause()`. */
export type HandoffReason = 'breakpoint' | 'pause';

/** What the test's worker sends the editor service. */
export type HandoffToEditor =
  /**
   * Record from here: the line (1-based) of `file` (absolute) the test is paused before, why, and what the recording
   * reads from the test's project.
   */
  | {
      type: 'attach';
      token: string;
      file: string;
      line: number;
      reason: HandoffReason;
      testIdAttribute: string | null;
      baseURL: string | null;
    }
  /** The recorder's IDE bundle is loaded into the page. */
  | { type: 'loaded' }
  /** A call of the recorder's binding, from the paused page's main frame or from `outside` it. */
  | { type: 'binding'; call: number; outside: boolean; payload: unknown }
  /** Something the person should know that does not end the recording: the application opened a tab. */
  | { type: 'notice'; message: string }
  /** The page closed, or the test ended. */
  | { type: 'closed' };

/** What the editor service sends the test's worker. */
export type HandoffToTest =
  /** No recording starts: why, in one sentence. */
  | { type: 'refused'; message: string }
  /** The editor took the recording: load the recorder's IDE bundle (a file of the editor's) into the page. */
  | { type: 'load'; bundle: string }
  /** The answer to a call of the binding. */
  | { type: 'answer'; call: number; value: unknown }
  /** A message for the recorder in the page (`__piwiIdeDispatch`): a pause, a resume, a stop. */
  | { type: 'dispatch'; message: unknown }
  /** The recording ended: the page is answered as outside a recording from now on. */
  | { type: 'stop' };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A line the test's worker sent, checked field by field; null when it is not one. */
export function parseHandoffToEditor(line: string): HandoffToEditor | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  switch (value.type) {
    case 'attach': {
      const { token, file, line: at, reason, testIdAttribute, baseURL } = value;
      if (typeof token !== 'string' || typeof file !== 'string' || !file || file.includes('\0')) return null;
      if (typeof at !== 'number' || !Number.isInteger(at) || at < 1) return null;
      if (reason !== 'breakpoint' && reason !== 'pause') return null;
      const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
      return {
        type: 'attach',
        token,
        file,
        line: at,
        reason,
        testIdAttribute: text(testIdAttribute),
        baseURL: text(baseURL),
      };
    }
    case 'loaded':
    case 'closed':
      return { type: value.type };
    case 'binding':
      return typeof value.call === 'number' && Number.isInteger(value.call)
        ? { type: 'binding', call: value.call, outside: value.outside === true, payload: value.payload }
        : null;
    case 'notice':
      return typeof value.message === 'string' ? { type: 'notice', message: value.message.slice(0, 500) } : null;
    default:
      return null;
  }
}

/** A line the editor service sent, checked field by field; null when it is not one. */
export function parseHandoffToTest(line: string): HandoffToTest | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  switch (value.type) {
    case 'refused':
      return typeof value.message === 'string' ? { type: 'refused', message: value.message } : null;
    case 'load':
      return typeof value.bundle === 'string' && value.bundle ? { type: 'load', bundle: value.bundle } : null;
    case 'answer':
      return typeof value.call === 'number' ? { type: 'answer', call: value.call, value: value.value } : null;
    case 'dispatch':
      return { type: 'dispatch', message: value.message };
    case 'stop':
      return { type: 'stop' };
    default:
      return null;
  }
}

/**
 * Splits a stream of text into lines as they arrive, handing each complete one to `onLine`. A line longer than
 * {@link MAX_HANDOFF_LINE} calls `onOverflow` and drops what was buffered.
 */
export function lineReader(onLine: (line: string) => void, onOverflow: () => void): (chunk: string) => void {
  let buffered = '';
  return (chunk) => {
    buffered += chunk;
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (line.trim()) onLine(line);
    }
    if (buffered.length > MAX_HANDOFF_LINE) {
      buffered = '';
      onOverflow();
    }
  };
}
