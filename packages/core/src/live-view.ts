/**
 * The run page's live view on the team instance. While a run of a project that turned it on executes, each worker
 * keeps one event stream open to the instance, with a key for that run alone that the reporter sets in the workers'
 * environment (`PIWI_LIVE_VIEW`, `<url>#<key>`, `formatLiveViewEnv`). On that stream the instance says how many people
 * watch the worker (`viewers`), and which elements its project masks (`masks`). While anyone does, the worker posts small JPEG frames of its test's page, each with the
 * call it was taken at and the title of its test, a few a second at most, and the instance relays them to those viewers
 * alone and keeps none.
 * The worker also posts when its test stops and goes on (`stop`), which the run page shows, when the test watched
 * ended (`ended`), and when the run stops being shared (`unshared`). In a CI run, while anyone watches it in full, it
 * posts too the call its test is in as Playwright logs it (`call-log`): the log's last lines, the point an input action acts on,
 * and the elements the call's locator matches while it waits. Nothing goes from the instance to the page: the
 * view never steers the run. Each message is JSON, checked field by field (`parseInstanceToWorker`,
 * `readWorkerToInstance`).
 *
 * An instance that says on the stream what its viewers ask of the images (`view`: the largest size they show one at,
 * in device pixels, the pace, and whether one of them shows the worker in full) takes each frame as its JPEG's bytes
 * behind a short JSON header, one live message (`LIVE_FRAME_TYPE`); an older instance takes the frame in base64 inside
 * JSON. The call log and the test's end go only to a full view: a worker that only tiles show posts neither, and
 * follows no call log. A viewer reads one stream of live
 * messages (`LIVE_STREAM_TYPE`): the frames of the workers it watches, their images as bytes, and the JSON messages
 * of the view (`LiveViewerMessage`). A live message is a length-prefixed JSON header, then length-prefixed bytes
 * (`encodeLiveMessage`, `createLiveMessageReader`): the dashboard and any other viewer read it with this one reader.
 *
 * Beside the images, a viewer of the worker in full may ask for the layers of `@piwitests/core/live-layers`
 * (`LiveWatchAsk`'s `layers` on the instance): the instance says which on the worker's stream (`view`'s `layers`, the
 * union of what its full views ask), and the worker posts them while asked alone, each naming its test: what the page
 * and the test's requests said (`page-event`), the page's text (`text`, as the instance asks for it, `text` on the
 * stream), and the images of its test's filmstrip (`thumb`, a live message whose data is the JPEG: the view's own masked
 * images, kept in the worker's memory for a viewer who comes later, sent again on `resend`). The instance relays each to
 * the watches that asked for that layer, and keeps none.
 *
 * A full view may also ask for **Inspect** (`view`'s `inspect`): the worker then posts the DOM snapshots its page's
 * trace takes at each call (`snapshot`) and the resources they name (`resource`), as `@piwitests/core/live-inspect`
 * says, and the instance tells each watch with Inspect open of each snapshot (`snapshot`, its data left out), which it
 * serves rendered on its own.
 *
 * A CI run's workers open their streams at once. A run outside CI holds its key too, and its workers open no stream
 * until a person shares the run (**Share live**, the run channel's `share`), and close it as the sharing stops. Such a
 * run without a key names why instead (`none:<why>`, `formatLiveViewMissing`), for the surfaces to say.
 */
import {
  LANE_THUMBS_PER_SECOND,
  MAX_LANE_THUMB,
  isLaneThumbBytes,
  isLayerTime,
  readLaneLayers,
  readLaneText,
  readLaneThumb,
  readPageEvent,
  type LaneLayer,
  type LaneText,
  type LaneThumb,
  type PageEvent,
} from './live-layers';
import {
  LIVE_INSPECT_DATA_LIMITS,
  MAX_SNAPSHOT_BYTES,
  liveSnapshotFields,
  readLiveResource,
  readLiveSnapshot,
  readLiveSnapshotFields,
  type LiveResource,
  type LiveSnapshot,
} from './live-inspect';
import { tryParseLocatorChain } from './locator-chain';
import { hideSecretsInText, hideTypedText, hideSecretsInLog } from './mask';
import type { StopReason } from './run-channel';

/** The variable that names the instance's live view endpoint of the run and its key, for the workers. */
export const LIVE_VIEW_ENV = 'PIWI_LIVE_VIEW';

/** The largest frame a worker asks the page's screencast for, in pixels: a larger viewport is scaled down to fit. */
export const LIVE_FRAME_WIDTH = 640;
export const LIVE_FRAME_HEIGHT = 400;
/** The JPEG quality a worker asks the page's screencast for. */
export const LIVE_FRAME_QUALITY = 50;
/** The most frames a worker sends a second. */
export const LIVE_FRAME_FPS = 4;
/**
 * The most bytes of frames a worker sends a second: a heavier frame holds the next one back longer, so a page whose
 * screencast another client sized (a test's video, at its size and quality 90) sends fewer of them.
 */
export const LIVE_FRAME_BYTE_RATE = 256 * 1024;
/** The longest frame, in bytes of JPEG: a longer one is dropped, and a lighter image of the page goes in its place. */
export const MAX_LIVE_FRAME = 192 * 1024;
/** The largest image a viewer asks for, in device pixels: a larger view shows it scaled up. */
export const MAX_LIVE_VIEW_WIDTH = 1280;
export const MAX_LIVE_VIEW_HEIGHT = 800;
/** A tile of **Watch all**: the size of each worker's image, in device pixels, and how many a second. */
export const LIVE_TILE_WIDTH = 320;
export const LIVE_TILE_HEIGHT = 200;
export const LIVE_TILE_FPS = 1;
/** The longest frame's data, in characters of base64. */
export const MAX_LIVE_FRAME_BASE64 = 4 * Math.ceil(MAX_LIVE_FRAME / 3);
/** The longest message a worker posts, in bytes of JSON. */
export const MAX_LIVE_MESSAGE = MAX_LIVE_FRAME_BASE64 + 8 * 1024;
/** The longest call title a message carries; a longer one is cut. */
const MAX_TITLE = 500;
/** The most lines of a call's log a message carries, folded by `compressCallLog`: its last ones. */
export const MAX_LIVE_CALL_LOG_LINES = 20;
/** The longest line of a call's log a message carries, and the longest error; a longer one is cut. */
const MAX_LOG_LINE = 300;
/** The most call logs a worker posts a second: Playwright tells a call's progress every half second. */
export const LIVE_CALL_LOGS_PER_SECOND = 4;
/** The longest refusal a message carries; a longer one is cut. */
const MAX_REFUSAL = 500;
/** The longest test title a message carries; a longer one is cut. */
const MAX_TEST_TITLE = 1000;

/** How a live view key starts: `pdl_`, then 43 characters of base64url (32 random bytes). */
export const LIVE_VIEW_KEY_PREFIX = 'pdl_';
const KEY = /^pdl_[A-Za-z0-9_-]{43}$/;

/** Whether `value` is a live view key's shape. */
export function isLiveViewKey(value: unknown): value is string {
  return typeof value === 'string' && KEY.test(value);
}

/** Where a worker reaches the instance's live view of its run, and the run's key. */
export interface LiveViewAddress {
  /** The run's live view endpoint: `<instance>/api/test-runs/<run>/live-view`. */
  url: string;
  runId: number;
  key: string;
}

/** The value of `PIWI_LIVE_VIEW` for the run `runId` of the instance at `base`. */
export function formatLiveViewEnv(base: string, runId: number, key: string): string {
  return `${base.replace(/\/+$/, '')}/api/test-runs/${runId}/live-view#${key}`;
}

/** The address `PIWI_LIVE_VIEW` names; null when it names none: not an http(s) URL of a run's endpoint with a key. */
export function parseLiveViewEnv(value: string | undefined): LiveViewAddress | null {
  if (!value || value.length > 4096) return null;
  const hash = value.lastIndexOf('#');
  if (hash < 0) return null;
  const key = value.slice(hash + 1);
  if (!isLiveViewKey(key)) return null;
  let url: URL;
  try {
    url = new URL(value.slice(0, hash));
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.search || url.username || url.password) return null;
  const run = /\/api\/test-runs\/(\d{1,15})\/live-view$/.exec(url.pathname);
  if (!run) return null;
  const runId = Number(run[1]);
  if (!Number.isSafeInteger(runId) || runId < 1) return null;
  return { url: url.toString(), runId, key };
}

/** The run's page on the instance (`<instance>/test-runs/<id>`), where a teammate watches it. */
export function liveRunPage(address: LiveViewAddress): string {
  const url = new URL(address.url);
  url.pathname = url.pathname.replace(/\/api\/test-runs\/\d+\/live-view$/, `/test-runs/${address.runId}`);
  url.hash = '';
  return url.toString();
}

/**
 * Why a run holds no live view key: it reports to no Piwi instance (`no-instance`), it reports at its end alone
 * (`streaming-off`: `streaming: false`, so it has no live run), the reporter's global setup did not register it as it
 * started (`unregistered`: the reporter entry without `wrapConfig`, or a config that does not list Piwi's reporter),
 * that setup could not register it (`setup-failed`: the instance did not answer, or refused it), the instance gave none (`off`: its project has the live view off, or the
 * instance predates it), or it reports to the desktop app on this machine, which gives none since no teammate reaches
 * it (`local`: its setup answers `liveView.refused: 'local'`).
 */
export type LiveViewMissing = 'no-instance' | 'streaming-off' | 'unregistered' | 'setup-failed' | 'off' | 'local';

const MISSING: readonly string[] = ['no-instance', 'streaming-off', 'unregistered', 'setup-failed', 'off', 'local'];

/** The value of `PIWI_LIVE_VIEW` for a run outside CI that holds no key: why. */
export function formatLiveViewMissing(why: LiveViewMissing): string {
  return `none:${why}`;
}

/** Why `PIWI_LIVE_VIEW` says the run holds no key; null when it says nothing of the kind. */
export function parseLiveViewMissing(value: string | undefined): LiveViewMissing | null {
  const why = value?.startsWith('none:') ? value.slice(5) : null;
  return why && MISSING.includes(why) ? (why as LiveViewMissing) : null;
}

/** What a surface says of a run that cannot be shared live, by why it holds no key. */
export const LIVE_SHARE_MISSING: Record<LiveViewMissing, string> = {
  'no-instance':
    "This run cannot be shared live: it reports to no Piwi instance. Name your team's instance in PIWI_DASHBOARD_URL.",
  'streaming-off':
    'This run cannot be shared live: it sends its results at its end alone (streaming: false), so it has no live run on the instance.',
  unregistered:
    "This run cannot be shared live: the reporter's global setup did not register it as it started (wrapConfig adds it, and it registers a run whose config lists Piwi's reporter).",
  'setup-failed':
    "This run cannot be shared live: the instance did not register it as it started (the reporter's global setup could not reach it, or was refused: its warning says why).",
  off: "This run cannot be shared live: its project's live view is off on the instance. A Project admin turns it on in Project → Settings → Live view.",
  local:
    "This run cannot be shared live: it reports to the Piwi desktop app on this machine, which no teammate reaches. Name your team's instance in PIWI_DASHBOARD_URL to share a run there.",
};

/** What a surface says of a run whose workers name no live view at all: a reporter that set nothing for them. */
export const LIVE_SHARE_UNKNOWN =
  'This run cannot be shared live: the Piwi reporter gave its workers no live view key.';

/**
 * Why a worker's shared stream was given up, by the instance's answer: the setting turned off (404) and the key not
 * taken (401), which the setting turned on again or a new try may lift; the key refused (403), the run no longer live
 * (410), the run held as interrupted after the retries (409); and the instance that did not answer after them.
 */
export function liveShareRefusal(status: number | null): string {
  switch (status) {
    case 404:
      return "Sharing stopped: the project's live view was turned off on the instance. Share the run again once it is back on.";
    case 401:
      return "Sharing stopped: the instance does not take this run's live view key now. Share the run again to try once more.";
    case 403:
      return "Sharing stopped: the instance refuses this run's live view key.";
    case 410:
      return 'Sharing stopped: the run is no longer live on the instance.';
    case 409:
      return 'Sharing stopped: the instance holds the run as interrupted, having heard nothing from it for a while. Share the run again once it reports there again.';
    default:
      return 'Sharing stopped: the instance did not answer. Share the run again to try once more.';
  }
}

/** A call of the test, as the run page names it: its title and its place in the user's code, when known. */
export interface LiveCall {
  title: string;
  /** The file, relative to the run's working directory, with forward slashes. */
  file: string | null;
  line: number | null;
}

/**
 * A worker of a run: its shard (null in a run that is not sharded), Playwright's worker index, and its lane (`slot`,
 * Playwright's `parallelIndex`, which a worker started again after a failure keeps; absent from an older reporter).
 */
export interface LiveWorkerId {
  shard: number | null;
  worker: number;
  slot?: number;
}

/** How a test a worker ran ended: its title, Playwright's status and how long it ran, in ms. */
export interface LiveTestOutcome {
  test: string | null;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  ms: number;
}

const OUTCOME_STATUSES: readonly string[] = ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'];

/** A test's outcome, checked field by field; null when it is not one. */
export function readLiveTestOutcome(value: unknown): LiveTestOutcome | null {
  if (!isObject(value) || !OUTCOME_STATUSES.includes(value.status as string)) return null;
  if (!isInt(value.ms, 0, 7 * 24 * 3_600_000)) return null;
  return { test: readLiveTestTitle(value.test), status: value.status as LiveTestOutcome['status'], ms: value.ms };
}

/** The title of a test a message names, cut short; null for none. */
export function readLiveTestTitle(value: unknown): string | null {
  return typeof value === 'string' && value ? value.slice(0, MAX_TEST_TITLE) : null;
}

/** A stop of a worker's test: why, the call it holds, and the test's title, which tells its row from the one before. */
export interface LiveStop {
  reason: StopReason | 'other';
  call: LiveCall;
  test: string | null;
}

/** A box on the test's page, in its viewport's pixels. */
export interface LiveBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The call a worker's test is in, as Playwright logs it while it runs: in a CI run, while anyone watches the worker.
 * Every text has the text a call types hidden (`hideTypedText`, `hideSecretsInLog`) and its credentials too
 * (`hideSecretsInText`).
 */
export interface LiveCallLog {
  /** Playwright's id of the call: another id is another call. */
  id: string;
  call: LiveCall;
  status: 'running' | 'passed' | 'failed';
  /**
   * The call log's last lines, oldest first, `MAX_LIVE_CALL_LOG_LINES` at most, written as Playwright writes a failed
   * call's log (`compressCallLog`).
   */
  lines: string[];
  /** Where an input action acts, once Playwright knows it. */
  point: { x: number; y: number } | null;
  /**
   * While the call waits: how many elements its locator matches, the first one's box, and whether that one is
   * enabled. Null for a call without a locator, or one that did not wait.
   */
  target: { count: number; box: LiveBox | null; enabled: boolean | null } | null;
  /** The size of the page's viewport, which the point and the box are measured in. */
  viewport: { width: number; height: number } | null;
  /** How long the call had run when the worker posted this, in milliseconds. */
  ms: number;
  /** The first line of the error the call ended with. */
  error: string | null;
}

/** The most locators a project lists for the live view to mask, beside the secret fields. */
export const MAX_LIVE_MASKS = 20;
/** The longest locator a project lists for the live view to mask. */
export const MAX_LIVE_MASK_LENGTH = 200;

/** The calls that enter or leave a frame: a mask names an element, which the worker looks for in every frame. */
const FRAME_CALLS: ReadonlySet<string> = new Set(['frameLocator', 'contentFrame', 'owner']);
/** The calls that act on the elements before them, which a chain cannot start with. */
const NARROWING_CALLS: ReadonlySet<string> = new Set(['filter', 'and', 'or', 'visible', 'first', 'last', 'nth']);

/**
 * Why `locator` cannot be one of a project's masked elements, as a person reads it; null when it can: a Playwright
 * locator expression (`getByLabel('IBAN')`), as `@piwitests/core/locator-chain` reads it, that names elements without
 * entering a frame.
 */
export function liveMaskProblem(locator: string): string | null {
  if (!locator.trim()) return 'A masked element needs a locator.';
  if (locator.length > MAX_LIVE_MASK_LENGTH) return `A locator is ${MAX_LIVE_MASK_LENGTH} characters at most.`;
  const source = locator.trim();
  const chain = tryParseLocatorChain(source);
  if (!chain?.calls.length || NARROWING_CALLS.has(chain.calls[0]!.method)) {
    return `\`${source}\` is not a Playwright locator, such as getByLabel('IBAN').`;
  }
  if (chain.calls.some((call) => FRAME_CALLS.has(call.method))) {
    return `\`${source}\` enters a frame: masks are looked for in every frame of the page, so name the element alone, such as getByLabel('Card number'), or the iframe, such as locator('iframe#card').`;
  }
  return null;
}

/** A project's masked elements as a message or a setting holds them: trimmed locators, each once; null when not. */
export function parseLiveMasks(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_LIVE_MASKS) return null;
  const locators: string[] = [];
  for (const locator of value) {
    if (typeof locator !== 'string' || liveMaskProblem(locator)) return null;
    if (!locators.includes(locator.trim())) locators.push(locator.trim());
  }
  return locators;
}

/**
 * What the instance says on a worker's stream: how many people watch the worker now, the elements its project
 * masks beside the secret fields (`masks`), first as the stream opens and again when the project changes them, and
 * what its viewers ask of the images (`view`): the largest size one of them shows the image at, in device pixels,
 * within `MAX_LIVE_VIEW_WIDTH` by `MAX_LIVE_VIEW_HEIGHT`, the most images a second one of them takes
 * (`LIVE_FRAME_FPS` for the full view of the worker, `LIVE_TILE_FPS` for tiles alone), and whether one of them shows
 * it in full (`full`): only then does the worker follow and post its test's call log and post the test's end, and an
 * instance that does not say it is read as one that does. An instance that says `view` takes frames as live messages
 * (`LIVE_FRAME_TYPE`). `resend` asks the worker for its latest image and call log again: a watch that showed it as a
 * tile shows it in full now, which changes neither the count nor what they ask. A list this reader cannot read
 * (`locators: null`, from an instance newer than it) masks nothing it could trust. `view`'s `layers` are the layers its
 * full views ask beside the images (`@piwitests/core/live-layers`: `events`, `text` and `filmstrip`; the call log goes
 * with `full`), none from an instance that does not say them; `text` asks for the page's text now (a viewer asked).
 * `view`'s `inspect` says a full view has Inspect open (`@piwitests/core/live-inspect`), false from an instance that
 * does not say it.
 */
export type InstanceToWorker =
  | { type: 'viewers'; count: number }
  | { type: 'masks'; locators: string[] | null }
  | {
      type: 'view';
      width: number;
      height: number;
      fps: number;
      full: boolean;
      layers: LaneLayer[];
      inspect: boolean;
    }
  | { type: 'resend' }
  | { type: 'text' };

/**
 * The size of an image a viewer asks for, in device pixels, from a message or a query: within a tile's size and
 * `MAX_LIVE_VIEW_WIDTH` by `MAX_LIVE_VIEW_HEIGHT`; null when either is not a whole number from 1.
 */
export function readLiveViewSize(width: unknown, height: unknown): { width: number; height: number } | null {
  const w = wholeNumber(width);
  const h = wholeNumber(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return null;
  return {
    width: Math.min(MAX_LIVE_VIEW_WIDTH, Math.max(LIVE_TILE_WIDTH, w)),
    height: Math.min(MAX_LIVE_VIEW_HEIGHT, Math.max(LIVE_TILE_HEIGHT, h)),
  };
}

/** What a worker posts to the instance. */
export type WorkerToInstance =
  /**
   * A frame of the test's page, a JPEG in base64, the call it was taken at, the test's title and, from a reporter that
   * says it, when the page looked so, in epoch milliseconds (`at`): the browser's paint time, at most the worker's clock.
   */
  | (LiveWorkerId & { type: 'frame'; data: string; call: LiveCall | null; test: string | null; at?: number })
  /** Why no frame goes: the sentence the viewers see in place of the view. */
  | (LiveWorkerId & { type: 'frame'; refused: string })
  /** The worker's test stopped (its call), or went on (null). */
  | (LiveWorkerId & { type: 'stop'; stop: LiveStop | null })
  /** The call the worker's test is in, as Playwright logs it, and the test's title, as a frame names it. */
  | (LiveWorkerId & { type: 'call-log'; log: LiveCallLog; test: string | null })
  /** The test the viewers watched ended, how when the worker knows (`outcome`), or none runs. */
  | (LiveWorkerId & { type: 'ended'; outcome?: LiveTestOutcome | null })
  /** The person who shared the run stopped sharing it: the viewers' views close, and the worker's stream after them. */
  | (LiveWorkerId & { type: 'unshared' })
  /** Something the page or the test's requests said, when (`at`, epoch ms), while a viewer asked for `events`. */
  | (LiveWorkerId & { type: 'page-event'; event: PageEvent; at: number; test: string | null })
  /** The page's text, while a viewer asked for `text`, or why none goes. */
  | (LiveWorkerId & { type: 'text'; text: LaneText; test: string | null })
  | (LiveWorkerId & { type: 'text'; refused: string; test: string | null });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** A whole number as a message or a query writes it: a number, or its digits; NaN for anything else. */
function wholeNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : Number.NaN;
}

/** A worker's shard, index and lane, from a message or a query: null when the shard or the index is not one. */
export function readLiveWorkerId(shard: unknown, worker: unknown, slot?: unknown): LiveWorkerId | null {
  const shardValue = shard === null || shard === undefined || shard === '' ? null : wholeNumber(shard);
  const workerValue = wholeNumber(worker);
  if (shardValue !== null && !isInt(shardValue, 1, 10_000)) return null;
  if (!isInt(workerValue, 0, 100_000)) return null;
  const slotValue = wholeNumber(slot);
  return isInt(slotValue, 0, 10_000)
    ? { shard: shardValue, worker: workerValue, slot: slotValue }
    : { shard: shardValue, worker: workerValue };
}

/** The key the instance files a worker under: `<shard>:<worker>`, the shard empty in a run that is not sharded. */
export function liveWorkerKey(id: LiveWorkerId): string {
  return `${id.shard ?? ''}:${id.worker}`;
}

/** The key of a worker's lane, its shard and its slot (`<shard>#<slot>`), which a restarted worker keeps. */
export function liveLaneKey(lane: { shard: number | null; slot: number }): string {
  return `${lane.shard ?? ''}#${lane.slot}`;
}

const STOP_REASONS: readonly string[] = ['breakpoint', 'step', 'pause', 'run-to', 'page-pause', 'failure', 'other'];

/**
 * A call, checked field by field, its title cut short and the text a fill, a typing or an insert types hidden
 * (`hideTypedText`); null when it is not one.
 */
export function readLiveCall(value: unknown): LiveCall | null {
  if (!isObject(value) || typeof value.title !== 'string' || !value.title.trim()) return null;
  const { file, line } = value;
  const named = typeof file === 'string' && file.length > 0 && file.length <= 1024 && !/[\0\r\n]/.test(file);
  return {
    title: hideTypedText(value.title).slice(0, MAX_TITLE),
    file: named ? file : null,
    line: named && isInt(line, 1, 10_000_000) ? line : null,
  };
}

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100_000;
}

/** The longest run of lines `compressCallLog` looks for repeats of: a retry of an action logs four. */
const LONGEST_REPEAT = 12;

/** Whether the `size` lines from `a` are the `size` lines from `b`. */
function sameLines(lines: readonly string[], a: number, b: number, size: number): boolean {
  for (let k = 0; k < size; k++) if (lines[a + k] !== lines[b + k]) return false;
  return true;
}

/**
 * A call's log lines as Playwright writes them in a failed call's error: each line an item (`- `) at its own indent,
 * and lines repeated in a row written once, the first with its count (`6 × retrying click action`). From each line on,
 * the repeat covering the most lines wins, as Playwright's `compressCallLog` picks it.
 */
export function compressCallLog(lines: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let size = 1;
    let count = 1;
    for (let length = 1; length <= LONGEST_REPEAT && i + length * 2 <= lines.length; length++) {
      let times = 1;
      while (i + length * (times + 1) <= lines.length && sameLines(lines, i, i + length * times, length)) times++;
      if (times > 1 && times * length > count * size) {
        size = length;
        count = times;
      }
    }
    for (let k = 0; k < size; k++) {
      const line = lines[i + k]!;
      const indent = /^\s*/.exec(line)![0];
      if (count === 1) out.push(`${indent}- ${line.trim()}`);
      else if (k === 0) out.push(`${indent}${count} × ${line.trim()}`);
      else out.push(`${indent}${' '.repeat(`${count} × `.length - 2)}- ${line.trim()}`);
    }
    i += size * count;
  }
  return out;
}

/** A call's log or its error, as a viewer may read it: what may be a secret in it hidden, then cut. */
function logText(value: string): string {
  return hideSecretsInText(hideSecretsInLog(value)).slice(0, MAX_LOG_LINE);
}

/** A call's log, checked field by field and its texts hidden again; null when it is not one. */
export function readLiveCallLog(value: unknown): LiveCallLog | null {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id || value.id.length > 100) return null;
  const call = readLiveCall(value.call);
  if (!call) return null;
  if (value.status !== 'running' && value.status !== 'passed' && value.status !== 'failed') return null;
  // Hidden as one text, so a value an assertion quotes goes when an earlier line names a secret field.
  const lines = Array.isArray(value.lines)
    ? hideSecretsInText(
        hideSecretsInLog(value.lines.filter((line): line is string => typeof line === 'string').join('\n')),
      )
        .split('\n')
        .slice(-MAX_LIVE_CALL_LOG_LINES)
        .map((line) => line.slice(0, MAX_LOG_LINE))
    : [];
  const point =
    isObject(value.point) && isCoordinate(value.point.x) && isCoordinate(value.point.y)
      ? { x: value.point.x, y: value.point.y }
      : null;
  let target: LiveCallLog['target'] = null;
  if (isObject(value.target) && isInt(value.target.count, 0, 1_000_000)) {
    const box = value.target.box;
    target = {
      count: value.target.count,
      box:
        isObject(box) &&
        isCoordinate(box.x) &&
        isCoordinate(box.y) &&
        isCoordinate(box.width) &&
        isCoordinate(box.height)
          ? { x: box.x, y: box.y, width: box.width, height: box.height }
          : null,
      enabled: typeof value.target.enabled === 'boolean' ? value.target.enabled : null,
    };
  }
  const viewport =
    isObject(value.viewport) && isInt(value.viewport.width, 1, 20_000) && isInt(value.viewport.height, 1, 20_000)
      ? { width: value.viewport.width, height: value.viewport.height }
      : null;
  return {
    id: value.id,
    call: { ...call, title: hideSecretsInText(call.title) },
    status: value.status,
    lines,
    point,
    target,
    viewport,
    ms: isInt(value.ms, 0, 86_400_000) ? value.ms : 0,
    error: typeof value.error === 'string' && value.error.trim() ? logText(value.error.split('\n')[0]!) : null,
  };
}

/** Base64, as a frame's data is written. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** How a JPEG's first three bytes (`FF D8 FF`) are written in base64. */
const JPEG_BASE64 = '/9j/';

/** Whether `value` is a time in epoch milliseconds: a finite number after 2001. */
export function isEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 1e12;
}

/** Whether `data` is a live frame's data: base64, not empty, at most `MAX_LIVE_FRAME_BASE64` characters. */
export function isLiveFrameData(data: unknown): data is string {
  return typeof data === 'string' && data.length > 0 && data.length <= MAX_LIVE_FRAME_BASE64 && BASE64.test(data);
}

/** A message a worker posted, checked field by field; why not, as a sentence, when it is not one this version reads. */
export function readWorkerToInstance(value: unknown): WorkerToInstance | string {
  if (!isObject(value)) return 'The message is not an object.';
  const id = readLiveWorkerId(value.shard, value.worker, value.slot);
  if (!id) return 'The message names no worker: a worker index, and a shard from 1 when the run is sharded.';
  switch (value.type) {
    case 'frame': {
      if (typeof value.refused === 'string' && value.refused.trim()) {
        return { type: 'frame', ...id, refused: value.refused.slice(0, MAX_REFUSAL) };
      }
      if (!isLiveFrameData(value.data) || !value.data.startsWith(JPEG_BASE64)) {
        return `A frame is a JPEG in base64, ${MAX_LIVE_FRAME / 1024} KB at most.`;
      }
      const call = value.call === null || value.call === undefined ? null : readLiveCall(value.call);
      const frame = { type: 'frame' as const, ...id, data: value.data, call, test: readLiveTestTitle(value.test) };
      return isEpochMs(value.at) ? { ...frame, at: Math.round(value.at) } : frame;
    }
    case 'stop': {
      if (value.stop === null) return { type: 'stop', ...id, stop: null };
      if (!isObject(value.stop)) return 'A stop names its reason and its call, or is null.';
      const call = readLiveCall(value.stop.call);
      if (!call) return 'A stop names the call it holds.';
      const reason = STOP_REASONS.includes(value.stop.reason as string)
        ? (value.stop.reason as LiveStop['reason'])
        : 'other';
      return { type: 'stop', ...id, stop: { reason, call, test: readLiveTestTitle(value.stop.test) } };
    }
    case 'call-log': {
      const log = readLiveCallLog(value.log);
      return log
        ? { type: 'call-log', ...id, log, test: readLiveTestTitle(value.test) }
        : 'A call log names its call, its status and its lines.';
    }
    case 'ended': {
      const outcome = readLiveTestOutcome(value.outcome);
      return outcome ? { type: 'ended', ...id, outcome } : { type: 'ended', ...id };
    }
    case 'unshared':
      return { type: 'unshared', ...id };
    case 'page-event': {
      const event = readPageEvent(value.event);
      return event && isLayerTime(value.at)
        ? { type: 'page-event', ...id, event, at: value.at, test: readLiveTestTitle(value.test) }
        : 'A page event names its kind, its fields and when it happened.';
    }
    case 'text': {
      const test = readLiveTestTitle(value.test);
      if (typeof value.refused === 'string' && value.refused.trim()) {
        return { type: 'text', ...id, refused: value.refused.slice(0, MAX_REFUSAL), test };
      }
      const text = readLaneText(value.text);
      return text ? { type: 'text', ...id, text, test } : 'A text names its source, its text and when it was taken.';
    }
    default:
      return 'The message is of a type other than frame, stop, call-log, ended, unshared, page-event or text.';
  }
}

/** A message of the instance on a worker's stream (the `data` of one event); null when it is not one. */
export function parseInstanceToWorker(data: string): InstanceToWorker | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  if (value.type === 'masks') return { type: 'masks', locators: parseLiveMasks(value.locators) };
  if (value.type === 'view') {
    const size = typeof value.width === 'number' ? readLiveViewSize(value.width, value.height) : null;
    if (!size || !isInt(value.fps, 1, 60)) return null;
    const full = typeof value.full === 'boolean' ? value.full : true;
    const layers = (readLaneLayers(value.layers) ?? []).filter((layer) => layer !== 'calls');
    const inspect = value.inspect === true;
    return { type: 'view', ...size, fps: Math.min(LIVE_FRAME_FPS, value.fps), full, layers, inspect };
  }
  if (value.type === 'resend') return { type: 'resend' };
  if (value.type === 'text') return { type: 'text' };
  if (value.type !== 'viewers' || !isInt(value.count, 0, 1_000_000)) return null;
  return { type: 'viewers', count: value.count };
}

/** The media type of a frame a worker posts to an instance that says `view`: one live message, the JPEG its data. */
export const LIVE_FRAME_TYPE = 'application/vnd.piwi.live-frame';
/** The media type of a viewer's watch: live messages one after another, a heartbeat among them every 15 seconds. */
export const LIVE_STREAM_TYPE = 'application/vnd.piwi.live-stream';
/** The longest header of a live message, in bytes of JSON. */
export const MAX_LIVE_HEADER = 64 * 1024;
/** The longest live message a worker posts as `LIVE_FRAME_TYPE`, in bytes: a frame's, or an image of a filmstrip's. */
export const MAX_LIVE_FRAME_MESSAGE = 8 + MAX_LIVE_HEADER + MAX_LIVE_FRAME;
/** The longest live message a worker posts as `LIVE_FRAME_TYPE` while Inspect is open: a snapshot's, in bytes. */
export const MAX_LIVE_INSPECT_MESSAGE = 8 + MAX_LIVE_HEADER + MAX_SNAPSHOT_BYTES;
/**
 * The bounds a reader of what a worker posts holds each live message to: a frame's data, and the larger data of the
 * Inspect types (`snapshot`, `resource`) for those types alone.
 */
export const LIVE_WORKER_POST_LIMITS: LiveMessageLimits = { maxData: MAX_LIVE_FRAME, byType: LIVE_INSPECT_DATA_LIMITS };

/**
 * A live message: a JSON object (`header`), and bytes (`data`, an image), null when it carries none. On the wire, the
 * header's length in bytes as a 32-bit unsigned big-endian number, the header as UTF-8 JSON, the data's length the
 * same way, then the data. A message whose two lengths are 0 is a heartbeat, which a reader passes over.
 */
export interface LiveMessage {
  header: Record<string, unknown>;
  data: Uint8Array | null;
}

/**
 * The bounds a reader holds each live message to, in bytes: its header (`MAX_LIVE_HEADER` unless said) and its data,
 * `maxData` unless its header's `type` is one of `byType`'s, which says the bound of that type's data.
 */
export interface LiveMessageLimits {
  maxHeader?: number;
  maxData: number;
  byType?: Readonly<Record<string, number>>;
}

/** The most data a message of the header `header` carries under `limits`. */
function maxDataOf(limits: LiveMessageLimits, header: Record<string, unknown>): number {
  const type = header.type;
  return typeof type === 'string' && limits.byType && Object.prototype.hasOwnProperty.call(limits.byType, type)
    ? limits.byType[type]!
    : limits.maxData;
}

/** A heartbeat: a live message with no header and no data, which a reader passes over. */
export const LIVE_HEARTBEAT = new Uint8Array(8);

/** The live message of `header` and `data`, as bytes. */
export function encodeLiveMessage(header: Record<string, unknown>, data: Uint8Array | null = null): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const length = data?.length ?? 0;
  const bytes = new Uint8Array(8 + json.length + length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, json.length);
  bytes.set(json, 4);
  view.setUint32(4 + json.length, length);
  if (data) bytes.set(data, 8 + json.length);
  return bytes;
}

/** A header's JSON, read as an object; why not, as a sentence. */
function readHeader(bytes: Uint8Array): Record<string, unknown> | string {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return 'A live message’s header is not JSON.';
  }
  return isObject(value) ? value : 'A live message’s header is not a JSON object.';
}

/**
 * A reader of live messages as they arrive, in chunks of any size: each call takes the next chunk and returns the
 * messages it completed, in order, heartbeats left out. A header longer than `limits.maxHeader`, data longer than its
 * type's bound (`limits.maxData`, or `limits.byType`'s), data without a header, or a header that is not a JSON object
 * throws, as soon as its length or its text is read, with a sentence that says why; the reader then throws on every call, the stream being broken. A
 * message's data is a copy of its own, which the caller keeps as long as it pleases. The bytes not read yet wait in
 * one buffer, as long as the message they begin needs once its lengths are read, whatever the chunks' sizes.
 */
export function createLiveMessageReader(limits: LiveMessageLimits): (chunk: Uint8Array) => LiveMessage[] {
  const maxHeader = limits.maxHeader ?? MAX_LIVE_HEADER;
  // The bytes not read yet, the first `size` of `buffer`, and how many must have come before reading on is worth it.
  let buffer = new Uint8Array(0);
  let size = 0;
  let need = 4;
  let broken: string | null = null;
  // The header of the message being read, once its text came whole: its data waits behind it.
  let header: Record<string, unknown> | null = null;
  const fail = (why: string): never => {
    broken = why;
    buffer = new Uint8Array(0);
    size = 0;
    throw new Error(why);
  };
  return (chunk) => {
    if (broken) throw new Error(broken);
    if (size + chunk.length > buffer.length) {
      const grown = new Uint8Array(Math.max(need, size + chunk.length));
      grown.set(buffer.subarray(0, size));
      buffer = grown;
    }
    buffer.set(chunk, size);
    size += chunk.length;
    if (size < need) return [];
    const view = new DataView(buffer.buffer, buffer.byteOffset, size);
    const messages: LiveMessage[] = [];
    let at = 0;
    need = 4;
    while (size - at >= 4) {
      const headerLength = view.getUint32(at);
      if (headerLength > maxHeader) fail(`A live message’s header is ${maxHeader} bytes at most.`);
      need = 8 + headerLength;
      if (size - at < need) break;
      const dataLength = view.getUint32(at + 4 + headerLength);
      if (headerLength === 0 && dataLength > 0) fail('A live message with data has a header.');
      if (headerLength > 0 && !header) {
        const read = readHeader(buffer.subarray(at + 4, at + 4 + headerLength));
        if (typeof read === 'string') fail(read);
        header = read as Record<string, unknown>;
      }
      const maxData = header ? maxDataOf(limits, header) : limits.maxData;
      if (dataLength > maxData) fail(`A live message’s data is ${maxData} bytes at most.`);
      need = 8 + headerLength + dataLength;
      const end = at + need;
      if (size < end) break;
      if (header) messages.push({ header, data: dataLength > 0 ? buffer.slice(end - dataLength, end) : null });
      header = null;
      at = end;
      need = 4;
    }
    // What is left begins the next message: it waits at the start of a buffer as long as that message needs.
    const left = size - at;
    const room = Math.max(need, left);
    if (buffer.length > room) {
      const kept = new Uint8Array(room);
      kept.set(buffer.subarray(at, size));
      buffer = kept;
    } else if (at > 0) {
      buffer.copyWithin(0, at, size);
    }
    size = left;
    return messages;
  };
}

/**
 * The one live message `bytes` holds, as a worker posts it: none before it nor after it; why not, as a sentence, when
 * it holds none, more than one, or one past `limits`.
 */
export function decodeLiveMessage(bytes: Uint8Array, limits: LiveMessageLimits): LiveMessage | string {
  const maxHeader = limits.maxHeader ?? MAX_LIVE_HEADER;
  const whole = 'The body holds one live message, whole.';
  if (bytes.length < 8) return whole;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0);
  if (headerLength > maxHeader) return `A live message’s header is ${maxHeader} bytes at most.`;
  if (headerLength === 0 || bytes.length < 8 + headerLength) return whole;
  const dataLength = view.getUint32(4 + headerLength);
  const header = readHeader(bytes.subarray(4, 4 + headerLength));
  if (typeof header === 'string') return header;
  const maxData = maxDataOf(limits, header);
  if (dataLength > maxData) return `A live message’s data is ${maxData} bytes at most.`;
  if (bytes.length !== 8 + headerLength + dataLength) return whole;
  return { header, data: dataLength > 0 ? bytes.slice(8 + headerLength) : null };
}

/** Whether `bytes` starts as a JPEG does. */
function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** A frame of a worker's test page as the instance reads it, from either form a worker posts: its JPEG's bytes. */
export type LiveWorkerFrame = LiveWorkerId & {
  type: 'frame';
  image: Uint8Array;
  call: LiveCall | null;
  test: string | null;
  at?: number;
};

/** The header of a frame a worker posts as a live message (`LIVE_FRAME_TYPE`); its JPEG is the message's data. */
export function liveFrameHeader(
  id: LiveWorkerId,
  frame: { call: LiveCall | null; test: string | null; at?: number },
): Record<string, unknown> {
  return {
    type: 'frame',
    ...id,
    call: frame.call,
    test: frame.test,
    ...(frame.at !== undefined && Number.isFinite(frame.at) ? { at: Math.round(frame.at) } : {}),
  };
}

/**
 * A frame a worker posted as a live message, checked field by field: its header a frame's, as `readWorkerToInstance`
 * reads one, and its data a JPEG of `MAX_LIVE_FRAME` bytes at most; why not, as a sentence, when it is not one.
 */
export function readLiveWorkerFrame(message: LiveMessage): LiveWorkerFrame | string {
  const { header, data } = message;
  if (header.type !== 'frame') return 'A live message a worker posts is a frame.';
  const id = readLiveWorkerId(header.shard, header.worker, header.slot);
  if (!id) return 'The message names no worker: a worker index, and a shard from 1 when the run is sharded.';
  if (!data || !isJpeg(data) || data.length > MAX_LIVE_FRAME) {
    return `A frame is a JPEG of ${MAX_LIVE_FRAME / 1024} KB at most.`;
  }
  const call = header.call === null || header.call === undefined ? null : readLiveCall(header.call);
  const frame: LiveWorkerFrame = { type: 'frame', ...id, image: data, call, test: readLiveTestTitle(header.test) };
  return isEpochMs(header.at) ? { ...frame, at: Math.round(header.at) } : frame;
}

/** An image of a worker's test filmstrip as the instance reads it: its fields, and its JPEG's bytes. */
export type LiveWorkerThumb = LiveWorkerId & {
  type: 'thumb';
  thumb: LaneThumb;
  image: Uint8Array;
  test: string | null;
};

/** The header of an image of a filmstrip a worker posts as a live message (`LIVE_FRAME_TYPE`); its JPEG is the data. */
export function liveThumbHeader(id: LiveWorkerId, thumb: LaneThumb, test: string | null): Record<string, unknown> {
  return { type: 'thumb', ...id, thumb, test };
}

/** The most images of a filmstrip a worker posts a second. */
export const LIVE_THUMBS_PER_SECOND = LANE_THUMBS_PER_SECOND;

/**
 * A DOM snapshot of a worker's test page, as the instance reads it while Inspect is open (`@piwitests/core/live-inspect`):
 * its header's fields (`snapshot`), its JSON's bytes (`data`) and the test's title.
 */
export type LiveWorkerSnapshot = LiveWorkerId & {
  type: 'snapshot';
  snapshot: LiveSnapshot;
  data: Uint8Array;
  test: string | null;
};

/** Why a worker sends no snapshot of its page while Inspect is open: the sentence the viewers see in its place. */
export type LiveWorkerSnapshotRefusal = LiveWorkerId & { type: 'snapshot'; refused: string; test: string | null };

/** A resource the snapshots of a worker's test page name, as the instance reads it: its header's fields, and its bytes. */
export type LiveWorkerResource = LiveWorkerId & { type: 'resource'; resource: LiveResource; data: Uint8Array };

/** The header of a snapshot a worker posts as a live message (`LIVE_FRAME_TYPE`); its JSON is the message's data. */
export function liveSnapshotHeader(
  id: LiveWorkerId,
  snapshot: LiveSnapshot,
  test: string | null,
): Record<string, unknown> {
  return { type: 'snapshot', ...id, ...liveSnapshotFields(snapshot), test };
}

/** The header of why a worker sends no snapshot, a live message without data (`LIVE_FRAME_TYPE`). */
export function liveSnapshotRefusalHeader(
  id: LiveWorkerId,
  refused: string,
  test: string | null,
): Record<string, unknown> {
  return { type: 'snapshot', ...id, refused, test };
}

/** The header of a resource a worker posts as a live message (`LIVE_FRAME_TYPE`); its bytes are the message's data. */
export function liveResourceHeader(id: LiveWorkerId, resource: LiveResource): Record<string, unknown> {
  return { type: 'resource', ...id, sha1: resource.sha1, contentType: resource.contentType };
}

/** Everything a worker posts as a live message (`LIVE_FRAME_TYPE`), as `readLiveWorkerPost` reads it. */
export type LiveWorkerPost =
  | LiveWorkerFrame
  | LiveWorkerThumb
  | LiveWorkerSnapshot
  | LiveWorkerSnapshotRefusal
  | LiveWorkerResource;

/**
 * What a worker posted as a live message, checked field by field: a frame (`readLiveWorkerFrame`), an image of its
 * test's filmstrip (`thumb`: its fields as `@piwitests/core/live-layers` reads them, its data a JPEG of
 * `MAX_LANE_THUMB` bytes at most), a DOM snapshot of its page or why none goes (`snapshot`), or a resource a snapshot
 * names (`resource`), both as `@piwitests/core/live-inspect` reads them; why not, as a sentence, when it is none of
 * them. A reader of the message itself takes the Inspect types' larger data (`LIVE_WORKER_POST_LIMITS`).
 */
export function readLiveWorkerPost(message: LiveMessage): LiveWorkerPost | string {
  const { header, data } = message;
  if (header.type !== 'thumb' && header.type !== 'snapshot' && header.type !== 'resource') {
    return readLiveWorkerFrame(message);
  }
  const id = readLiveWorkerId(header.shard, header.worker, header.slot);
  if (!id) return 'The message names no worker: a worker index, and a shard from 1 when the run is sharded.';
  if (header.type === 'snapshot') {
    const test = readLiveTestTitle(header.test);
    if (typeof header.refused === 'string' && header.refused.trim()) {
      return { type: 'snapshot', ...id, refused: header.refused.slice(0, MAX_REFUSAL), test };
    }
    const read = readLiveSnapshot(header, data);
    if (typeof read === 'string') return read;
    const { data: json, ...snapshot } = read;
    return { type: 'snapshot', ...id, snapshot, data: json, test };
  }
  if (header.type === 'resource') {
    const read = readLiveResource(header, data);
    if (typeof read === 'string') return read;
    const { data: bytes, ...resource } = read;
    return { type: 'resource', ...id, resource, data: bytes };
  }
  const thumb = readLaneThumb(header.thumb);
  if (!thumb) return 'An image of a filmstrip names its call, its title, its place, its size and when it was taken.';
  if (!data || !isLaneThumbBytes(data))
    return `An image of a filmstrip is a JPEG of ${MAX_LANE_THUMB / 1024} KB at most.`;
  return { type: 'thumb', ...id, thumb, image: data, test: readLiveTestTitle(header.test) };
}

/**
 * Why a viewer's view of a worker ended: its test ended, its worker left, the run ended, the project's live view was
 * turned off, the person who watched opened a further watch of the run, past their share, in its place (`replaced`),
 * or the developer who shared the run from their machine stopped sharing it (`unshared`).
 */
export type LiveViewEnd = 'test-ended' | 'worker-left' | 'run-ended' | 'off' | 'replaced' | 'unshared';

const VIEW_ENDS: readonly string[] = ['test-ended', 'worker-left', 'run-ended', 'off', 'replaced', 'unshared'];

/** The ends of a viewer's whole watch, after which its stream closes: every other end is its focused view's alone. */
export const LIVE_WATCH_ENDS: readonly LiveViewEnd[] = ['run-ended', 'off', 'replaced'];

/**
 * A message of a viewer's watch (`LIVE_STREAM_TYPE`). A watch shows one worker in full (its focus, a worker or the
 * worker of a lane, which it follows through the lane's next tests), each other worker's image as a tile while it
 * shows tiles (**Watch all**), or both; every message of a worker names it (`LiveWorkerId`), so the viewer files it. A
 * reader takes a message's data, an image's JPEG or a page's text, of `MAX_LIVE_FRAME` bytes at most, and its header
 * of `MAX_LIVE_HEADER`, which no message's other fields reach.
 */
export type LiveViewerMessage =
  /** The watch opened: the id its viewer names it by to change what it shows. */
  | { type: 'hello'; watch: string }
  /**
   * A frame of a worker's test page, its JPEG's bytes, the call it was taken at, the title of its test and, from a
   * reporter that says it, when the page looked so, in epoch milliseconds (`at`): the browser's paint time, at most
   * the worker's clock. A tile's frames come `LIVE_TILE_FPS` a second at most.
   */
  | (LiveWorkerId & { type: 'frame'; image: Uint8Array; call: LiveCall | null; test: string | null; at?: number })
  /** The call the focused worker's test is in, as Playwright logs it, in a CI run, and the title of its test. */
  | (LiveWorkerId & { type: 'call-log'; log: LiveCallLog; test: string | null })
  /** Why no frame of the worker shows now. */
  | (LiveWorkerId & { type: 'refused'; message: string })
  /** Something the focused worker's page or its test's requests said, as the watch asked for `events`. */
  | (LiveWorkerId & { type: 'page-event'; event: PageEvent; at: number; test: string | null })
  /**
   * The focused worker's page as text, as the watch asked for `text`, or why none goes: on the wire, the text's fields
   * in the header and its text the data (`encodeLiveViewerMessage`).
   */
  | (LiveWorkerId & { type: 'text'; text: LaneText; test: string | null })
  | (LiveWorkerId & { type: 'text'; refused: string; test: string | null })
  /** An image of the focused worker's test filmstrip, as the watch asked for `filmstrip`: its JPEG's bytes as the data. */
  | (LiveWorkerId & { type: 'thumb'; thumb: LaneThumb; image: Uint8Array; test: string | null })
  /**
   * A DOM snapshot of the focused worker's page came, as the watch has Inspect open: its call, title, moment, page,
   * frame, whether it is of the main frame and full, its place among its frame's, and when it was taken, its JSON left
   * with the instance, which serves it rendered; or why none comes (`refused`).
   */
  | (LiveWorkerId & LiveSnapshotNotice & { type: 'snapshot'; test: string | null })
  | (LiveWorkerId & { type: 'snapshot'; refused: string; test: string | null })
  /** The focused worker's test ended, how when it says (`outcome`): a view of its lane stays for the next. */
  | (LiveWorkerId & { type: 'test-ended'; outcome: LiveTestOutcome | null })
  /**
   * The focused view ended (it names its worker), with how its test ended when that is why, or the whole watch ended
   * (`LIVE_WATCH_ENDS`, no worker named): its stream closes after it.
   */
  | (Partial<LiveWorkerId> & { type: 'end'; reason: LiveViewEnd; outcome?: LiveTestOutcome | null });

/**
 * The most bytes of a page's text a watch's message carries, in UTF-8: a frame's, which every reader of a watch takes
 * as its data. A longer text is cut where a character ends, and says so (`cut`).
 */
const MAX_LIVE_TEXT_DATA = MAX_LIVE_FRAME;

/**
 * The live message of a watch's message: its image, or its page's text in UTF-8 (`MAX_LIVE_TEXT_DATA` bytes at most),
 * as the data, every other field in the header.
 */
export function encodeLiveViewerMessage(message: LiveViewerMessage): Uint8Array {
  if (message.type === 'frame' || message.type === 'thumb') {
    const { image, ...header } = message;
    return encodeLiveMessage(header as unknown as Record<string, unknown>, image);
  }
  if (message.type === 'text' && 'text' in message) {
    const {
      text: { text, ...fields },
      ...header
    } = message;
    let data = new TextEncoder().encode(text);
    const cut = data.length > MAX_LIVE_TEXT_DATA;
    if (cut) {
      data = new Uint8Array(MAX_LIVE_TEXT_DATA);
      data = data.subarray(0, new TextEncoder().encodeInto(text, data).written);
    }
    return encodeLiveMessage({ ...header, text: { ...fields, cut: fields.cut || cut } }, data);
  }
  return encodeLiveMessage(message as unknown as Record<string, unknown>);
}

/** What a watch hears of a snapshot: its header's fields but the resources it names. */
export type LiveSnapshotNotice = Omit<LiveSnapshot, 'resources'>;

const WATCH_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** A snapshot's notice to a watch, checked field by field as a snapshot's header is; null when it is not one. */
function readSnapshotNotice(value: Record<string, unknown>): LiveSnapshotNotice | null {
  const read = readLiveSnapshotFields({ ...value, resources: [] });
  if (typeof read === 'string') return null;
  const { call, title, phase, page, frame, main, full, index, at } = read;
  return { call, title, phase, page, frame, main, full, index, at };
}

/** A live message of a viewer's watch, checked field by field; null when it is not one this version reads. */
export function readLiveViewerMessage(message: LiveMessage): LiveViewerMessage | null {
  const value = message.header;
  if (value.type === 'hello') {
    return typeof value.watch === 'string' && WATCH_ID.test(value.watch) ? { type: 'hello', watch: value.watch } : null;
  }
  if (value.type === 'end') {
    if (!VIEW_ENDS.includes(value.reason as string)) return null;
    const id = readLiveWorkerId(value.shard, value.worker, value.slot);
    const outcome = readLiveTestOutcome(value.outcome);
    return {
      type: 'end',
      ...id,
      reason: value.reason as LiveViewEnd,
      ...(outcome ? { outcome } : {}),
    };
  }
  const id = readLiveWorkerId(value.shard, value.worker, value.slot);
  if (!id) return null;
  switch (value.type) {
    case 'frame': {
      if (!message.data || !isJpeg(message.data)) return null;
      const frame = {
        type: 'frame' as const,
        ...id,
        image: message.data,
        call: value.call ? readLiveCall(value.call) : null,
        test: readLiveTestTitle(value.test),
      };
      return isEpochMs(value.at) ? { ...frame, at: value.at } : frame;
    }
    case 'call-log': {
      const log = readLiveCallLog(value.log);
      return log ? { type: 'call-log', ...id, log, test: readLiveTestTitle(value.test) } : null;
    }
    case 'refused':
      return typeof value.message === 'string'
        ? { type: 'refused', ...id, message: value.message.slice(0, MAX_REFUSAL) }
        : null;
    case 'test-ended':
      return { type: 'test-ended', ...id, outcome: readLiveTestOutcome(value.outcome) };
    case 'page-event': {
      const event = readPageEvent(value.event);
      return event && isLayerTime(value.at)
        ? { type: 'page-event', ...id, event, at: value.at, test: readLiveTestTitle(value.test) }
        : null;
    }
    case 'text': {
      const test = readLiveTestTitle(value.test);
      if (typeof value.refused === 'string' && value.refused.trim()) {
        return { type: 'text', ...id, refused: value.refused.slice(0, MAX_REFUSAL), test };
      }
      if (!isObject(value.text) || !message.data) return null;
      const text = readLaneText({ ...value.text, text: new TextDecoder().decode(message.data) });
      return text ? { type: 'text', ...id, text, test } : null;
    }
    case 'thumb': {
      const thumb = readLaneThumb(value.thumb);
      if (!thumb || !message.data || !isLaneThumbBytes(message.data)) return null;
      return { type: 'thumb', ...id, thumb, image: message.data, test: readLiveTestTitle(value.test) };
    }
    case 'snapshot': {
      const test = readLiveTestTitle(value.test);
      if (typeof value.refused === 'string' && value.refused.trim()) {
        return { type: 'snapshot', ...id, refused: value.refused.slice(0, MAX_REFUSAL), test };
      }
      const notice = readSnapshotNotice(value);
      return notice ? { type: 'snapshot', ...id, ...notice, test } : null;
    }
    default:
      return null;
  }
}

/**
 * **Ask to watch**: a signed-in teammate reading a run that is not shared live asks its developer to share it, once per
 * `ASK_TO_WATCH_MS` at most. The instance hands the ask to the run's reporter in an answer of the run's stream (`ask` of
 * the events, heartbeat and live resources answers), once; the reporter hands it to the hub its run reports to
 * (`run-ask`), whose tool asks the developer where the run was launched, or prints it in its terminal. The developer
 * shares the run, which the instance sees as its workers stream, or answers `not-now` (`LiveAskAnswer`), which goes back
 * the same way (`ask-answer`, then `askAnswer` of the next heartbeat).
 */
export interface LiveAsk {
  /** The ask on the instance: 1 to 64 characters of letters, digits, `_` and `-`. */
  id: string;
  /** Who asks, as the instance names its user: 1 to 100 characters. */
  by: string;
}

/** The developer's answer to an ask that is not to share the run: `not-now`. */
export interface LiveAskAnswer {
  id: string;
  answer: 'not-now';
}

/**
 * The field of the bodies of a run's stream requests (events, heartbeat) by which its reporter says it takes asks
 * (`true`): the instance takes an ask to watch a run only once its reporter said so, since an older one would never
 * put it to the developer.
 */
export const TAKES_ASKS_FIELD = 'takesAsks';

/** The least time between two asks of one person on one run, in milliseconds. */
export const ASK_TO_WATCH_MS = 5 * 60_000;

/** The longest name an ask carries. */
export const MAX_ASK_BY = 100;

/**
 * The query parameter of a worker's stream that names the run it continues on the instance: the run of the same editor
 * window shared before it, while the window's runs are shared (`after`). The instance links the earlier run to this one.
 */
export const LIVE_VIEW_AFTER_PARAM = 'after';

const ASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * An ask as the instance sent it; null when it is not one. Its name is plain text on one line: control and direction
 * characters go, and so do the characters a notification would read as a link or as markup (`[]()<>` and backticks),
 * cut to `MAX_ASK_BY` characters, never inside one.
 */
export function parseLiveAsk(value: unknown): LiveAsk | null {
  if (!isObject(value) || typeof value.id !== 'string' || !ASK_ID.test(value.id) || typeof value.by !== 'string') {
    return null;
  }
  const plain = value.by
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/[[\]()<>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const by = Array.from(plain).slice(0, MAX_ASK_BY).join('').trim();
  return by ? { id: value.id, by } : null;
}

/** An answer to an ask; null when it is not one. */
export function parseLiveAskAnswer(value: unknown): LiveAskAnswer | null {
  if (!isObject(value) || typeof value.id !== 'string' || !ASK_ID.test(value.id)) return null;
  return value.answer === 'not-now' ? { id: value.id, answer: 'not-now' } : null;
}
