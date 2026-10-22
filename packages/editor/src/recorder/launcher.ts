/**
 * The launcher: the child process the editor service forks for each recording session, in the folder of the
 * Playwright config. It opens a browser with the project's own Playwright (resolved from that folder at run time,
 * never bundled), loads the recorder's IDE bundle into every page with an init script, answers the recorder over the
 * binding it exposes (`host-state.ts`: the main frame of the first page it opens records, every other frame and page
 * is answered as outside a recording), and tells the service over the IPC channel what happens: the browser open,
 * each event captured, a tab or a popup opened, Stop pressed in the browser, the browser closed, or why it could not
 * record. It closes the browser and exits when the service asks it to stop or goes away. Bundled on its own as
 * `dist/piwi-recorder-launcher.cjs`.
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { Browser, BrowserContext, BrowserType, Page } from '@playwright/test';
import {
  IDE_DISPATCH_GLOBAL,
  IDE_PAUSED_MESSAGE,
  IDE_RECORDER_BINDING,
  type IdeRecorderPaused,
} from '@piwitests/core/ide-recorder';
import { RecorderHost } from './host-state.js';
import type { LaunchFailure, LaunchRequest, LauncherToService, ServiceToLauncher } from './ipc.js';
import { resolvePlaywrightLibrary } from './playwright.js';

interface Playwright {
  chromium: BrowserType;
  firefox: BrowserType;
  webkit: BrowserType;
  selectors?: { setTestIdAttribute(attribute: string): void };
}

/** How long closing the browser may take before the launcher exits anyway. */
const CLOSE_TIMEOUT_MS = 5_000;

/** What the person hears once for each tab or popup the application opens, where nothing is recorded. */
const NEW_TAB_NOTICE = 'A new tab opened: what you do there is not recorded yet. Record in the first tab.';

let browser: Browser | null = null;
/** The recording's host and the page it records, once the browser is open. */
let opened: { host: RecorderHost; page: Page } | null = null;
let started = false;
let stopping = false;

function send(message: LauncherToService): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send || !process.connected) return resolve();
    process.send(message, undefined, {}, () => resolve());
  });
}

/** Closes the browser, then exits. */
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(code), CLOSE_TIMEOUT_MS).unref();
  await browser?.close().catch(() => undefined);
  process.exit(code);
}

async function fail(reason: LaunchFailure, message: string): Promise<void> {
  if (stopping) return;
  await send({ type: 'failed', reason, message });
  await shutdown(1);
}

/** The project's Playwright, loaded from the config's folder; null when it is not installed there. */
function loadPlaywright(cwd: string): Playwright | null {
  const library = resolvePlaywrightLibrary(cwd);
  return library ? (createRequire(path.join(cwd, 'noop.js'))(library) as Playwright) : null;
}

/** The first line of a Playwright error, without the call it came from (`browserType.launch: `). */
function errorLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = (text.split('\n')[0] ?? '').replace(/^[\w.]+: /, '').trim();
  return /[.!?]$/.test(line) ? line.slice(0, -1) : line;
}

/** The person closing the last window of the browser, or a page crashing, ends the recording. */
function watch(context: BrowserContext, page: Page): void {
  page.on('close', () => {
    if (!stopping && context.pages().length === 0) void send({ type: 'closed' }).then(() => shutdown(0));
  });
  page.on('crash', () => void fail('crashed', 'The page crashed.'));
}

async function start(request: LaunchRequest): Promise<void> {
  const playwright = loadPlaywright(request.cwd);
  if (!playwright) {
    return fail('playwright-missing', `Playwright is not installed in ${request.cwd}: run npm install there.`);
  }
  if (request.testIdAttribute) playwright.selectors?.setTestIdAttribute(request.testIdAttribute);
  const browserType = playwright[request.browserName];
  try {
    browser = await browserType.launch(request.launchOptions as Parameters<BrowserType['launch']>[0]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = /Executable doesn't exist|distribution '[^']+' is not found/.test(message);
    return fail(missing ? 'browser-missing' : 'launch-failed', `The browser did not start: ${errorLine(error)}.`);
  }
  browser.on('disconnected', () => {
    if (!stopping) void send({ type: 'closed' }).then(() => shutdown(0));
  });
  let page: Page;
  /** The page whose main frame records; null until `newPage()` returns it. */
  let recording: Page | null = null;
  try {
    const context = await browser.newContext(request.contextOptions as Parameters<Browser['newContext']>[0]);
    const host = new RecorderHost({
      language: request.language,
      settings: request.settings,
      startedAt: request.startedAt,
      onEvent: (event) => void send({ type: 'event', event }),
      onStopped: () => void send({ type: 'stopped-in-browser' }),
      onPaused: (paused) => void send({ type: 'paused', paused }),
    });
    await context.exposeBinding(IDE_RECORDER_BINDING, (source, payload: unknown) =>
      recording && source.page === recording && source.frame === recording.mainFrame()
        ? host.handle(payload)
        : host.handleOutside(payload),
    );
    await context.addInitScript({ path: request.bundle });
    page = await context.newPage();
    recording = page;
    opened = { host, page };
    watch(context, page);
    // A tab or a popup the application opens: the recorder there is answered as outside the recording.
    context.on('page', (tab) => {
      watch(context, tab);
      void send({ type: 'notice', message: NEW_TAB_NOTICE });
    });
  } catch (error) {
    return fail('launch-failed', `The browser did not open: ${errorLine(error)}.`);
  }
  await send({ type: 'started' });
  if (request.startUrl === 'about:blank') return;
  try {
    await page.goto(request.startUrl, { waitUntil: 'commit' });
  } catch (error) {
    if (stopping) return;
    const reason = /net::ERR_[A-Z_]+/.exec(String(error))?.[0] ?? errorLine(error);
    await send({
      type: 'notice',
      message: `${request.startUrl} did not load (${reason}): start the application, then reload the page in the browser.`,
    });
  }
}

process.on('message', (message: ServiceToLauncher) => {
  if (message?.type === 'start' && !started) {
    started = true;
    start(message.request).catch((error) => fail('launch-failed', `The recording failed: ${errorLine(error)}.`));
  } else if (message?.type === 'pause' && opened) {
    // The recording keeps the state for the pages to come; the page on screen hears it at once.
    const { host, page } = opened;
    host.setPaused(message.paused);
    const notice: IdeRecorderPaused = { type: IDE_PAUSED_MESSAGE, paused: message.paused };
    page
      .evaluate(
        ([name, value]) => {
          const dispatch = (globalThis as unknown as Record<string, unknown>)[name];
          if (typeof dispatch === 'function') dispatch(value);
        },
        [IDE_DISPATCH_GLOBAL, notice] as const,
      )
      .catch(() => undefined);
  } else if (message?.type === 'stop') {
    void shutdown(0);
  }
});
process.on('disconnect', () => void shutdown(0));
process.on('uncaughtException', (error) => void fail('launch-failed', `The recording failed: ${errorLine(error)}.`));
process.on('unhandledRejection', (error) => void fail('launch-failed', `The recording failed: ${errorLine(error)}.`));
