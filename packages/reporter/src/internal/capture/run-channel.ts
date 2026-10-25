import * as net from 'node:net';
import type { Page, WorkerInfo } from '@playwright/test';
import { lineReader, parseRecordChannel } from '@piwitests/core/ide-recorder';
import {
  RUN_CHANNEL_ENV,
  RUN_INTENTS,
  RUN_INTENT_NAMES,
  parseHubToRun,
  type HubToRun,
  type IntentAnswer,
  type PausedImage,
  type Place,
  type RunIntent,
  type RunToHub,
  type StopReason,
  type UnknownMessage,
} from '@piwitests/core/run-channel';
import { PIWI_ORIGIN_ENV } from '../config/env.js';
import { getReporterVersion } from '../support/reporter-version.js';
import type { PauseAnswer } from './pause-at.js';
import { internalCall } from './quiet-capture.js';

/**
 * The worker's run connection to the editor that started the run: the socket the run's environment names
 * (`PIWI_RUN_CHANNEL`, `@piwitests/core/run-channel`), opened once per worker before its first test and kept until
 * the worker ends. The worker says which test it runs and where it stops; the editor pauses it, answers its stops
 * (Step, Resume, Finish, Run to a line), changes the run's breakpoints, asks for an image of the stopped page, and
 * starts the pause bar's Pick a locator or Record here from outside the page (`takes` in its attach). A test never
 * waits on it but while stopped, and a connection that does not open, or closes, leaves the run as without it: a stop
 * no pause bar can answer then goes on at once.
 */

/** How long a worker waits for its run connection to open before its first test runs without it. */
const CONNECT_MS = 2000;

/** The pause bar, hidden in an image of the stopped page. */
const BAR_HIDDEN = '#__piwi-pause-bar { display: none !important; }';

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
 * The stop the editor can answer, while it holds: its page (none for a context without one), its answer, and what
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
  /** Whether the pause bar shows in `page`. */
  bar: boolean;
  page: Page | null;
  /** Start the bar's Pick a locator or Record here from outside the page; refused without it. */
  intent?(what: RunIntent): IntentAnswer;
}

let socket: net.Socket | null = null;
let control: RunControl | null = null;
let stops = 0;
let held: HeldStop | null = null;

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
    takes: [...RUN_INTENTS],
  });
  return true;
}

/**
 * Take the run's channel out of the worker's environment while a test runs, so a process the test starts (Playwright
 * run from a test) opens no connection on this run; returns what puts it back once the test ended. Playwright compares
 * a worker's environment as it stops with the one it started with, and hands what changed to the projects that depend
 * on its own: between tests, the channel is there. `PIWI_RECORD_CHANNEL` stays, for **Record here**.
 */
export function hideRunChannel(env: NodeJS.ProcessEnv = process.env): () => void {
  const value = env[RUN_CHANNEL_ENV];
  if (value === undefined) return () => {};
  delete env[RUN_CHANNEL_ENV];
  return () => {
    env[RUN_CHANNEL_ENV] = value;
  };
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
 * `release`, which tells it the stop ended, however it did.
 */
export function holdStop(stop: StopToHold, onAnswer: (answer: PauseAnswer) => void): { release(): void } {
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
        ? { ok: false, message: 'The test went on.' }
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
  });
  if (!runChannelOpen() && !stop.bar) holding.answer('resume');
  return {
    release: () => {
      answered = true;
      if (held === holding) held = null;
      tellHub({ type: 'running', stop: id });
    },
  };
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
      if (message.what !== 'image') {
        const value =
          held?.stop === message.stop ? held.intent(message.what) : { ok: false, message: 'The test went on.' };
        tellHub({ type: 'answer', request: message.request, what: message.what, value });
        return;
      }
      const page = held?.page ?? null;
      void imageOf(page).then((value) => tellHub({ type: 'answer', request: message.request, what: 'image', value }));
      return;
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
