import * as http from 'node:http';
import * as https from 'node:https';
import type { Page, WorkerInfo } from '@playwright/test';
import {
  LIVE_FRAME_BYTE_RATE,
  LIVE_FRAME_FPS,
  LIVE_FRAME_HEIGHT,
  LIVE_FRAME_QUALITY,
  LIVE_FRAME_WIDTH,
  LIVE_VIEW_ENV,
  MAX_LIVE_FRAME,
  parseInstanceToWorker,
  parseLiveViewEnv,
  type LiveCall,
  type LiveStop,
  type LiveViewAddress,
  type LiveWorkerId,
  type WorkerToInstance,
} from '@piwitests/core/live-view';
import { hideSecretsInText } from '@piwitests/core/mask';
import { fitViewSize } from '@piwitests/core/run-view';
import { resolveShardInfo } from '../support/shard-info.js';
import { openPageView, type PageFrame, type PageView } from './page-view.js';

/**
 * The worker's connection to the team instance for the run page's live view (`@piwitests/core/live-view`), when the
 * run's environment names it (`PIWI_LIVE_VIEW`, which the reporter sets in `onBegin` for a run of a project that
 * turned the live view on). Opened once per worker before its first test, as an event stream on which the instance
 * says how many people watch this worker; closed as the worker ends. While someone watches, the running test's page
 * goes out as its screencast (`page-view.ts`, through internal calls: nothing shows among the test's steps), at most
 * `LIVE_FRAME_WIDTH` by `LIVE_FRAME_HEIGHT` at `LIVE_FRAME_QUALITY`, `LIVE_FRAME_FPS` frames a second and
 * `LIVE_FRAME_BYTE_RATE` bytes, each frame posted with the call it was taken at, one post in flight, the latest frame
 * alone waiting. Nobody watching, no screencast runs and no frame goes. The view stops as nobody watches any more, as
 * the test ends (the viewers hear it, `ended`) and as its page closes; someone who watches while no test runs hears
 * why no image shows. Each frame names its test, so a view opened from one test's row ends at the next test's first
 * frame. The worker also posts when its test stops and goes on (`stop`), and the stop it holds again on each stream
 * it opens, since the instance forgets a stream's stop as it closes. Every call named goes through
 * `hideSecretsInText`. A test never waits on any of it: a connection that fails is tried again a few times, then given
 * up for the worker's life, and a refused key gives it up at once. The key is out of the worker's environment from the
 * connection's opening to its close (`hideKey`).
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
  closed: boolean;
  viewers: number;
  /** The posts of a stop's start and end, one after the other, and how many wait. */
  states: Promise<unknown>;
  statesWaiting: number;
  /** The stop the worker's test holds now, posted again each time the stream opens. */
  stop: LiveStop | null;
  /** Whether a frame's post is in flight. */
  posting: boolean;
}

let link: Link | null = null;

/** The test the worker runs: its title, its page once known, and the call it is on. */
interface RunningTest {
  title: string;
  page: Page | null;
  call: () => LiveCall | null;
}

let running: RunningTest | null = null;
/** The view of the running test's page, while someone watches. */
let view: { page: Page; opened: Promise<PageView | null>; onClose: () => void } | null = null;

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

/** Whether the worker holds a connection to the instance's live view, or tried to. */
export function liveViewOpen(): boolean {
  return link !== null;
}

/**
 * Open the worker's connection to the instance when the run's environment names one, and take the key out of that
 * environment until the connection closes. Returns at once, whether it named one; the stream opens in the background.
 * Never throws.
 */
export function openLiveView(
  worker: Pick<WorkerInfo, 'workerIndex' | 'config'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (link) return false;
  const address = parseLiveViewEnv(env[LIVE_VIEW_ENV]);
  hideKey(env);
  if (!address) return false;
  const secure = address.url.startsWith('https:');
  const client = secure ? https : http;
  link = {
    address,
    id: { shard: resolveShardInfo(worker.config, env)?.current ?? null, worker: worker.workerIndex },
    client,
    agent: new client.Agent({ keepAlive: true, maxSockets: 2 }),
    stream: null,
    timer: null,
    retries: 0,
    reconnects: 0,
    closed: false,
    viewers: 0,
    states: Promise.resolve(),
    statesWaiting: 0,
    stop: null,
    posting: false,
  };
  connect(link);
  return true;
}

/** Close the worker's connection, as the worker ends. */
export function closeLiveView(): void {
  const own = link;
  link = null;
  running = null;
  showKey();
  void stopView();
  if (!own) return;
  own.closed = true;
  if (own.timer) clearTimeout(own.timer);
  own.stream?.destroy();
  own.agent.destroy();
}

/** A test titled `title` begins: `call` names the call it is on, for each frame. */
export function liveViewTestBegan(title: string, call: () => LiveCall | null): void {
  if (!link) return;
  running = { title, page: null, call };
}

/** The running test's page: watched from now on, at once when someone already watches. */
export function liveViewPage(page: Page): void {
  if (!link || !running || running.page) return;
  running.page = page;
  if (link.viewers > 0 && !link.closed) startView();
}

/** The test ended: its view stops, and the people watching hear it ended. */
export async function liveViewTestEnded(): Promise<void> {
  if (!running) return;
  running = null;
  await stopView();
  const own = link;
  if (own && own.viewers > 0 && !own.closed) void post(own, { type: 'ended', ...own.id });
}

/** The running test stopped at `stop`: the run page shows it paused until the function returned is called. */
export function liveViewStopped(stop: LiveStop): () => void {
  const own = link;
  if (!own || own.closed) return () => undefined;
  const shown = { ...stop, call: hideCallSecrets(stop.call) };
  own.stop = shown;
  postState(own, { type: 'stop', ...own.id, stop: shown });
  return () => {
    if (own.stop === shown) own.stop = null;
    postState(own, { type: 'stop', ...own.id, stop: null });
  };
}

/** A call as the run page shows it: its title through `hideSecretsInText`, which a URL or a token may hold. */
function hideCallSecrets(call: LiveCall): LiveCall {
  return { ...call, title: hideSecretsInText(call.title) };
}

/** Post a stop's start or end after the ones before it, a few waiting at most. */
function postState(own: Link, message: WorkerToInstance): void {
  if (own.closed || own.statesWaiting >= MAX_STATES_WAITING) return;
  own.statesWaiting++;
  own.states = own.states
    .then(() => post(own, message))
    .finally(() => {
      own.statesWaiting--;
    });
}

/** Open the stream, and open it again after a failure a few times, waiting longer each time. */
function connect(own: Link): void {
  if (own.closed) return;
  const url = new URL(own.address.url);
  url.searchParams.set('worker', String(own.id.worker));
  if (own.id.shard !== null) url.searchParams.set('shard', String(own.id.shard));
  let openedAt: number | null = null;
  let dropped = false;
  const drop = (giveUp: boolean): void => {
    if (dropped) return;
    dropped = true;
    if (own.stream === request) own.stream = null;
    setViewers(own, 0);
    if (own.closed) return;
    if (openedAt !== null && Date.now() - openedAt >= STEADY_MS) own.retries = 0;
    if (giveUp || own.retries >= RETRY_MS.length || own.reconnects >= MAX_RECONNECTS) return void giveUpLink(own);
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
  request.on('error', () => drop(false));
  request.on('close', () => drop(false));
  request.on('response', (response) => {
    if (response.statusCode !== 200) {
      response.resume();
      return drop(GIVE_UP.has(response.statusCode ?? 0));
    }
    openedAt = Date.now();
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
    response.on('error', () => drop(false));
    response.on('close', () => drop(false));
  });
  request.end();
}

/** Nothing more is tried for the worker's life. */
function giveUpLink(own: Link): void {
  own.closed = true;
  own.viewers = 0;
  own.agent.destroy();
}

/**
 * How many people watch the worker now: the view starts with the first, sends its latest frame again for a later one,
 * and stops with the last.
 */
function setViewers(own: Link, count: number): void {
  const before = own.viewers;
  own.viewers = count;
  if (own !== link) return;
  if (count === 0) return void stopView();
  if (!running) {
    // Between two tests, or in a hook outside them: the one who came hears why no image shows.
    if (count > before && !own.closed) void post(own, { type: 'frame', ...own.id, refused: NO_TEST });
    return;
  }
  if (view) {
    if (count > before) void view.opened.then((opened) => opened?.resend());
    return;
  }
  startView();
}

/** Start the view of the running test's page; say why there is none while it has no page. */
function startView(): void {
  const own = link;
  const page = running?.page ?? null;
  if (!own || own.closed || view) return;
  if (!page || page.isClosed()) {
    void post(own, { type: 'frame', ...own.id, refused: NO_PAGE });
    return;
  }
  const live = (): boolean => view?.page === page && link === own && !own.closed && own.viewers > 0;
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
  view = { page, opened, onClose };
}

/** Stop the view, `VIEW_END_MS` at most; one still opening is closed once it opened. */
async function stopView(): Promise<void> {
  const shown = view;
  view = null;
  if (!shown) return;
  shown.page.off('close', shown.onClose);
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
  if (own.closed) return;
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

/** Post a message to the run's endpoint; resolves with the answer's status, or null when none came. Never throws. */
function post(own: Link, message: WorkerToInstance): Promise<number | null> {
  if (own.closed) return Promise.resolve(null);
  const body = JSON.stringify(message);
  return new Promise<number | null>((resolve) => {
    let settled = false;
    const settle = (status: number | null): void => {
      if (settled) return;
      settled = true;
      if (status !== null && GIVE_UP.has(status)) giveUpLink(own);
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
