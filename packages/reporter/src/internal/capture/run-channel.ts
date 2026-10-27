import * as net from 'node:net';
import type { Page, WorkerInfo } from '@playwright/test';
import { lineReader, parseRecordChannel } from '@piwitests/core/ide-recorder';
import {
  RUN_CHANNEL_ENV,
  RUN_INTENT_NAMES,
  RUN_TAKES,
  parseHubToRun,
  type HubToRun,
  type IntentAnswer,
  type LocatorAnswer,
  type PausedImage,
  type PickAtAnswer,
  type Place,
  type RunIntent,
  type RunToHub,
  type StopReason,
  type UnknownMessage,
} from '@piwitests/core/run-channel';
import {
  LatestPacer,
  MAX_VIEW_EVENT_RATE,
  MAX_VIEW_FPS,
  MAX_VIEW_FRAME,
  RateWindow,
  VIEW_QUALITY,
  isViewSize,
  viewSize,
  type ViewButton,
  type ViewInput,
} from '@piwitests/core/run-view';
import { PIWI_LOCAL_DEBUG_ENV, PIWI_ORIGIN_ENV } from '../config/env.js';
import { errorMessage } from '../support/errors.js';
import { getReporterVersion } from '../support/reporter-version.js';
import { locatorOn } from './chain-locator.js';
import { keptRequests, keptResponse } from './kept-responses.js';
import type { PauseAnswer } from './pause-at.js';
import { internalCall } from './quiet-capture.js';

/**
 * The worker's run connection to the editor that started the run: the socket the run's environment names
 * (`PIWI_RUN_CHANNEL`, `@piwitests/core/run-channel`), opened once per worker before its first test and kept until
 * the worker ends. The worker says which test it runs and where it stops; the editor pauses it, answers its stops
 * (Step, Resume, Finish, Run to a line), changes the run's breakpoints, asks for an image of the stopped page, starts
 * the pause bar's Pick a locator or Record here, the check panel's Check an element or a region's ARIA snapshot from
 * outside the page, asks for the responses the test kept (`kept-responses.ts`) and the one to mock, and counts a
 * locator on the stopped page, outlining its matches where the bar shows until the test goes on (`takes` in its
 * attach). For a viewer outside the page, it shows the stopped page's live view (`view`: the page's screencast, its
 * frames sent at most `MAX_VIEW_FPS` a second, the latest one when the connection is backed up, never kept), plays
 * the viewer's input on it as trusted input (`input`: `page.mouse`, `page.keyboard`, at most `MAX_VIEW_EVENT_RATE`
 * events a second, what it holds down let go before the test goes on), and sends the locator of the element under a
 * point of an image of the page where a pick goes (`pick-at`, `pick-at.ts`). The view ends with its stop, before the
 * test goes on, and as its page or the connection closes. A test never waits on it but while stopped, and a
 * connection that does not open, or closes, leaves the run as without it: a stop no pause bar can answer then goes on
 * at once.
 */

/** How long a worker waits for its run connection to open before its first test runs without it. */
const CONNECT_MS = 2000;

/** The pause bar, hidden in an image of the stopped page. */
const BAR_HIDDEN = '#__piwi-pause-bar { display: none !important; }';

/** How the matches of the locator at the editor's caret are outlined in the stopped page. */
const OUTLINE_STYLE = 'outline: 2px dashed #a78bfa; outline-offset: 2px; background: rgba(167, 139, 250, 0.15);';

/** Why a request naming a stop that ended is refused. */
const WENT_ON = 'The test went on.';

/** How many bytes of frames may wait in the run connection: the next frame waits until fewer do, the latest one alone. */
const MAX_FRAME_BACKLOG = 1024 * 1024;
/** How often a view that cannot use the page's screencast takes an image of the page instead. */
const SHOT_MS = 500;
/** How long ending a view, and the input it plays, may take before its stop ends without waiting for them. */
const VIEW_END_MS = 1000;
/** How long starting a view, and a pick on an image, may take before the editor hears that the page did not answer. */
const PAGE_ANSWER_MS = 10_000;
/** Why a view or a pick on an image is refused when the page does not answer. */
const NO_ANSWER = 'The page did not answer in time.';
/** The most input messages a stop holds waiting to be played: one more is refused. */
const MAX_INPUT_WAITING = 4;
/** Why the input of a stop nobody watches is refused. */
const NEEDS_VIEW = 'The input needs the live view of this stop: watch it first.';
/** Why a stop whose page is not known has no view. */
const NO_PAGE =
  "This stop has no page to show: its call does not name one among its context's pages. Use the pause bar in the test's window.";

/** What the editor asks that the capture fixtures apply to the running test's stops. */
export interface RunControl {
  /** Stop before the next call: of the running test, else of the next one. */
  pause(): void;
  /** The run's breakpoints from now on. */
  breakpoints(places: Place[]): void;
  /** Stop at the first call on this place's line. */
  runTo(place: Place): void;
}

/**
 * The stop the editor can answer, while it holds: the page its image is of (none when not known), its answer, and what
 * starts an intent in the pause bar.
 */
interface HeldStop {
  stop: number;
  page: Page | null;
  bar: boolean;
  answer(choice: PauseAnswer): void;
  intent(what: RunIntent): IntentAnswer;
  pickAt?(x: number, y: number): Promise<PickAtAnswer>;
}

/** A stop as the editor hears it. */
export interface StopToHold {
  reason: StopReason;
  title: string;
  place: Place;
  locator: string | null;
  /** Whether Piwi's pause bar shows the stop. */
  bar: boolean;
  /** A failure's error, as plain text: the editor shows it beside the stop. */
  error?: string;
  /** The page an image of the stop is taken of: none when the stop's page is not known. */
  page: Page | null;
  /**
   * Start the bar's Pick a locator or Record here from outside the page, at a stop no bar shows only while its live
   * view is watched; refused without it.
   */
  intent?(what: RunIntent): IntentAnswer;
  /** The element under a point of the stopped page, its locator sent where a pick goes; refused without it. */
  pickAt?(x: number, y: number): Promise<PickAtAnswer>;
}

let socket: net.Socket | null = null;
let control: RunControl | null = null;
let stops = 0;
let held: HeldStop | null = null;
/** The outline of a locator's matches in a stopped page, and the stop it belongs to. */
let outline: { stop: number; remove(): Promise<void> } | null = null;
/**
 * The counts of locators asked, one after another (the editor asks one per move of its caret): each takes the outline
 * of the one before down before it draws its own, and the end of a stop waits for the last to take its outline down.
 */
let counting: Promise<unknown> = Promise.resolve();

/** The live view of the stop held, while the editor's viewers watch it: whether it is the page's screencast. */
interface View {
  stop: number;
  screencast: boolean;
  close(): Promise<void>;
}

let view: View | null = null;
/** A view on its way, for the stop it is of. */
let viewStarting: { stop: number; started: Promise<IntentAnswer> } | null = null;
/** The editor's requests to start and stop a view, one after the other, in the order they came. */
let viewTurn: Promise<unknown> = Promise.resolve();
/** What ends with the view of the stop held: a pick or a recording driven through it. */
const viewEnds = new Set<() => void>();

/** The input of the stop held: its pace, the message playing, how many wait, and what it holds down. */
interface InputState {
  rate: RateWindow;
  playing: Promise<unknown>;
  waiting: number;
  buttons: Set<ViewButton>;
  keys: Set<string>;
}

function freshInput(): InputState {
  return {
    rate: new RateWindow(MAX_VIEW_EVENT_RATE),
    playing: Promise.resolve(),
    waiting: 0,
    buttons: new Set(),
    keys: new Set(),
  };
}

let input = freshInput();
/** A pick on an image runs: the next one waits for its answer. */
let pickingAt = false;

/**
 * Open the worker's run connection when the run names a channel and a ref, with `handlers` for what the editor asks.
 * Resolves with whether it opened, once it did, failed or took too long. Never throws.
 */
export async function openRunChannel(
  worker: Pick<WorkerInfo, 'workerIndex' | 'parallelIndex' | 'config'>,
  handlers: RunControl,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const channel = parseRecordChannel(env[RUN_CHANNEL_ENV]);
  const ref = env[PIWI_ORIGIN_ENV.ref];
  if (socket || !channel || !ref || !/^[\w-]{1,64}$/.test(ref)) return false;
  const opening = net.connect(channel.path);
  opening.setEncoding('utf8');
  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), CONNECT_MS);
    opening.once('connect', () => {
      clearTimeout(timer);
      resolve(true);
    });
    opening.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (!opened || opening.destroyed) {
    opening.destroy();
    return false;
  }
  socket = opening;
  control = handlers;
  opening.unref();
  opening.on(
    'data',
    lineReader(
      (line) => onMessage(parseHubToRun(line)),
      () => opening.destroy(),
    ),
  );
  opening.on('error', () => opening.destroy());
  opening.on('close', () => {
    if (socket === opening) socket = null;
    // Nobody hears the view any more.
    if (view) void stopView();
    if (!held || held.bar) return;
    // A stop no bar can answer goes on: nobody else can.
    console.log('[piwi] The connection to the editor closed: the test goes on.');
    held.answer('resume');
  });
  tellHub({
    type: 'run-attach',
    token: channel.token,
    ref,
    cwd: process.cwd(),
    workerIndex: worker.workerIndex,
    parallelIndex: worker.parallelIndex,
    pid: process.pid,
    playwright: worker.config.version,
    reporter: getReporterVersion(),
    takes: [...RUN_TAKES],
  });
  return true;
}

/** What a test runs without: the run's channel, and the editor's Send to editor pairing with its token. */
const HIDDEN_ENV = [RUN_CHANNEL_ENV, PIWI_LOCAL_DEBUG_ENV.editorSend] as const;

/** `PIWI_EDITOR_SEND` while a test runs without it: where the test's picks go. */
let hiddenEditorSend: string | undefined;

/**
 * Take the run's channel and the editor's pairing out of the worker's environment while a test runs, so a process the
 * test starts (Playwright run from a test) opens no connection on this run and is not handed the pairing's token;
 * returns what puts them back once the test ended. The test's picks still go to the pairing (`editorSendAddress`).
 * Playwright compares a worker's environment as it stops with the one it started with, and hands what changed to the
 * projects that depend on its own: between tests, both are there. `PIWI_RECORD_CHANNEL` stays, for **Record here**.
 */
export function hideRunChannel(env: NodeJS.ProcessEnv = process.env): () => void {
  const hidden = HIDDEN_ENV.flatMap((name) => {
    const value = env[name];
    return value === undefined ? [] : [{ name, value }];
  });
  for (const { name } of hidden) delete env[name];
  hiddenEditorSend = hidden.find(({ name }) => name === PIWI_LOCAL_DEBUG_ENV.editorSend)?.value;
  return () => {
    for (const { name, value } of hidden) env[name] = value;
    hiddenEditorSend = undefined;
  };
}

/** The editor's Send to editor pairing a pick goes to: `PIWI_EDITOR_SEND`, also while a test runs without it. */
export function editorSendAddress(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[PIWI_LOCAL_DEBUG_ENV.editorSend] ?? hiddenEditorSend;
}

/** Close the worker's run connection, as the worker ends. */
export function closeRunChannel(): void {
  socket?.end();
  socket = null;
  control = null;
}

/** Whether the worker's run connection is open. */
export function runChannelOpen(): boolean {
  return !!socket && !socket.destroyed;
}

/** Send the editor a message, when the run connection is open. */
export function tellHub(message: RunToHub): void {
  if (socket && !socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

/**
 * Hold a stop for the editor: it hears where the test stopped, and its answer reaches `onAnswer`, once, until
 * `release`, which takes the outline of a locator down and tells it the stop ended, however it did. `stop` is the
 * worker's number for it, which the editor's requests name.
 */
export function holdStop(
  stop: StopToHold,
  onAnswer: (answer: PauseAnswer) => void,
): { stop: number; release(): Promise<void> } {
  const id = ++stops;
  let answered = false;
  const needsBar = (what: RunIntent): IntentAnswer => ({
    ok: false,
    message: `${RUN_INTENT_NAMES[what]} needs the pause bar in the test's window, and this stop shows none: run the test headed.`,
  });
  const holding: HeldStop = {
    stop: id,
    page: stop.page,
    bar: stop.bar,
    answer: (choice) => {
      if (answered) return;
      answered = true;
      onAnswer(choice);
    },
    intent: (what) =>
      answered
        ? { ok: false, message: WENT_ON }
        : // A stop no bar shows takes an intent only while its live view is watched, which drives it.
          !stop.bar && view?.stop !== id
          ? needsBar(what)
          : (stop.intent?.(what) ?? needsBar(what)),
    ...(stop.pickAt ? { pickAt: stop.pickAt } : {}),
  };
  held = holding;
  tellHub({
    type: 'stopped',
    stop: id,
    reason: stop.reason,
    title: stop.title,
    place: stop.place,
    locator: stop.locator,
    bar: stop.bar,
    ...(stop.error ? { error: stop.error } : {}),
  });
  if (!runChannelOpen() && !stop.bar) holding.answer('resume');
  return {
    stop: id,
    release: async () => {
      answered = true;
      if (held === holding) held = null;
      await counting;
      if (outline?.stop === id) await removeOutline();
      await endView(id, stop.page);
      tellHub({ type: 'running', stop: id });
    },
  };
}

/** A signal that aborts once the live view of the stop `stop` ends; aborted already when it is not watched. */
export function viewEnded(stop: number): AbortSignal {
  const ended = new AbortController();
  if (view?.stop !== stop) ended.abort();
  else viewEnds.add(() => ended.abort());
  return ended.signal;
}

/** `run`, for `ms` at most: settles once it did or they passed, never throwing. */
async function within(run: Promise<unknown>, ms: number): Promise<void> {
  await answerWithin(run, ms, undefined);
}

/** What `run` resolves with, or `late` once `ms` passed (or it failed), `run` left to settle on its own. */
async function answerWithin<T, L>(run: Promise<T>, ms: number, late: L): Promise<T | L> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run.catch(() => late),
      new Promise<L>((resolve) => (timer = setTimeout(() => resolve(late), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The stop `stop` ends: its view stops, the input playing is waited for, and what it holds down (a mouse button, a
 * key) is let go, each `VIEW_END_MS` at most, before the test goes on.
 */
async function endView(stop: number, page: Page | null): Promise<void> {
  if (viewStarting?.stop === stop) await within(viewStarting.started, VIEW_END_MS);
  if (view?.stop === stop) await stopView();
  const own = input;
  input = freshInput();
  await within(own.playing, VIEW_END_MS);
  if (page && !page.isClosed() && (own.buttons.size || own.keys.size)) {
    await within(
      internalCall(page, async () => {
        for (const button of own.buttons) await page.mouse.up({ button });
        for (const key of own.keys) await page.keyboard.up(key);
      }),
      VIEW_END_MS,
    );
  }
}

/** Stop the live view, and end what was driven through it. */
async function stopView(): Promise<void> {
  const shown = view;
  view = null;
  for (const end of viewEnds) end();
  viewEnds.clear();
  if (shown) await within(shown.close(), VIEW_END_MS);
}

/** The page's viewport in CSS pixels; null when it cannot be read. */
async function viewportOf(page: Page): Promise<{ width: number; height: number } | null> {
  const size = page.viewportSize();
  if (size) return size;
  type Window = { innerWidth: number; innerHeight: number };
  const read = await internalCall(page, () =>
    page.evaluate(() => {
      const { innerWidth, innerHeight } = globalThis as unknown as Window;
      return { width: innerWidth, height: innerHeight };
    }),
  ).catch(() => null);
  return read && isViewSize(read.width, read.height) ? read : null;
}

/** Start the live view of a stop the editor asked for, or say why there is none. */
function startView(holding: HeldStop): Promise<IntentAnswer> {
  if (view?.stop === holding.stop) return Promise.resolve({ ok: true, message: 'The live view is on.' });
  if (viewStarting?.stop === holding.stop) return viewStarting.started;
  const page = holding.page;
  if (!page || page.isClosed()) return Promise.resolve({ ok: false, message: NO_PAGE });
  const started = (async (): Promise<IntentAnswer> => {
    if (view) await stopView();
    const opening = openView(page, holding.stop);
    const opened = await answerWithin(opening, PAGE_ANSWER_MS, 'late' as const);
    if (opened === 'late') {
      // One that opens after all is closed at once: nobody waits for it.
      void opening.then((late) => late?.close());
      return { ok: false, message: NO_ANSWER };
    }
    if (!opened) return { ok: false, message: 'The page could not be shown: it closed, or does not answer.' };
    if (held !== holding || page.isClosed()) {
      await within(opened.close(), VIEW_END_MS);
      return { ok: false, message: WENT_ON };
    }
    view = opened;
    return {
      ok: true,
      message: opened.screencast
        ? 'The live view is on.'
        : "The live view is on, as images of the page twice a second: the page's screencast is in use.",
    };
  })().finally(() => {
    if (viewStarting?.started === started) viewStarting = null;
  });
  viewStarting = { stop: holding.stop, started };
  return started;
}

/** A frame as the page painted it, and the viewport it shows, in CSS pixels. */
interface Frame {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Open the live view of a page at the stop `stop`: the page's screencast (`page.screencast.start`, an internal call),
 * at the size of its viewport scaled down to fit `MAX_VIEW_WIDTH` by `MAX_VIEW_HEIGHT` and `VIEW_QUALITY`, unless
 * another client of the screencast (a test's video, its trace's images) came first, whose size and quality every
 * later one gets; its own end leaves that client as it is. Where the screencast cannot start (the test runs one
 * itself), an image of the page every `SHOT_MS`. Each frame goes to the editor as `frame`: a frame the same as the one
 * before, or longer than `MAX_VIEW_FRAME`, is dropped, and the others go at most `MAX_VIEW_FPS` a second, the latest
 * one when the connection is backed up. Null when the page cannot be read.
 */
async function openView(page: Page, stop: number): Promise<View | null> {
  const viewport = await viewportOf(page);
  if (!viewport) return null;
  let closed = false;
  let last: Buffer | null = null;
  const pacer = new LatestPacer<Frame>({
    intervalMs: 1000 / MAX_VIEW_FPS,
    busy: () => !!socket && socket.writableLength > MAX_FRAME_BACKLOG,
    send: (frame) => {
      // Once its stop began to end, no frame of it goes.
      if (held?.stop !== stop) return;
      tellHub({ type: 'frame', stop, width: frame.width, height: frame.height, data: frame.data.toString('base64') });
    },
  });
  const onFrame = (data: Buffer, width: number, height: number): void => {
    if (closed || data.length > MAX_VIEW_FRAME || last?.equals(data)) return;
    last = data;
    const named = isViewSize(width, height);
    pacer.offer({ data, width: named ? width : viewport.width, height: named ? height : viewport.height });
  };
  const onClose = () => {
    if (view?.stop === stop) void stopView();
  };
  page.once('close', onClose);
  type Started = { dispose?: () => Promise<unknown> } | undefined;
  type Screencast = {
    start?: (options: {
      size: { width: number; height: number };
      quality: number;
      onFrame: (frame: { data: Buffer; viewportWidth: number; viewportHeight: number }) => Promise<void> | void;
    }) => Promise<Started>;
    stop?: () => Promise<void>;
  };
  const screencast = (page as unknown as { screencast?: Screencast }).screencast;
  let end: (() => Promise<unknown>) | null = null;
  let shots: ReturnType<typeof setTimeout> | null = null;
  /** When the last frame taken is acknowledged: one each `1000 / MAX_VIEW_FPS` ms at most. */
  let ackAt = 0;
  try {
    if (typeof screencast?.start !== 'function') throw new Error('This Playwright has no screencast.');
    const started = await internalCall(page, () =>
      screencast.start!({
        size: viewSize(viewport),
        quality: VIEW_QUALITY,
        // Each frame is acknowledged at the view's pace: a browser that waits for its frames' acknowledgments (as
        // Chromium and Firefox do when no other client acknowledges them at once) paints no more of them.
        onFrame: (frame) => {
          onFrame(frame.data, frame.viewportWidth, frame.viewportHeight);
          const now = Date.now();
          ackAt = Math.max(now, ackAt + 1000 / MAX_VIEW_FPS);
          if (closed || ackAt <= now) return;
          return new Promise<void>((resolve) => setTimeout(resolve, ackAt - now).unref());
        },
      }),
    );
    // Its own client alone: the client a test's video records through stays.
    end = () =>
      internalCall(page, async () => {
        if (typeof started?.dispose === 'function') await started.dispose();
        else await screencast.stop?.();
      });
  } catch {
    const shoot = async (): Promise<void> => {
      shots = null;
      if (closed || page.isClosed()) return;
      const shot = await internalCall(page, () =>
        page.screenshot({ type: 'jpeg', quality: VIEW_QUALITY, scale: 'css', timeout: 5000 }),
      ).catch(() => null);
      if (shot) onFrame(shot, viewport.width, viewport.height);
      if (!closed) shots = setTimeout(() => void shoot(), SHOT_MS);
    };
    void shoot();
  }
  return {
    stop,
    screencast: end !== null,
    close: async () => {
      closed = true;
      pacer.close();
      page.off('close', onClose);
      if (shots) clearTimeout(shots);
      if (end && !page.isClosed()) await end().catch(() => undefined);
    },
  };
}

/** Stop the live view of a stop the editor no longer watches. */
async function stopViewOf(holding: HeldStop): Promise<IntentAnswer> {
  if (viewStarting?.stop === holding.stop) await within(viewStarting.started, VIEW_END_MS);
  if (view?.stop === holding.stop) await stopView();
  return { ok: true, message: 'The live view is off.' };
}

/**
 * Play a viewer's input at the stop held, in order, after the input sent before it: refused while the stop's view is
 * not watched, past `MAX_VIEW_EVENT_RATE` events a second and with `MAX_INPUT_WAITING` messages waiting. The events
 * of a stop that ends meanwhile are not played.
 */
function playInput(holding: HeldStop, events: ViewInput[]): Promise<IntentAnswer> {
  const page = holding.page;
  if (!page || view?.stop !== holding.stop) return Promise.resolve({ ok: false, message: NEEDS_VIEW });
  const own = input;
  if (own.waiting >= MAX_INPUT_WAITING) {
    return Promise.resolve({ ok: false, message: 'The page still plays the input sent before: send less at once.' });
  }
  if (!own.rate.take(events.length)) {
    return Promise.resolve({ ok: false, message: `Too much input: ${MAX_VIEW_EVENT_RATE} events a second at most.` });
  }
  own.waiting++;
  const played = own.playing
    .then(async (): Promise<IntentAnswer> => {
      for (const [i, event] of events.entries()) {
        if (held !== holding || input !== own || view?.stop !== holding.stop || page.isClosed()) {
          return { ok: false, message: i ? `The stop ended after ${i} of the events.` : WENT_ON };
        }
        try {
          await internalCall(page, () => playEvent(page, event, own));
        } catch (error) {
          return { ok: false, message: `Event ${i + 1} could not be played: ${errorMessage(error)}` };
        }
      }
      return { ok: true, message: events.length === 1 ? 'Played 1 event.' : `Played ${events.length} events.` };
    })
    .finally(() => own.waiting--);
  own.playing = played.catch(() => undefined);
  return played;
}

/** Play one event on the page as trusted input, keeping what it holds down. */
async function playEvent(page: Page, event: ViewInput, own: InputState): Promise<void> {
  switch (event.type) {
    case 'mouse':
      if (event.action === 'move') return page.mouse.move(event.x, event.y);
      if (event.action === 'click') {
        return page.mouse.click(event.x, event.y, { button: event.button, clickCount: event.clickCount });
      }
      await page.mouse.move(event.x, event.y);
      if (event.action === 'down') {
        own.buttons.add(event.button);
        return page.mouse.down({ button: event.button });
      }
      own.buttons.delete(event.button);
      return page.mouse.up({ button: event.button });
    case 'wheel':
      await page.mouse.move(event.x, event.y);
      return page.mouse.wheel(event.deltaX, event.deltaY);
    case 'key':
      if (event.action === 'press') return page.keyboard.press(event.key);
      if (event.action === 'down') {
        own.keys.add(event.key);
        return page.keyboard.down(event.key);
      }
      own.keys.delete(event.key);
      return page.keyboard.up(event.key);
    case 'text':
      return page.keyboard.insertText(event.text);
  }
}

/** The element under a point of the stopped page, one pick at a time. */
async function pickAtStop(holding: HeldStop, x: number, y: number): Promise<PickAtAnswer> {
  if (!holding.pickAt) return { ok: false, message: NO_PAGE, locator: null };
  if (pickingAt) return { ok: false, message: 'A pick on the image runs: wait for its answer.', locator: null };
  pickingAt = true;
  try {
    return await answerWithin(holding.pickAt(x, y), PAGE_ANSWER_MS, { ok: false, message: NO_ANSWER, locator: null });
  } finally {
    pickingAt = false;
  }
}

/** Take the outline of a locator's matches down, before the test goes on. */
async function removeOutline(): Promise<void> {
  const shown = outline;
  outline = null;
  await shown?.remove().catch(() => undefined);
}

/**
 * How many elements `source` matches on the stopped page, its matches outlined where the pause bar shows, in place of
 * the outline before; null takes the outline down. Every call to the page is internal.
 */
async function countLocator(holding: HeldStop, source: string | null): Promise<LocatorAnswer> {
  await removeOutline();
  if (source === null) return { ok: true, message: 'The outline is gone.', count: null };
  const page = holding.page;
  if (!page || page.isClosed()) return { ok: false, message: 'This stop has no page to count on.', count: null };
  const locator = locatorOn(page, source);
  if (!locator) return { ok: false, message: `${source} is not a locator Piwi can build.`, count: null };
  try {
    const count = await internalCall(page, () => locator.count());
    if (holding.bar && count > 0 && held === holding) {
      const shown = (await internalCall(page, () => locator.highlight({ style: OUTLINE_STYLE }))) as unknown;
      const dispose = (shown as { dispose?: () => Promise<void> } | null)?.dispose;
      outline = {
        stop: holding.stop,
        remove: () =>
          internalCall(page, () => (typeof dispose === 'function' ? dispose.call(shown) : page.hideHighlight())),
      };
    }
    return {
      ok: true,
      message: count === 0 ? 'No element matches.' : count === 1 ? '1 element matches.' : `${count} elements match.`,
      count,
    };
  } catch (error) {
    return { ok: false, message: `The locator could not be counted: ${errorMessage(error)}`, count: null };
  }
}

function onMessage(message: HubToRun | UnknownMessage | null): void {
  if (!message) return;
  switch (message.type) {
    case 'breakpoints':
      control?.breakpoints(message.places);
      return;
    case 'control':
      // A pause that reaches a stopped worker has nothing to do.
      if (message.action === 'pause') {
        if (!held) control?.pause();
      } else if (held?.stop === message.stop) held.answer(message.action);
      return;
    case 'run-to':
      if (held?.stop !== message.stop) return;
      control?.runTo(message.place);
      held.answer('resume');
      return;
    case 'request': {
      const { request } = message;
      const at = message.what !== 'image' && held?.stop === message.stop ? held : null;
      switch (message.what) {
        case 'image':
          void imageOf(held?.page ?? null).then((value) => tellHub({ type: 'answer', request, what: 'image', value }));
          return;
        case 'requests': {
          const requests = at ? keptRequests() : [];
          const said = !at
            ? WENT_ON
            : requests.length
              ? `The test kept ${requests.length === 1 ? '1 response' : `${requests.length} responses`}.`
              : 'The test kept no response yet: Piwi keeps the text answers of its fetch and XHR requests.';
          tellHub({ type: 'answer', request, what: 'requests', value: { ok: !!at, message: said, requests } });
          return;
        }
        case 'mock': {
          void (at ? keptResponse(message.id) : Promise.resolve({ refusal: WENT_ON })).then((found) => {
            const value =
              'refusal' in found
                ? { ok: false, message: found.refusal, response: null }
                : { ok: true, message: `${found.method} ${found.url}`, response: found };
            tellHub({ type: 'answer', request, what: 'mock', value });
          });
          return;
        }
        case 'locator': {
          const counted: Promise<LocatorAnswer> = at
            ? counting.then(() =>
                held === at ? countLocator(at, message.locator) : { ok: false, message: WENT_ON, count: null },
              )
            : Promise.resolve({ ok: false, message: WENT_ON, count: null });
          counting = counted.catch(() => undefined);
          void counted.then((value) => tellHub({ type: 'answer', request, what: 'locator', value }));
          return;
        }
        case 'view': {
          const on = message.on;
          const answered = viewTurn.then((): Promise<IntentAnswer> =>
            !at ? Promise.resolve({ ok: false, message: WENT_ON }) : on ? startView(at) : stopViewOf(at),
          );
          viewTurn = answered.catch(() => undefined);
          void answered.then((value) => tellHub({ type: 'answer', request, what: 'view', value }));
          return;
        }
        case 'input': {
          const played = at ? playInput(at, message.events) : Promise.resolve({ ok: false, message: WENT_ON });
          void played.then((value) => tellHub({ type: 'answer', request, what: 'input', value }));
          return;
        }
        case 'pick-at': {
          const picked = at
            ? pickAtStop(at, message.x, message.y)
            : Promise.resolve({ ok: false, message: WENT_ON, locator: null });
          void picked.then((value) => tellHub({ type: 'answer', request, what: 'pick-at', value }));
          return;
        }
        default: {
          const value = at ? at.intent(message.what) : { ok: false, message: WENT_ON };
          tellHub({ type: 'answer', request, what: message.what, value });
          return;
        }
      }
    }
    case 'unknown':
      tellHub({
        type: 'notice',
        message: `@piwitests/reporter ${getReporterVersion()} does not take the editor's ${message.what}: update it.`,
      });
  }
}

/**
 * An image of a stopped page, without the pause bar, with its viewport in CSS pixels (which `pick-at` names a point
 * in, whatever the image's size); null when there is no page or it cannot be taken.
 */
async function imageOf(page: Page | null): Promise<PausedImage | null> {
  if (!page || page.isClosed()) return null;
  try {
    const shot = await internalCall(page, () =>
      page.screenshot({ type: 'jpeg', quality: 60, style: BAR_HIDDEN, timeout: 5000 }),
    );
    const viewport = await viewportOf(page);
    return { mime: 'image/jpeg', data: shot.toString('base64'), ...viewport };
  } catch {
    return null;
  }
}
