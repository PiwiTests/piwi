import * as http from 'node:http';
import * as https from 'node:https';
import type { Page, WorkerInfo } from '@playwright/test';
import {
  LIVE_CALL_LOGS_PER_SECOND,
  LIVE_FRAME_BYTE_RATE,
  LIVE_FRAME_FPS,
  LIVE_FRAME_HEIGHT,
  LIVE_FRAME_QUALITY,
  LIVE_FRAME_WIDTH,
  LIVE_SHARE_MISSING,
  LIVE_SHARE_UNKNOWN,
  LIVE_VIEW_ENV,
  MAX_LIVE_FRAME,
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
} from '@piwitests/core/live-view';
import { hideSecretsInText, hideTypedText } from '@piwitests/core/mask';
import type { RunLiveState } from '@piwitests/core/run-channel';
import { fitViewSize } from '@piwitests/core/run-view';
import { detectCi } from '../support/ci.js';
import { resolveShardInfo } from '../support/shard-info.js';
import { followCallLog } from './live-call-log.js';
import { openPageView, type PageFrame, type PageView } from './page-view.js';

/**
 * The worker's connection to the team instance for the run page's live view (`@piwitests/core/live-view`), when the
 * run's environment names it (`PIWI_LIVE_VIEW`, which the reporter sets in `onBegin` for a run of a project that
 * turned the live view on). In a CI run, opened once per worker before its first test, as an event stream on which the
 * instance says how many people watch this worker; closed as the worker ends. Outside CI, the worker holds the key and
 * opens nothing until a person shares the run (**Share live**, `shareLiveView` from the run channel's `share`), and
 * closes the stream as they stop sharing it, the viewers hearing why (`unshared`); `liveViewState` says how it stands,
 * and why a run without a key cannot be shared (`none:<why>` in place of the address), for the run channel to tell.
 * Nothing goes to the instance while the run is not shared. While someone watches, the running test's page goes out as
 * its screencast (`page-view.ts`, through internal calls: nothing shows among the test's steps), at most
 * `LIVE_FRAME_WIDTH` by `LIVE_FRAME_HEIGHT` at `LIVE_FRAME_QUALITY`, `LIVE_FRAME_FPS` frames a second and
 * `LIVE_FRAME_BYTE_RATE` bytes, each frame posted with the call it was taken at, one post in flight, the latest frame
 * alone waiting. Nobody watching, no screencast runs and no frame goes. The view stops as nobody watches any more, as
 * the test ends (the viewers hear it, `ended`) and as its page closes; someone who watches while no test runs hears
 * why no image shows. Each frame names its test, so a view opened from one test's row ends at the next test's first
 * frame. The worker also posts when its test stops and goes on (`stop`), and the stop it holds again on each stream
 * it opens, since the instance forgets a stream's stop as it closes. In a CI run, while someone watches, it also posts
 * the call its test is in as Playwright logs it (`call-log`, `live-call-log.ts`), a few a second at most, the latest
 * again for a viewer that comes later. Every call named goes through
 * `hideSecretsInText`. A test never waits on any of it: a connection that fails is tried again a few times, then given
 * up until a person shares the run again, and a refused key gives it up at once, for the worker's life. The key is out
 * of the worker's environment from the connection's opening to its close (`hideKey`).
 */

/** How long the worker waits before it opens its stream again, after each failure in a row; then it gives up. */
const RETRY_MS = [1000, 2000, 4000, 8000, 16000];
/** How many times a worker opens its stream again over its life, at most. */
const MAX_RECONNECTS = 20;
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
/** The statuses that give the connection up: the key or the run is no longer one, or the instance has no live view. */
const GIVE_UP = new Set([401, 403, 404, 410]);

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
  retries: number;
  reconnects: number;
  /** The worker ended: nothing opens any more. */
  ended: boolean;
  /** Why the instance no longer takes the key, as a person reads it: nothing opens any more. */
  refused: string | null;
  /** Whether the stream is wanted: from the start in a CI run, while a person shares the run outside one. */
  sharing: boolean;
  /** Why the sharing stopped though nobody asked: the instance did not answer after the retries. */
  lost: string | null;
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
  /** A CI run's: the call log is followed while someone watches (`live-call-log.ts`). */
  ci: boolean;
  /** The call log shown now, whether one is posting, when the last one went, and the pause before the next goes. */
  log: LiveCallLog | null;
  logPosting: boolean;
  logSentAt: number;
  logTimer: ReturnType<typeof setTimeout> | null;
  /** The instance does not take call logs (it answered 400): none goes any more. */
  logRefused: boolean;
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
}

let running: RunningTest | null = null;
/** The view of the running test's page, while someone watches. */
let view: {
  page: Page;
  opened: Promise<PageView | null>;
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
  worker: Pick<WorkerInfo, 'workerIndex' | 'config'>,
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
    id: { shard: resolveShardInfo(worker.config, env)?.current ?? null, worker: worker.workerIndex },
    client,
    // The stream, and a frame, a call log and a stop or an end in flight at once: none waits behind another.
    agent: new client.Agent({ keepAlive: true, maxSockets: 4 }),
    stream: null,
    timer: null,
    retries: 0,
    reconnects: 0,
    ended: false,
    refused: null,
    sharing: ci,
    ci,
    lost: null,
    answered: null,
    viewers: 0,
    states: Promise.resolve(),
    statesWaiting: 0,
    stop: null,
    posting: false,
    log: null,
    logPosting: false,
    logSentAt: 0,
    logTimer: null,
    logRefused: false,
  };
  if (ci) connect(link);
  changed();
  return true;
}

/** Close the worker's connection, as the worker ends. */
export function closeLiveView(): void {
  const own = link;
  link = null;
  running = null;
  missing = null;
  showKey();
  void stopView();
  if (!own) return;
  own.ended = true;
  if (own.timer) clearTimeout(own.timer);
  own.stream?.destroy();
  own.agent.destroy();
}

/**
 * A person shares the run from now on (`on`): the stream opens, its retries counted afresh; or stops sharing it: the
 * view stops, the viewers hear why their view ends (`unshared`), and the stream closes, so nothing more goes to the
 * instance. Each one waits for the one before. Nothing happens for a worker without a key the instance takes.
 */
export function shareLiveView(on: boolean): Promise<void> {
  const turn = shareTurn.then(() => (on ? startSharing() : stopSharing()));
  shareTurn = turn.catch(() => undefined);
  return turn;
}

function startSharing(): void {
  const own = link;
  if (!own || own.ended || own.refused || own.sharing) return;
  own.sharing = true;
  own.lost = null;
  own.answered = null;
  own.retries = 0;
  own.reconnects = 0;
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
  running = { title, page: null, call, mayPause };
}

/** The running test's page: watched from now on, at once when someone already watches. */
export function liveViewPage(page: Page): void {
  if (!link || !running || running.page) return;
  running.page = page;
  if (link.viewers > 0 && active(link)) startView();
}

/** The test ended: its view stops, and the people watching hear it ended. */
export async function liveViewTestEnded(): Promise<void> {
  if (!running) return;
  running = null;
  await stopView();
  const own = link;
  if (own && own.viewers > 0 && active(own)) void post(own, { type: 'ended', ...own.id });
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

/** Open the stream, and open it again after a failure a few times, waiting longer each time. */
function connect(own: Link): void {
  if (!active(own)) return;
  const url = new URL(own.address.url);
  url.searchParams.set('worker', String(own.id.worker));
  if (own.id.shard !== null) url.searchParams.set('shard', String(own.id.shard));
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
    setViewers(own, 0);
    if (!active(own)) return;
    if (openedAt !== null && Date.now() - openedAt >= STEADY_MS) own.retries = 0;
    if (status !== null) own.answered = status;
    if (status !== null && GIVE_UP.has(status)) return void refuse(own, status);
    if (own.retries >= RETRY_MS.length || own.reconnects >= MAX_RECONNECTS) return void giveUp(own);
    const wait = RETRY_MS[own.retries++]!;
    own.reconnects++;
    own.timer = setTimeout(() => {
      own.timer = null;
      connect(own);
    }, wait);
    own.timer.unref?.();
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
        if (message) setViewers(own, message.count);
      }
    });
    response.on('error', () => drop(null));
    response.on('close', () => drop(null));
  });
  request.end();
}

/** The instance refused the key (`status`): nothing more is tried for the worker's life, and the run says why. */
function refuse(own: Link, status: number): void {
  if (own.refused !== null) return;
  own.refused = liveShareRefusal(status);
  own.viewers = 0;
  own.stream?.destroy();
  own.agent.destroy();
  void stopView();
  changed();
}

/**
 * The retries are over: the sharing stops, saying what the instance last answered (nothing, or that the run is
 * interrupted), and its stream closes; a person may share the run again.
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
  if (!active(own)) return;
  if (!running) {
    // Between two tests, or in a hook outside them: the one who came hears why no image shows.
    if (count > before) void post(own, { type: 'frame', ...own.id, refused: NO_TEST });
    return;
  }
  if (view) {
    if (count > before) {
      void view.opened.then((opened) => opened?.resend());
      if (own.log) postLog(own, own.log);
    }
    return;
  }
  startView();
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
  const opened = openPageView(page, {
    size: (viewport) => fitViewSize(viewport, LIVE_FRAME_WIDTH, LIVE_FRAME_HEIGHT),
    quality: LIVE_FRAME_QUALITY,
    fps: LIVE_FRAME_FPS,
    spacing: (frame) => (frame.data.length * 1000) / LIVE_FRAME_BYTE_RATE,
    maxFrameBytes: MAX_LIVE_FRAME,
    lightQuality: LIGHT_QUALITY,
    shotMs: SHOT_MS,
    busy: () => own.posting,
    live,
    send: (frame) => postFrame(own, frame),
    refuse: () => void post(own, { type: 'frame', ...own.id, refused: TOO_HEAVY }),
  }).catch(() => null);
  const onClose = (): void => {
    if (view?.page === page) void stopView();
  };
  page.once('close', onClose);
  // The call log Playwright keeps moves where its debugger stops: it is followed in a CI run that nothing pauses.
  const following =
    own.ci && !running?.mayPause && !own.logRefused
      ? followCallLog(page, (log) => postLog(own, log)).catch(() => null)
      : null;
  view = { page, opened, onClose, following };
}

/** Stop the view, `VIEW_END_MS` at most; one still opening is closed once it opened. */
async function stopView(): Promise<void> {
  const shown = view;
  view = null;
  if (!shown) return;
  shown.page.off('close', shown.onClose);
  void shown.following?.then((stop) => stop?.());
  const own = link;
  if (own) {
    own.log = null;
    if (own.logTimer) clearTimeout(own.logTimer);
    own.logTimer = null;
  }
  const closed = shown.opened.then((opened) => opened?.close());
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
  const data = frame.data.toString('base64');
  void post(own, {
    type: 'frame',
    ...own.id,
    data,
    call: call && hideCallSecrets(call),
    test: running?.title ?? null,
  })
    .catch(() => undefined)
    .finally(() => {
      own.posting = false;
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
  if (!active(own) || !view || !log || own.logRefused) return;
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

/**
 * Post a message to the run's endpoint, with a key the instance takes; resolves with the answer's status, or null
 * when none came. Never throws.
 */
function send(own: Link, message: WorkerToInstance): Promise<number | null> {
  if (own.ended || own.refused !== null) return Promise.resolve(null);
  const body = JSON.stringify(message);
  return new Promise<number | null>((resolve) => {
    let settled = false;
    const settle = (status: number | null): void => {
      if (settled) return;
      settled = true;
      if (status !== null && GIVE_UP.has(status)) refuse(own, status);
      resolve(status);
    };
    const request = own.client.request(own.address.url, {
      method: 'POST',
      agent: own.agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
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
