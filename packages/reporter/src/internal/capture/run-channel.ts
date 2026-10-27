import * as net from 'node:net';
import type { Page, WorkerInfo } from '@playwright/test';
import { lineReader, parseRecordChannel } from '@piwitests/core/ide-recorder';
import {
  RUN_CHANNEL_ENV,
  RUN_HOLDS,
  RUN_INTENT_NAMES,
  RUN_TAKES,
  parseHubToRun,
  type HubToRun,
  type IntentAnswer,
  type LocatorAnswer,
  type PausedImage,
  type Place,
  type RunHold,
  type RunIntent,
  type RunToHub,
  type StopReason,
  type UnknownMessage,
} from '@piwitests/core/run-channel';
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
 * attach). Its attach also lists the stops it holds only once the editor says it shows them (`holds`: a failure), which
 * the editor answers with `attached`; an editor that predates it says nothing, and no failure is held for it. A test
 * never waits on it but while stopped, and a connection that does not open, or closes, leaves the run as without it:
 * a stop no pause bar can answer then goes on at once.
 */

/** How long a worker waits for its run connection to open before its first test runs without it. */
const CONNECT_MS = 2000;

/** The pause bar, hidden in an image of the stopped page. */
const BAR_HIDDEN = '#__piwi-pause-bar { display: none !important; }';

/** How the matches of the locator at the editor's caret are outlined in the stopped page. */
const OUTLINE_STYLE = 'outline: 2px dashed #a78bfa; outline-offset: 2px; background: rgba(167, 139, 250, 0.15);';

/** Why a request naming a stop that ended is refused. */
const WENT_ON = 'The test went on.';

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
  /** Start the bar's Pick a locator or Record here from outside the page; refused without it. */
  intent?(what: RunIntent): IntentAnswer;
}

let socket: net.Socket | null = null;
let control: RunControl | null = null;
/** The stops the editor said it shows, of those this worker holds only then (`attached`). */
let shown = new Set<RunHold>();
let stops = 0;
let held: HeldStop | null = null;
/** The outline of a locator's matches in a stopped page, and the stop it belongs to. */
let outline: { stop: number; remove(): Promise<void> } | null = null;
/**
 * The counts of locators asked, one after another (the editor asks one per move of its caret): each takes the outline
 * of the one before down before it draws its own, and the end of a stop waits for the last to take its outline down.
 */
let counting: Promise<unknown> = Promise.resolve();

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
  shown = new Set();
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
    holds: [...RUN_HOLDS],
  });
  return true;
}

/**
 * Whether the editor shows and answers a stop held for `what` (`attached`): a failure is held only for an editor that
 * said so, while the run connection is open.
 */
export function editorShows(what: RunHold): boolean {
  return runChannelOpen() && shown.has(what);
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
        : (stop.intent?.(what) ?? {
            ok: false,
            message: `${RUN_INTENT_NAMES[what]} needs the pause bar in the test's window, and this stop shows none: run the test headed.`,
          }),
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
      tellHub({ type: 'running', stop: id });
    },
  };
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
    case 'attached':
      shown = new Set(message.holds);
      return;
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

/** An image of a stopped page, without the pause bar; null when there is no page or it cannot be taken. */
async function imageOf(page: Page | null): Promise<PausedImage | null> {
  if (!page || page.isClosed()) return null;
  try {
    const shot = await internalCall(page, () =>
      page.screenshot({ type: 'jpeg', quality: 60, style: BAR_HIDDEN, timeout: 5000 }),
    );
    return { mime: 'image/jpeg', data: shot.toString('base64') };
  } catch {
    return null;
  }
}
