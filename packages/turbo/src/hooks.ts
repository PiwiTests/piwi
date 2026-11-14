// Experimental hooks into Playwright's server, which runs inside each test worker for a browser the worker launches:
//
//   fast screenshots  adds CDP's `optimizeForSpeed` to Chromium's `Page.captureScreenshot` for PNGs (same pixels,
//                     faster encoding, larger files)
//   retry intervals   replaces the backoff of Playwright's retry loop (assertions, waits, element resolution)
//
// Both wrap private internals, so they install only on the Playwright versions they were tested with, check the shape
// of what they wrap, and throw instead of falling back when anything differs.
import { createRequire } from 'node:module';
import { TESTED_VERSIONS } from './versions';

const STOCK_BACKOFF = '[20, 50, 100, 100, 500]';

/* eslint-disable @typescript-eslint/no-explicit-any -- Playwright's server classes have no public types. */
type ServerPage = any;
type Progress = { timeout?: number };
type RetryAction = (...args: any[]) => Promise<unknown>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** What the hooks do in this process right now, and what they have done. */
export const state = {
  installed: false,
  fastScreenshots: false,
  retryIntervals: undefined as number[] | undefined,
  /** Server pages seen in this process: zero after a page was created means the browser runs elsewhere. */
  pagesSeen: 0,
  /** The first internal that did not have the expected shape. */
  error: undefined as Error | undefined,
  frameHooked: false,
  sessionHooked: false,
  counters: { optimizedScreenshots: 0, shortenedRetries: 0 },
};

class IncompatibleError extends Error {
  constructor(message: string) {
    super(
      `@piwitests/turbo: ${message}. Turn the experimental hooks off (fastScreenshots, retryIntervals) to run on stock Playwright.`,
    );
    this.name = 'TurboIncompatibleError';
  }
}

/** Returns `intervals` when it is a usable retry backoff, throws otherwise. */
export function validIntervals(intervals: unknown): number[] | undefined {
  if (intervals === undefined) return undefined;
  if (
    !Array.isArray(intervals) ||
    !intervals.length ||
    intervals.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
  ) {
    throw new Error(
      `@piwitests/turbo: retryIntervals must be a non-empty list of milliseconds, got ${JSON.stringify(intervals)}`,
    );
  }
  return intervals as number[];
}

/** Throws unless `version` is one the hooks were tested with, or `allowUntested`. */
export function checkVersion(version: string, allowUntested = false): void {
  if (TESTED_VERSIONS.includes(version) || allowUntested) return;
  throw new IncompatibleError(
    `the experimental hooks are tested with playwright-core ${TESTED_VERSIONS.join(', ')}, and ${version} is installed. ` +
      'Run the compatibility tests and the benchmark with PIWI_TURBO_ALLOW_UNTESTED=1 before using this version',
  );
}

/** Loads the playwright-core instance the installed @playwright/test runs on. */
function loadCore(): { version: string; core: ServerPage } {
  const fromTest = createRequire(require.resolve('@playwright/test'));
  const fromPlaywright = createRequire(fromTest.resolve('playwright/package.json'));
  const version = (fromPlaywright('playwright-core/package.json') as { version: string }).version;
  return { version, core: fromPlaywright('playwright-core/lib/coreBundle') };
}

function hookFrame(frame: ServerPage): void {
  const proto = Object.getPrototypeOf(frame);
  const original = proto.retryWithProgressAndBackoff as
    | ((progress: Progress, action: RetryAction) => Promise<unknown>)
    | undefined;
  if (typeof original !== 'function' || typeof proto.retryWithProgressAndTimeouts !== 'function') {
    throw new IncompatibleError("Playwright's frame has no retryWithProgressAndBackoff/retryWithProgressAndTimeouts");
  }
  if (!original.toString().includes(STOCK_BACKOFF))
    throw new IncompatibleError(`Playwright's retry backoff is not ${STOCK_BACKOFF}`);
  proto.retryWithProgressAndBackoff = function retryWithProgressAndBackoff(
    this: ServerPage,
    progress: Progress,
    action: RetryAction,
  ) {
    if (!state.retryIntervals) return original.call(this, progress, action);
    state.counters.shortenedRetries++;
    const intervals = [...state.retryIntervals];
    // As in stock Playwright: no interval longer than a fifth of the timeout.
    if (progress.timeout) {
      while (intervals.length > 1 && intervals[intervals.length - 1]! > progress.timeout / 5) intervals.pop();
    }
    return this.retryWithProgressAndTimeouts(progress, intervals, action);
  };
  state.frameHooked = true;
}

function hookChromiumSession(page: ServerPage): void {
  const delegate = page.delegate;
  const session = delegate?._mainFrameSession?._client;
  if (!session) throw new IncompatibleError("Chromium's page has no main frame CDP session");
  if (!String(delegate.takeScreenshot).includes('"Page.captureScreenshot"')) {
    throw new IncompatibleError("Chromium's screenshot no longer calls Page.captureScreenshot");
  }
  const proto = Object.getPrototypeOf(session);
  const original = proto.send as ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;
  if (typeof original !== 'function') throw new IncompatibleError("Chromium's CDP session has no send()");
  proto.send = function send(this: ServerPage, method: string, params?: Record<string, unknown>) {
    if (state.fastScreenshots && method === 'Page.captureScreenshot' && params?.format === 'png') {
      state.counters.optimizedScreenshots++;
      return original.call(this, method, { ...params, optimizeForSpeed: true });
    }
    return original.call(this, method, params);
  };
  state.sessionHooked = true;
}

function isChromium(page: ServerPage): boolean {
  return typeof page.delegate?._mainFrameSession === 'object';
}

/**
 * Installs the hooks in this process. They stay inert until `state.fastScreenshots` or `state.retryIntervals` is set.
 * Throws when the installed Playwright is not a tested version, unless `allowUntested` (for compatibility testing).
 */
export function installHooks({ allowUntested = process.env.PIWI_TURBO_ALLOW_UNTESTED === '1' } = {}): void {
  if (state.installed) return;
  const { version, core } = loadCore();
  checkVersion(version, allowUntested);
  const Page = core.server?.Page;
  if (typeof Page?.prototype?.reportAsNew !== 'function')
    throw new IncompatibleError("Playwright's server Page has no reportAsNew()");
  const reportAsNew = Page.prototype.reportAsNew;
  // Every new page passes through reportAsNew: the first one gives access to the classes to wrap.
  Page.prototype.reportAsNew = function (this: ServerPage, ...args: unknown[]) {
    state.pagesSeen++;
    try {
      if (!state.frameHooked) hookFrame(this.mainFrame());
      if (!state.sessionHooked && isChromium(this)) hookChromiumSession(this);
    } catch (error) {
      state.error ??= error as Error;
    }
    return reportAsNew.apply(this, args);
  };
  state.installed = true;
}

/** Throws the first incompatibility a hook ran into, and checks that the browser runs in this process. */
export function assertHooksWork({ needsChromium }: { needsChromium: boolean }): void {
  if (state.error) throw state.error;
  if (state.pagesSeen === 0) {
    throw new IncompatibleError(
      'no page was created in the test worker, so the browser runs elsewhere (a remote or connected browser)',
    );
  }
  if (needsChromium && !state.sessionHooked) throw new IncompatibleError('fastScreenshots works on Chromium only');
}
