import * as http from 'node:http';
import * as https from 'node:https';
import type { Page, WorkerInfo } from '@playwright/test';
import {
  LIVE_CALL_LOGS_PER_SECOND,
  LIVE_FRAME_BYTE_RATE,
  LIVE_FRAME_FPS,
  LIVE_FRAME_HEIGHT,
  LIVE_FRAME_QUALITY,
  LIVE_FRAME_TYPE,
  LIVE_FRAME_WIDTH,
  LIVE_SHARE_MISSING,
  LIVE_SHARE_UNKNOWN,
  LIVE_VIEW_AFTER_PARAM,
  LIVE_VIEW_ENV,
  MAX_LIVE_FRAME,
  encodeLiveMessage,
  liveFrameHeader,
  liveRunPage,
  liveShareRefusal,
  parseInstanceToWorker,
  parseLiveViewEnv,
  parseLiveViewMissing,
  type LiveCall,
  type LiveCallLog,
  type LiveStop,
  type LiveViewAddress,
  type LiveWorkerId,
  type WorkerToInstance,
  type LiveTestOutcome,
  type InstanceToWorker,
  liveThumbHeader,
} from '@piwitests/core/live-view';
import {
  LANE_TEXTS_PER_SECOND,
  LANE_THUMBS_PER_SECOND,
  type LaneLayer,
  type LaneText,
} from '@piwitests/core/live-layers';
import { LatestPacer } from '@piwitests/core/run-view';
import { hideSecretsInText, hideTypedText } from '@piwitests/core/mask';
import type { RunLiveState } from '@piwitests/core/run-channel';
import { PIWI_RUN_LOG_ENV, PIWI_SHARE_LIVE_ENV } from '../config/env.js';
import { detectCi } from '../support/ci.js';
import { printRunLine } from '../support/run-log.js';
import { resolveShardInfo } from '../support/shard-info.js';
import { followCallLog } from './live-call-log.js';
import { subscribeLane, type LaneSubscription } from './lane-feed.js';
import {
  LaneFilmstrip,
  followTraceText,
  layersTitleOf,
  subscribePageEvents,
  takeLaneText,
  type KeptThumb,
  type WatchedLane,
} from './lane-layers.js';
import type { PageFrame } from './page-view.js';

/**
 * The worker's connection to the team instance for the run page's live view (`@piwitests/core/live-view`), when the
 * run's environment names it (`PIWI_LIVE_VIEW`, which the reporter sets in `onBegin` for a run of a project that
 * turned the live view on). In a CI run, opened once per worker before its first test, as an event stream on which the
 * instance says how many people watch this worker; closed as the worker ends. Outside CI, the worker holds the key and
 * opens nothing until a person shares the run (**Share live**, `shareLiveView` from the run channel's `share`), and
 * closes the stream as they stop sharing it, the viewers hearing why (`unshared`); `liveViewState` says how it stands,
 * and why a run without a key cannot be shared (`none:<why>` in place of the address), for the run channel to tell.
 * Nothing goes to the instance while the run is not shared. While someone watches, the running test's page goes out as
 * its screencast (`page-view.ts`, through internal calls: nothing shows among the test's steps), at the size and pace
 * the instance says its viewers ask (`view`: the largest image one of them shows, within 1280 by 800 device pixels,
 * and `LIVE_FRAME_FPS` frames a second for a full view, one for tiles alone), else at most `LIVE_FRAME_WIDTH` by
 * `LIVE_FRAME_HEIGHT` and `LIVE_FRAME_FPS` frames a second, at `LIVE_FRAME_QUALITY` and `LIVE_FRAME_BYTE_RATE` bytes a
 * second at most; a page whose video records keeps the video's size, its screencast's first client. Each frame is
 * posted with the call it was taken at, one post in flight, the latest frame alone waiting: as its JPEG's bytes behind
 * a JSON header (`LIVE_FRAME_TYPE`) to an instance that says `view`, in base64 inside JSON to an older one. Before a frame goes, the page's secret fields and the elements its project masks (`masks`, which the
 * instance sends on the stream) are painted over in it, or it does not go (`live-mask.ts`), and a headed stop's pause
 * bar in the same pass (`page-view.ts`). Nobody watching, no screencast runs and no frame goes. The view stops as nobody watches any more, as
 * the test ends (the viewers hear it, `ended`) and as its page closes; someone who watches while no test runs hears
 * why no image shows. Each frame names its test, so a view opened from one test's row ends at the next test's first
 * frame. The worker also posts when its test stops and goes on (`stop`), and the stop it holds again on each stream
 * it opens, since the instance forgets a stream's stop as it closes. In a CI run, while someone watches it in full
 * (`view`'s `full`; an instance that does not say it counts as one whose viewers do), it also follows and posts the
 * call its test is in as Playwright logs it (`call-log`, `live-call-log.ts`), a few a second at most, the latest again
 * for a viewer that comes later or that the instance asks for (`resend`), and only then posts the test's end
 * (`ended`): a worker only tiles show turns no call stream on. Every call named goes through
 * `hideSecretsInText`. A test never waits on any of it: a connection that fails is tried again a few times, then, in a
 * CI run, every 30 to 60 seconds while the worker lasts, the run's log saying once that the view is lost and once that
 * it is back (`printRunLine`); outside CI, it is given up until a person shares the run again. A key the instance does
 * not take now (401), or a project with the live view off (404), skips the quick retries: an instance started again,
 * or the setting turned on again, takes the key back. A key refused (403), or a run no longer live (410), gives it up
 * at once, for the worker's life. The key is out of the worker's environment from the connection's opening to its
 * close (`hideKey`).
 *
 * In a run something may pause (`mayPause`), or outside CI, the call log comes from Playwright's in-process
 * instrumentation (`live-call-log.ts`'s `listener`), which moves no stop, in place of the call stream. Beside the
 * images, a full view may ask for layers (`view`'s `layers`, `lane-layers.ts`), each posted while asked alone: the page's
 * events (`page-event`, `MAX_PAGE_EVENTS_PER_SECOND` at most), its text (`text`: as the trace writes it, and taken as the
 * instance asks, `text` on the stream, `LANE_TEXTS_PER_SECOND` at most, masked with the project's masks too), and the
 * test's filmstrip (`thumb`, a live message whose data is the JPEG): while anyone watches, the view's own masked image
 * shortly after each call of the test ended, scaled down, kept in memory for the test alone (`LaneFilmstrip`), all of
 * them posted again to a viewer that asks later (`resend`, or the layer asked anew), `LANE_THUMBS_PER_SECOND` at most.
 * None is stored.
 */

/** How long the worker waits before it opens its stream again, after each failure in a row. */
const RETRY_MS = [1000, 2000, 4000, 8000, 16000];
/** Past those, in a CI run: the least wait before the stream opens again, and the most added to it at random. */
const SLOW_RETRY_MS = 30_000;
const SLOW_RETRY_JITTER_MS = 30_000;
/** A stream open this long counts as working: the next failure starts the retries again. */
const STEADY_MS = 30_000;
/** How long the stream may stay silent: the instance writes a comment every 15 seconds. */
const STREAM_IDLE_MS = 45_000;
/** How long a post may take. */
const POST_TIMEOUT_MS = 10_000;
/** The most bytes one event of the stream may hold while it is read. */
const MAX_EVENT_TEXT = 64 * 1024;
/** The most posts of a stop's start and end that wait their turn; one more is dropped. */
const MAX_STATES_WAITING = 8;
/** The JPEG quality of the image sent in place of a frame longer than `MAX_LIVE_FRAME`, and how often at most. */
const LIGHT_QUALITY = 30;
const SHOT_MS = 1000;
/** The least time between two call logs a worker posts: `LIVE_CALL_LOGS_PER_SECOND` at most. */
const LOG_SPACING_MS = Math.ceil(1000 / LIVE_CALL_LOGS_PER_SECOND);
/** How long ending the view may take before the test goes on without waiting for it. */
const VIEW_END_MS = 1000;
/** The most page events posted at once. */
const MAX_EVENT_POSTS = 8;
/** The statuses that give the connection up for the worker's life: the key refused, or the run no longer live. */
const GIVE_UP = new Set([403, 410]);
/**
 * The statuses an instance started again, or the project's live view turned on again, lifts: the key unknown, the
 * live view off.
 */
const NOT_NOW = new Set([401, 404]);

const TOO_HEAVY =
  `This page is too heavy for the live view: each image of it is over ${MAX_LIVE_FRAME / 1024} KB, ` +
  'a lighter one included.';
const NO_PAGE = 'This test has no page to show yet.';
const NO_TEST = 'No test runs on this worker now: the next one shows once it opens its page.';

interface Link {
  address: LiveViewAddress;
  id: LiveWorkerId;
  client: typeof http | typeof https;
  agent: http.Agent;
  stream: http.ClientRequest | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** The failures in a row since a stream last stayed open `STEADY_MS`. */
  retries: number;
  /** The worker ended: nothing opens any more. */
  ended: boolean;
  /** Why the instance will not take the key again, as a person reads it: nothing opens any more. */
  refused: string | null;
  /** Whether the stream is wanted: from the start in a CI run, while a person shares the run outside one. */
  sharing: boolean;
  /** The run on the instance this one continues (`LIVE_VIEW_AFTER_PARAM`), named on each stream it opens. */
  after: number | null;
  /** Why the sharing stopped though nobody asked: the instance did not answer after the retries, or took no key. */
  lost: string | null;
  /** A CI run's: the file the global setup reads the worker's lines from for the run's log (`PIWI_RUN_LOG`). */
  runLog: string | null;
  /** The run's log says the view is lost: the next stream that stays open `STEADY_MS` says it is back. */
  dark: boolean;
  /** Says the view is back once the stream that opened while it was lost has stayed open `STEADY_MS`. */
  backTimer: ReturnType<typeof setTimeout> | null;
  /** The instance's latest answer that opened no stream, since one last opened: what the retries end on. */
  answered: number | null;
  viewers: number;
  /** The posts of a stop's start and end, one after the other, and how many wait. */
  states: Promise<unknown>;
  statesWaiting: number;
  /** The stop the worker's test holds now, posted again each time the stream opens. */
  stop: LiveStop | null;
  /** Whether a frame's post is in flight. */
  posting: boolean;
  /** The frame's post in flight, which the test's end waits for, so the end goes after its last frame. */
  framePost: Promise<unknown> | null;
  /** A CI run's: the call log is followed while someone watches (`live-call-log.ts`). */
  ci: boolean;
  /** The call log shown now, whether one is posting, when the last one went, and the pause before the next goes. */
  log: LiveCallLog | null;
  logPosting: boolean;
  logSentAt: number;
  logTimer: ReturnType<typeof setTimeout> | null;
  /** The instance does not take call logs (it answered 400): none goes any more. */
  logRefused: boolean;
  /**
   * The project's own locators masked in each image, beside the secret fields, as the instance last said; null when it
   * named some this reporter cannot read, and no image goes.
   */
  masks: string[] | null;
  /**
   * What the viewers ask of the images, as the stream open now last said (`view`): null from an instance that never
   * says it, which takes frames in base64 inside JSON alone, and shows the worker in full alone.
   */
  asked: Extract<InstanceToWorker, { type: 'view' }> | null;
}

/** What runs for the layers the full views ask: the page's events, the trace's text, the filmstrip's posts. */
const layerRuns: {
  events: (() => void) | null;
  text: (() => void) | null;
  texts: LatestPacer<LaneText | { refused: string }> | null;
  thumbs: ReturnType<typeof setInterval> | null;
} = { events: null, text: null, texts: null, thumbs: null };
/** The test's filmstrip, taken from the view's own masked images while someone watches. */
let filmstrip: LaneFilmstrip | null = null;
/** The filmstrip's images waiting to be posted, in order, each with its test, and whether one is in flight. */
const thumbPosts: { queue: Array<KeptThumb & { test: string }>; posting: boolean } = { queue: [], posting: false };
/** The page events posted now. */
let eventPosts = 0;

/** Whether the full views ask for `layer` now, while the view runs. */
function layerAsked(own: Link, layer: LaneLayer): boolean {
  return (
    !!view && own === link && active(own) && own.viewers > 0 && shownInFull(own) && !!own.asked?.layers.includes(layer)
  );
}

/** Whether a viewer shows the worker in full: only then do its call log and its test's end go. */
function shownInFull(own: Link): boolean {
  return own.asked?.full ?? true;
}

let link: Link | null = null;
/** Why the worker's run cannot be shared, while it holds no key; null with one, and before the worker opened. */
let missing: string | null = null;
/** Who hears each change of `liveViewState`: the run channel. */
const changes = new Set<() => void>();
/** The shares and their ends a person asks for, one after the other. */
let shareTurn: Promise<unknown> = Promise.resolve();

/** The test the worker runs: its title, its page once known, and the call it is on. */
interface RunningTest {
  title: string;
  page: Page | null;
  call: () => LiveCall | null;
  /** Something may pause it: its call log is not followed, which would move where the debugger stops. */
  mayPause: boolean;
  began: number;
}

let running: RunningTest | null = null;
/** The view of the running test's page, while someone watches: its hold on the lane's frames. */
let view: {
  page: Page;
  frames: LaneSubscription;
  onClose: () => void;
  /** What stops following the page's call log, in a CI run. */
  following: Promise<(() => void) | null> | null;
} | null = null;

/** `PIWI_LIVE_VIEW` while the worker runs without it, and the listener that puts it back for Playwright's look. */
let hidden: { env: NodeJS.ProcessEnv; value: string; onStop: (message: unknown) => void } | null = null;

/**
 * Take the key out of the worker's environment until `showKey`, so no process the worker's hooks, fixtures or tests
 * start gets it. Playwright compares a worker's environment as it stops (its `__stop__` message) with the one it
 * started with, and hands what changed to the projects that depend on its own: the key is back for that look alone.
 */
function hideKey(env: NodeJS.ProcessEnv): void {
  const value = env[LIVE_VIEW_ENV];
  if (value === undefined || hidden) return;
  delete env[LIVE_VIEW_ENV];
  const onStop = (message: unknown): void => {
    if ((message as { method?: unknown } | null)?.method !== '__stop__') return;
    env[LIVE_VIEW_ENV] = value;
    process.nextTick(() => {
      if (hidden?.onStop === onStop) delete env[LIVE_VIEW_ENV];
    });
  };
  process.prependListener('message', onStop);
  hidden = { env, value, onStop };
}

/** Put the key back in the worker's environment, as its connection closes. */
function showKey(): void {
  const own = hidden;
  hidden = null;
  if (!own) return;
  process.off('message', own.onStop);
  own.env[LIVE_VIEW_ENV] = own.value;
}

/** Whether the worker holds the run's live view key, shared or not. */
export function liveViewOpen(): boolean {
  return link !== null;
}

/** Whether the worker holds a key of a run outside CI: one a person may pause, whose call log the listener follows. */
export function liveViewMayPause(): boolean {
  return link !== null && !link.ci;
}

/** Whether the worker's stream is wanted now and may open: it holds a key the instance takes, and the run is shared. */
function active(own: Link): boolean {
  return !own.ended && own.refused === null && own.sharing;
}

/** The run channel hears that `liveViewState` changed. */
function changed(): void {
  for (const listener of changes) listener();
}

/** Hear each change of `liveViewState`; returns what stops hearing them. */
export function onLiveViewChange(listener: () => void): () => void {
  changes.add(listener);
  return () => changes.delete(listener);
}

/**
 * How the worker's run stands on the instance's live view, for the surfaces that share it: whether it can be shared
 * and is, how many people watch this worker, the run's page, and why it cannot be or why its sharing stopped.
 */
export function liveViewState(): RunLiveState {
  const own = link;
  if (!own) return { can: false, on: false, viewers: 0, page: null, why: missing ?? LIVE_SHARE_UNKNOWN };
  const page = liveRunPage(own.address);
  if (own.refused) return { can: false, on: false, viewers: 0, page, why: own.refused };
  const on = active(own);
  return { can: true, on, viewers: on ? own.viewers : 0, page, why: own.lost };
}

/**
 * Open the worker's connection to the instance when the run's environment names one, and take the key out of that
 * environment until the connection closes. In a CI run (`ci`) the stream opens at once, in the background; outside
 * one, only once the run is shared (`shareLiveView`). Returns at once, whether it named one. Never throws.
 */
export function openLiveView(
  worker: Pick<WorkerInfo, 'workerIndex' | 'config'> & { parallelIndex?: number },
  env: NodeJS.ProcessEnv = process.env,
  ci = detectCi(env),
): boolean {
  if (link) return false;
  const value = env[LIVE_VIEW_ENV];
  const address = parseLiveViewEnv(value);
  hideKey(env);
  if (!address) {
    const why = parseLiveViewMissing(value);
    missing = why ? LIVE_SHARE_MISSING[why] : LIVE_SHARE_UNKNOWN;
    changed();
    return false;
  }
  missing = null;
  const secure = address.url.startsWith('https:');
  const client = secure ? https : http;
  link = {
    address,
    id: {
      shard: resolveShardInfo(worker.config, env)?.current ?? null,
      worker: worker.workerIndex,
      // The lane, which a worker Playwright starts again after a failure keeps, so a view follows it.
      ...(typeof worker.parallelIndex === 'number' ? { slot: worker.parallelIndex } : {}),
    },
    client,
    // The stream, and a frame, a call log and a stop or an end in flight at once: none waits behind another.
    agent: new client.Agent({ keepAlive: true, maxSockets: 4 }),
    stream: null,
    timer: null,
    retries: 0,
    ended: false,
    refused: null,
    // A run outside CI shares from its start when it was asked to (`PIWI_SHARE_LIVE`), as a CI run does.
    sharing: ci || env[PIWI_SHARE_LIVE_ENV] === 'true',
    after: null,
    ci,
    lost: null,
    runLog: ci ? env[PIWI_RUN_LOG_ENV] || null : null,
    dark: false,
    backTimer: null,
    answered: null,
    viewers: 0,
    states: Promise.resolve(),
    statesWaiting: 0,
    stop: null,
    posting: false,
    framePost: null,
    log: null,
    logPosting: false,
    logSentAt: 0,
    logTimer: null,
    logRefused: false,
    masks: [],
    asked: null,
  };
  if (link.sharing) connect(link);
  filmstrip?.close();
  filmstrip = new LaneFilmstrip(watchedLane, (kept, test) => {
    if (link && layerAsked(link, 'filmstrip')) thumbPosts.queue.push({ ...kept, test });
  });
  changed();
  return true;
}

/** Close the worker's connection, as the worker ends. */
export function closeLiveView(): void {
  const own = link;
  link = null;
  running = null;
  missing = null;
  filmstrip?.close();
  filmstrip = null;
  thumbPosts.queue = [];
  showKey();
  void stopView();
  if (!own) return;
  own.ended = true;
  if (own.timer) clearTimeout(own.timer);
  stopBackTimer(own);
  own.stream?.destroy();
  own.agent.destroy();
}

/**
 * A person shares the run from now on (`on`): the stream opens, its retries counted afresh, after a sharing that
 * stopped on its own too; or stops sharing it: the view stops, the viewers hear why their view ends (`unshared`), and
 * the stream closes, so nothing more goes to the instance. Each one waits for the one before. Nothing happens for a
 * worker without a key, or whose key the instance refused for good.
 */
export function shareLiveView(on: boolean, after: number | null = null): Promise<void> {
  const turn = shareTurn.then(() => (on ? startSharing(after) : stopSharing()));
  shareTurn = turn.catch(() => undefined);
  return turn;
}

function startSharing(after: number | null): void {
  const own = link;
  if (!own || own.ended || own.refused || own.sharing) return;
  own.sharing = true;
  own.after = after;
  own.lost = null;
  own.answered = null;
  own.retries = 0;
  connect(own);
  changed();
}

async function stopSharing(): Promise<void> {
  const own = link;
  if (!own || own.ended || !own.sharing) return;
  const streamed = own.stream !== null && own.refused === null;
  own.sharing = false;
  own.lost = null;
  if (own.timer) clearTimeout(own.timer);
  own.timer = null;
  await stopView();
  // The viewers hear why their view ends before the stream closes, which the run page hears as the worker leaving.
  if (streamed) await send(own, { type: 'unshared', ...own.id });
  own.stream?.destroy();
  own.stream = null;
  own.viewers = 0;
  changed();
}

/** A test titled `title` begins: `call` names the call it is on, for each frame; `mayPause` when it may pause. */
export function liveViewTestBegan(title: string, call: () => LiveCall | null, mayPause = false): void {
  if (!link) return;
  running = { title, page: null, call, mayPause, began: Date.now() };
  filmstrip?.forget();
  thumbPosts.queue = [];
}

/** The running test's page: watched from now on, at once when someone already watches. */
export function liveViewPage(page: Page): void {
  if (!link || !running || running.page) return;
  running.page = page;
  if (link.viewers > 0 && active(link)) startView();
}

/** The test ended (`status`, Playwright's): its view stops, and the people watching hear how it ended. */
export async function liveViewTestEnded(status?: LiveTestOutcome['status']): Promise<void> {
  if (!running) return;
  const ended = running;
  running = null;
  const outcome = status ? { test: ended.title, status, ms: Math.max(0, Date.now() - ended.began) } : null;
  await stopView();
  const own = link;
  if (!own) return;
  await own.framePost;
  if (own.viewers > 0 && active(own) && shownInFull(own)) void post(own, { type: 'ended', ...own.id, outcome });
}

/**
 * The running test stopped at `stop`: the run page shows it paused until the function returned is called, while the
 * run is shared; a run shared during the stop shows it from then on.
 */
export function liveViewStopped(stop: LiveStop): () => void {
  const own = link;
  if (!own || own.ended) return () => undefined;
  const shown = { ...stop, call: hideCallSecrets(stop.call) };
  own.stop = shown;
  postState(own, { type: 'stop', ...own.id, stop: shown });
  return () => {
    if (own.stop === shown) own.stop = null;
    postState(own, { type: 'stop', ...own.id, stop: null });
  };
}

/**
 * A call as the run page shows it: its title without the text a fill, a typing or an insert types (`hideTypedText`),
 * and through `hideSecretsInText`, which a URL or a token may hold.
 */
function hideCallSecrets(call: LiveCall): LiveCall {
  return { ...call, title: hideSecretsInText(hideTypedText(call.title)) };
}

/** Post a stop's start or end after the ones before it, a few waiting at most, while the run is shared. */
function postState(own: Link, message: WorkerToInstance): void {
  if (!active(own) || own.statesWaiting >= MAX_STATES_WAITING) return;
  own.statesWaiting++;
  own.states = own.states
    .then(() => post(own, message))
    .finally(() => {
      own.statesWaiting--;
    });
}

/** Open the stream, and open it again after a failure (`retry`). */
function connect(own: Link): void {
  if (!active(own)) return;
  const url = new URL(own.address.url);
  url.searchParams.set('worker', String(own.id.worker));
  if (own.id.shard !== null) url.searchParams.set('shard', String(own.id.shard));
  if (own.id.slot !== undefined) url.searchParams.set('slot', String(own.id.slot));
  if (own.after !== null) url.searchParams.set(LIVE_VIEW_AFTER_PARAM, String(own.after));
  let openedAt: number | null = null;
  let dropped = false;
  /**
   * The stream closed: `status` is the instance's refusal, null for a connection that failed or closed. A stream
   * already replaced or closed for good is done with: nothing is tried again for it.
   */
  const drop = (status: number | null): void => {
    if (dropped) return;
    dropped = true;
    if (own.stream !== request) return;
    own.stream = null;
    stopBackTimer(own);
    setViewers(own, 0);
    if (!active(own)) return;
    if (openedAt !== null && Date.now() - openedAt >= STEADY_MS) own.retries = 0;
    if (status !== null) own.answered = status;
    if (status !== null && GIVE_UP.has(status)) return void refuse(own, status);
    retry(own, status !== null && NOT_NOW.has(status));
  };
  const request = own.client.request(url, {
    method: 'GET',
    agent: own.agent,
    headers: {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${own.address.key}`,
      'Cache-Control': 'no-cache',
    },
  });
  own.stream = request;
  // The stream never keeps the worker alive.
  request.on('socket', (socket) => socket.unref());
  request.setTimeout(STREAM_IDLE_MS, () => request.destroy());
  request.on('error', () => drop(null));
  request.on('close', () => drop(null));
  request.on('response', (response) => {
    if (response.statusCode !== 200) {
      response.resume();
      return drop(response.statusCode ?? null);
    }
    openedAt = Date.now();
    own.answered = null;
    // The form this stream's instance takes frames in, and what its viewers ask, it says on this stream.
    own.asked = null;
    if (own.dark) {
      own.backTimer = setTimeout(() => {
        own.backTimer = null;
        if (own.stream !== request || !own.dark) return;
        own.dark = false;
        printRunLine(own.runLog, `${workerName(own.id)}: live view back.`);
      }, STEADY_MS);
      own.backTimer.unref?.();
    }
    // The instance forgets a stream's stop as it closes: a stream opened again hears it again.
    if (own.stop) postState(own, { type: 'stop', ...own.id, stop: own.stop });
    response.setEncoding('utf8');
    let text = '';
    response.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > MAX_EVENT_TEXT && !text.includes('\n\n')) return void request.destroy();
      let end: number;
      while ((end = text.indexOf('\n\n')) >= 0) {
        const block = text.slice(0, end);
        text = text.slice(end + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        const message = data ? parseInstanceToWorker(data) : null;
        if (message?.type === 'masks') setMasks(own, message.locators);
        else if (message?.type === 'view') setAsked(own, message);
        else if (message?.type === 'resend') resendView(own);
        else if (message?.type === 'text') sendText(own, true);
        else if (message) setViewers(own, message.count);
      }
    });
    response.on('error', () => drop(null));
    response.on('close', () => drop(null));
  });
  request.end();
}

/**
 * Open the stream again after a failure: soon, a few times, waiting longer each time; past them, in a CI run, every
 * 30 to 60 seconds while the worker lasts, the run's log saying once that the view is lost; outside CI, the sharing
 * stops. A key the instance does not take now (`notNow`: a 401 or 404) skips the quick retries.
 */
function retry(own: Link, notNow: boolean): void {
  if (!notNow && own.retries < RETRY_MS.length) return void later(own, RETRY_MS[own.retries++]!);
  if (!own.ci) return void giveUp(own);
  goDark(own, 'Trying again every 30 to 60 s while the run lasts.');
  later(own, SLOW_RETRY_MS + Math.random() * SLOW_RETRY_JITTER_MS);
}

/** The run's log says once that the worker's view is lost, why, and what follows (`next`), until it is back. */
function goDark(own: Link, next: string): void {
  if (own.dark) return;
  own.dark = true;
  printRunLine(own.runLog, `${workerName(own.id)}: live view lost: ${lostCause(own.answered)}. ${next}`);
}

function stopBackTimer(own: Link): void {
  if (own.backTimer) clearTimeout(own.backTimer);
  own.backTimer = null;
}

/** Open the stream `wait` milliseconds from now. */
function later(own: Link, wait: number): void {
  own.timer = setTimeout(() => {
    own.timer = null;
    connect(own);
  }, wait);
  own.timer.unref?.();
}

/** The worker as the run page names it: by its lane, from 1, and its shard. */
function workerName(id: LiveWorkerId): string {
  const worker = `Worker ${id.slot === undefined ? id.worker : id.slot + 1}`;
  return id.shard === null ? worker : `${worker} of shard ${id.shard}`;
}

/** What the instance last answered (`status`; null for nothing), as the run's log says why the view is lost. */
function lostCause(status: number | null): string {
  switch (status) {
    case null:
      return 'the instance did not answer';
    case 401:
      return "the instance does not take the run's live view key now";
    case 404:
      return "the project's live view is off";
    case 403:
      return "the instance refuses the run's live view key";
    case 409:
      return 'the instance holds the run as interrupted';
    case 410:
      return 'the run is no longer live on the instance';
    default:
      return `the instance answered ${status}`;
  }
}

/** The instance refused the key for good (`status`): nothing more is tried for the worker's life; the run says why. */
function refuse(own: Link, status: number): void {
  if (own.refused !== null) return;
  own.refused = liveShareRefusal(status);
  own.answered = status;
  if (own.ci) goDark(own, 'It stays off for this worker.');
  own.viewers = 0;
  own.stream?.destroy();
  own.agent.destroy();
  void stopView();
  changed();
}

/**
 * The retries are over, or the instance took no key: the sharing stops, saying what the instance last answered
 * (nothing, that the run is interrupted, the key unknown or the live view off), and its stream closes; a person may
 * share the run again.
 */
function giveUp(own: Link): void {
  own.sharing = false;
  own.lost = liveShareRefusal(own.answered);
  own.viewers = 0;
  if (own.timer) clearTimeout(own.timer);
  own.timer = null;
  own.stream?.destroy();
  own.stream = null;
  void stopView();
  changed();
}

/**
 * How many people watch the worker now: the view starts with the first, sends its latest frame again for a later one,
 * and stops with the last.
 */
function setViewers(own: Link, count: number): void {
  const before = own.viewers;
  own.viewers = count;
  if (own !== link) return;
  if (count !== before) changed();
  if (count === 0) return void stopView();
  if (count > before) resendView(own);
  else if (active(own) && running && !view) startView();
}

/**
 * A viewer came, or the instance asks again: the view starts, or sends its latest frame again and, to a full view, its
 * call log; between two tests, or in a hook outside them, the viewers hear why no image shows.
 */
function resendView(own: Link): void {
  if (own !== link || !active(own) || own.viewers === 0) return;
  if (!running) return void post(own, { type: 'frame', ...own.id, refused: NO_TEST });
  if (!view) return startView();
  view.frames.resend();
  if (own.log && shownInFull(own)) postLog(own, own.log);
  if (layerAsked(own, 'filmstrip')) queueStrip(own);
}

/**
 * The project masks `locators` from now on: the image kept for a later viewer was masked without them, so the view
 * takes one again.
 */
function setMasks(own: Link, locators: string[] | null): void {
  if (JSON.stringify(locators) === JSON.stringify(own.masks)) return;
  own.masks = locators;
  if (own === link) view?.frames.refresh();
}

/**
 * The viewers ask `asked` of the images from now on (null: what an older instance takes): the view takes them at
 * that size and pace.
 */
function setAsked(own: Link, asked: Link['asked']): void {
  if (JSON.stringify(asked) === JSON.stringify(own.asked)) return;
  const before = new Set(own.asked?.layers ?? []);
  own.asked = asked;
  if (own !== link) return;
  view?.frames.asked();
  followCalls(own);
  applyLayers(own, before);
}

/**
 * Run the layers the full views ask while the view runs, and stop the others; a layer asked anew (not in `before`)
 * posts the page's text at once, or the test's filmstrip so far.
 */
function applyLayers(own: Link, before: ReadonlySet<LaneLayer>): void {
  if (layerAsked(own, 'events') && !layerRuns.events) {
    layerRuns.events = subscribePageEvents((event, at) => {
      // An instance that answers slowly is not sent more than a few at once: the others go nowhere.
      if (!layerAsked(own, 'events') || eventPosts >= MAX_EVENT_POSTS) return;
      eventPosts++;
      void post(own, { type: 'page-event', ...own.id, event, at, test: running?.title ?? null }).finally(() => {
        eventPosts--;
      });
    });
  } else if (!layerAsked(own, 'events') && layerRuns.events) {
    layerRuns.events();
    layerRuns.events = null;
  }
  if (layerAsked(own, 'text')) {
    layerRuns.text ??= followTraceText(
      () => own.masks,
      () => view?.page ?? null,
      (text) => offerText(own, text),
    );
    if (!before.has('text')) sendText(own, true);
  } else if (layerRuns.text) {
    layerRuns.text();
    layerRuns.text = null;
  }
  if (layerAsked(own, 'filmstrip')) {
    layerRuns.thumbs ??= startThumbPosts(own);
    if (!before.has('filmstrip')) queueStrip(own);
  } else if (layerRuns.thumbs) {
    clearInterval(layerRuns.thumbs);
    layerRuns.thumbs = null;
    thumbPosts.queue = [];
  }
}

/** Stop every layer: the view stopped. */
function stopLayers(): void {
  layerRuns.events?.();
  layerRuns.text?.();
  layerRuns.texts?.close();
  if (layerRuns.thumbs) clearInterval(layerRuns.thumbs);
  layerRuns.events = null;
  layerRuns.text = null;
  layerRuns.texts = null;
  layerRuns.thumbs = null;
  thumbPosts.queue = [];
}

/**
 * Take the page's text and post it, while a full view asks for it: the trace's latest, else, with `take` (the instance
 * asked, or the layer was asked anew), an ARIA snapshot of the page now.
 */
function sendText(own: Link, take: boolean): void {
  if (!layerAsked(own, 'text')) return;
  const page = view?.page ?? null;
  void takeLaneText(page, own.masks, take).then((text) => {
    if (text) offerText(own, text);
  });
}

/** Post a text of the page, `LANE_TEXTS_PER_SECOND` at most, the latest alone waiting. */
function offerText(own: Link, text: LaneText | { refused: string }): void {
  layerRuns.texts ??= new LatestPacer<LaneText | { refused: string }>({
    intervalMs: 1000 / LANE_TEXTS_PER_SECOND,
    send: (next) => {
      if (link !== own || !view || !active(own)) return;
      const test = running?.title ?? null;
      void post(
        own,
        'refused' in next
          ? { type: 'text', ...own.id, refused: next.refused, test }
          : { type: 'text', ...own.id, text: next, test },
      );
    },
  });
  layerRuns.texts.offer(text);
}

/** The running test's view while someone watches it, for its filmstrip: its title, and the view's latest frame. */
function watchedLane(): WatchedLane | null {
  const own = link;
  const shown = view;
  if (!own || !shown || !running || !active(own) || own.viewers === 0) return null;
  return { test: running.title, latest: () => shown.frames.latest() };
}

/** Post the test's whole filmstrip so far, to a viewer that asked it later. */
function queueStrip(own: Link): void {
  if (!filmstrip || !running || !layerAsked(own, 'filmstrip')) return;
  const test = running.title;
  thumbPosts.queue = filmstrip.of(test).map((kept) => ({ ...kept, test }));
}

/** Post the filmstrip's waiting images, `LANE_THUMBS_PER_SECOND` at most, one in flight. */
function startThumbPosts(own: Link): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    if (thumbPosts.posting || !thumbPosts.queue.length || !own.asked || !layerAsked(own, 'filmstrip')) return;
    const next = thumbPosts.queue.shift()!;
    thumbPosts.posting = true;
    void postBody(own, encodeLiveMessage(liveThumbHeader(own.id, next.thumb, next.test), next.data), LIVE_FRAME_TYPE)
      .catch(() => undefined)
      .finally(() => {
        thumbPosts.posting = false;
      });
  }, 1000 / LANE_THUMBS_PER_SECOND);
  timer.unref?.();
  return timer;
}

/** Start the view of the running test's page; say why there is none while it has no page. */
function startView(): void {
  const own = link;
  const page = running?.page ?? null;
  if (!own || !active(own) || view) return;
  if (!page || page.isClosed()) {
    void post(own, { type: 'frame', ...own.id, refused: NO_PAGE });
    return;
  }
  const live = (): boolean => view?.page === page && link === own && active(own) && own.viewers > 0;
  // The lane's frames, masked with the project's masks and the page's secret fields.
  const frames = subscribeLane({
    get maxWidth() {
      return own.asked?.width ?? LIVE_FRAME_WIDTH;
    },
    get maxHeight() {
      return own.asked?.height ?? LIVE_FRAME_HEIGHT;
    },
    quality: LIVE_FRAME_QUALITY,
    get fps() {
      return own.asked?.fps ?? LIVE_FRAME_FPS;
    },
    spacing: (frame) => (frame.data.length * 1000) / LIVE_FRAME_BYTE_RATE,
    maxFrameBytes: MAX_LIVE_FRAME,
    lightQuality: LIGHT_QUALITY,
    shotMs: SHOT_MS,
    masks: () => own.masks,
    busy: () => own.posting,
    send: (frame) => {
      if (live()) postFrame(own, frame);
    },
    refuse: (why) => {
      if (live()) void post(own, { type: 'frame', ...own.id, refused: why ?? TOO_HEAVY });
    },
  });
  const onClose = (): void => {
    if (view?.page === page) void stopView();
  };
  page.once('close', onClose);
  view = { page, frames, onClose, following: null };
  followCalls(own);
  applyLayers(own, new Set());
}

/**
 * Follow the call log of the view's page while a viewer shows the worker in full, and stop as none does. The call
 * stream Playwright keeps moves where its debugger stops: it is followed in a CI run that nothing pauses, and any other
 * run is followed through Playwright's in-process instrumentation, which moves nothing.
 */
function followCalls(own: Link): void {
  const shown = view;
  if (!shown || own !== link) return;
  const wanted = !!running && !own.logRefused && shownInFull(own);
  if (wanted && !shown.following) {
    const { page } = shown;
    const source = own.ci && !running!.mayPause ? 'stream' : 'listener';
    shown.following = followCallLog(
      page,
      running!.began,
      (log) => {
        if (view === shown && link === own && active(own) && own.viewers > 0) postLog(own, log);
      },
      { source, titleOf: layersTitleOf },
    ).catch(() => null);
  } else if (!wanted && shown.following) {
    void shown.following.then((stop) => stop?.());
    shown.following = null;
    forgetLog(own);
  }
}

/** The call log shown goes, and the one waiting to go. */
function forgetLog(own: Link): void {
  own.log = null;
  if (own.logTimer) clearTimeout(own.logTimer);
  own.logTimer = null;
}

/** Stop the view, `VIEW_END_MS` at most; one still opening is closed once it opened. */
async function stopView(): Promise<void> {
  const shown = view;
  view = null;
  stopLayers();
  if (!shown) return;
  shown.page.off('close', shown.onClose);
  void shown.following?.then((stop) => stop?.());
  if (link) forgetLog(link);
  const closed = shown.frames.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    closed.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, VIEW_END_MS);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
}

/** Post a frame with the call the test is on, one in flight at a time. */
function postFrame(own: Link, frame: PageFrame): void {
  if (!active(own)) return;
  own.posting = true;
  const call = running?.call() ?? null;
  const shown = { call: call && hideCallSecrets(call), test: running?.title ?? null };
  const at = Number.isFinite(frame.at) ? { at: Math.round(frame.at) } : {};
  const posted = own.asked
    ? postBody(own, encodeLiveMessage(liveFrameHeader(own.id, { ...shown, ...at }), frame.data), LIVE_FRAME_TYPE)
    : post(own, { type: 'frame', ...own.id, data: frame.data.toString('base64'), ...shown, ...at });
  own.framePost = posted
    .catch(() => undefined)
    .finally(() => {
      own.posting = false;
      own.framePost = null;
    });
}

/**
 * Post the call log shown now, `LOG_SPACING_MS` after the one before it at the soonest, one in flight: a newer one
 * replaces the one waiting, and one the instance had no room for (429) goes again unless a newer one came.
 */
function postLog(own: Link, log: LiveCallLog): void {
  own.log = log;
  nextLog(own);
}

/** Post the call log shown now once the one in flight is done and the spacing allows; once for any number asked. */
function nextLog(own: Link): void {
  if (own.logPosting || own.logTimer) return;
  const wait = LOG_SPACING_MS - (Date.now() - own.logSentAt);
  if (wait > 0) {
    own.logTimer = setTimeout(() => {
      own.logTimer = null;
      nextLog(own);
    }, wait);
    own.logTimer.unref?.();
    return;
  }
  const log = own.log;
  if (!active(own) || !view || !log || own.logRefused || !shownInFull(own)) return;
  own.logPosting = true;
  own.logSentAt = Date.now();
  let again = false;
  void post(own, { type: 'call-log', ...own.id, log, test: running?.title ?? null })
    .then((status) => {
      if (status === 400) own.logRefused = true;
      again = status === 429;
    })
    .catch(() => undefined)
    .finally(() => {
      own.logPosting = false;
      // A newer call log came while this one went, or this one found no room.
      if (own.log && (own.log !== log || again)) nextLog(own);
    });
}

/** Post a message to the run's endpoint while the run is shared (`send`). */
function post(own: Link, message: WorkerToInstance): Promise<number | null> {
  return active(own) ? send(own, message) : Promise.resolve(null);
}

/** Post a body of the media type `type` to the run's endpoint while the run is shared. */
function postBody(own: Link, body: Uint8Array, type: string): Promise<number | null> {
  return active(own) ? sendBody(own, body, type) : Promise.resolve(null);
}

/** Post a message to the run's endpoint as JSON (`sendBody`). */
function send(own: Link, message: WorkerToInstance): Promise<number | null> {
  return sendBody(own, JSON.stringify(message), 'application/json');
}

/**
 * Post a body of the media type `type` to the run's endpoint, with a key the instance takes; resolves with the
 * answer's status, or null when none came. Never throws.
 */
function sendBody(own: Link, body: string | Uint8Array, type: string): Promise<number | null> {
  if (own.ended || own.refused !== null) return Promise.resolve(null);
  return new Promise<number | null>((resolve) => {
    let settled = false;
    const settle = (status: number | null): void => {
      if (settled) return;
      settled = true;
      if (status !== null && GIVE_UP.has(status)) refuse(own, status);
      // The stream opens again, and hears from the instance whether it takes the key.
      else if (status !== null && NOT_NOW.has(status)) own.stream?.destroy();
      resolve(status);
    };
    const request = own.client.request(own.address.url, {
      method: 'POST',
      agent: own.agent,
      headers: {
        'Content-Type': type,
        'Content-Length': typeof body === 'string' ? Buffer.byteLength(body) : body.length,
        Authorization: `Bearer ${own.address.key}`,
      },
    });
    request.on('socket', (socket) => socket.unref());
    request.setTimeout(POST_TIMEOUT_MS, () => request.destroy());
    request.on('error', () => settle(null));
    request.on('close', () => settle(null));
    request.on('response', (response) => {
      response.resume();
      response.on('end', () => settle(response.statusCode ?? null));
      response.on('error', () => settle(null));
    });
    request.end(body);
  });
}
