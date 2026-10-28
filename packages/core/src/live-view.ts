/**
 * The run page's live view on the team instance. While a run of a project that turned it on executes, each worker
 * keeps one event stream open to the instance, with a key for that run alone that the reporter sets in the workers'
 * environment (`PIWI_LIVE_VIEW`, `<url>#<key>`, `formatLiveViewEnv`). On that stream the instance says how many people
 * watch the worker (`viewers`). While anyone does, the worker posts small JPEG frames of its test's page, each with the
 * call it was taken at and the title of its test, a few a second at most, and the instance relays them to those viewers
 * alone and keeps none.
 * The worker also posts when its test stops and goes on (`stop`), which the run page shows, when the test watched
 * ended (`ended`), and when the run stops being shared (`unshared`). Nothing goes from the instance to the page: the
 * view never steers the run. Each message is JSON, checked field by field (`parseInstanceToWorker`,
 * `readWorkerToInstance`).
 *
 * A CI run's workers open their streams at once. A run outside CI holds its key too, and its workers open no stream
 * until a person shares the run (**Share live**, the run channel's `share`), and close it as the sharing stops. Such a
 * run without a key names why instead (`none:<why>`, `formatLiveViewMissing`), for the surfaces to say.
 */
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
/** The longest frame's data, in characters of base64. */
export const MAX_LIVE_FRAME_BASE64 = 4 * Math.ceil(MAX_LIVE_FRAME / 3);
/** The longest message a worker posts, in bytes of JSON. */
export const MAX_LIVE_MESSAGE = MAX_LIVE_FRAME_BASE64 + 8 * 1024;
/** The longest call title a message carries; a longer one is cut. */
const MAX_TITLE = 500;
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
 * Why a run outside CI holds no live view key: it reports to no Piwi instance (`no-instance`), the reporter's global
 * setup did not register it as it started (`unregistered`: the reporter entry without `wrapConfig`, a run that reports
 * at its end alone, or an instance the setup could not reach), the instance gave none (`off`: its project has the
 * live view off, or the instance predates it), or it reports to the desktop app on this machine, which gives none
 * since no teammate reaches it (`local`: its setup answers `liveView.refused: 'local'`).
 */
export type LiveViewMissing = 'no-instance' | 'unregistered' | 'off' | 'local';

const MISSING: readonly string[] = ['no-instance', 'unregistered', 'off', 'local'];

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
  unregistered:
    "This run cannot be shared live: the reporter's global setup did not register it with the instance as it started (wrapConfig adds it).",
  off: "This run cannot be shared live: its project's live view is off on the instance. A Project admin turns it on in Project → Settings → Live view.",
  local:
    "This run cannot be shared live: it reports to the Piwi desktop app on this machine, which no teammate reaches. Name your team's instance in PIWI_DASHBOARD_URL to share a run there.",
};

/** What a surface says of a run whose workers name no live view at all: a reporter that set nothing for them. */
export const LIVE_SHARE_UNKNOWN =
  'This run cannot be shared live: the Piwi reporter gave its workers no live view key.';

/**
 * Why a worker's shared stream was given up, by the instance's answer: the setting turned off (404), the key no longer
 * taken (401, 403: the instance started again, or gave the key up), the run no longer live (410), the run held as
 * interrupted after the retries (409); and the instance that did not answer after them.
 */
export function liveShareRefusal(status: number | null): string {
  switch (status) {
    case 404:
      return "Sharing stopped: the project's live view was turned off on the instance.";
    case 401:
    case 403:
      return "Sharing stopped: the instance no longer takes this run's live view key (it started again, or gave the key up).";
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

/** A worker of a run: its shard (null in a run that is not sharded) and Playwright's worker index. */
export interface LiveWorkerId {
  shard: number | null;
  worker: number;
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

/** What the instance says on a worker's stream: how many people watch the worker now. */
export type InstanceToWorker = { type: 'viewers'; count: number };

/** What a worker posts to the instance. */
export type WorkerToInstance =
  /** A frame of the test's page, a JPEG in base64, the call it was taken at and the test's title. */
  | (LiveWorkerId & { type: 'frame'; data: string; call: LiveCall | null; test: string | null })
  /** Why no frame goes: the sentence the viewers see in place of the view. */
  | (LiveWorkerId & { type: 'frame'; refused: string })
  /** The worker's test stopped (its call), or went on (null). */
  | (LiveWorkerId & { type: 'stop'; stop: LiveStop | null })
  /** The test the viewers watched ended, or none runs: their view closes. */
  | (LiveWorkerId & { type: 'ended' })
  /** The person who shared the run stopped sharing it: the viewers' views close, and the worker's stream after them. */
  | (LiveWorkerId & { type: 'unshared' });

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

/** A worker's shard and index, from a message or a query: null when either is not one. */
export function readLiveWorkerId(shard: unknown, worker: unknown): LiveWorkerId | null {
  const shardValue = shard === null || shard === undefined || shard === '' ? null : wholeNumber(shard);
  const workerValue = wholeNumber(worker);
  if (shardValue !== null && !isInt(shardValue, 1, 10_000)) return null;
  if (!isInt(workerValue, 0, 100_000)) return null;
  return { shard: shardValue, worker: workerValue };
}

/** The key the instance files a worker under: `<shard>:<worker>`, the shard empty in a run that is not sharded. */
export function liveWorkerKey(id: LiveWorkerId): string {
  return `${id.shard ?? ''}:${id.worker}`;
}

const STOP_REASONS: readonly string[] = ['breakpoint', 'step', 'pause', 'run-to', 'page-pause', 'failure', 'other'];

/** A call, checked field by field, its title cut short; null when it is not one. */
export function readLiveCall(value: unknown): LiveCall | null {
  if (!isObject(value) || typeof value.title !== 'string' || !value.title.trim()) return null;
  const { file, line } = value;
  const named = typeof file === 'string' && file.length > 0 && file.length <= 1024 && !/[\0\r\n]/.test(file);
  return {
    title: value.title.slice(0, MAX_TITLE),
    file: named ? file : null,
    line: named && isInt(line, 1, 10_000_000) ? line : null,
  };
}

/** Base64, as a frame's data is written. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether `data` is a live frame's data: base64, not empty, at most `MAX_LIVE_FRAME_BASE64` characters. */
export function isLiveFrameData(data: unknown): data is string {
  return typeof data === 'string' && data.length > 0 && data.length <= MAX_LIVE_FRAME_BASE64 && BASE64.test(data);
}

/** A message a worker posted, checked field by field; why not, as a sentence, when it is not one this version reads. */
export function readWorkerToInstance(value: unknown): WorkerToInstance | string {
  if (!isObject(value)) return 'The message is not an object.';
  const id = readLiveWorkerId(value.shard, value.worker);
  if (!id) return 'The message names no worker: a worker index, and a shard from 1 when the run is sharded.';
  switch (value.type) {
    case 'frame': {
      if (typeof value.refused === 'string' && value.refused.trim()) {
        return { type: 'frame', ...id, refused: value.refused.slice(0, MAX_REFUSAL) };
      }
      if (!isLiveFrameData(value.data)) return `A frame is a JPEG in base64, ${MAX_LIVE_FRAME / 1024} KB at most.`;
      const call = value.call === null || value.call === undefined ? null : readLiveCall(value.call);
      return { type: 'frame', ...id, data: value.data, call, test: readLiveTestTitle(value.test) };
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
    case 'ended':
      return { type: 'ended', ...id };
    case 'unshared':
      return { type: 'unshared', ...id };
    default:
      return 'The message is of a type other than frame, stop, ended or unshared.';
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
  if (!isObject(value) || value.type !== 'viewers' || !isInt(value.count, 0, 1_000_000)) return null;
  return { type: 'viewers', count: value.count };
}
