// Experimental hooks into Playwright's server, which runs inside each test worker for a local browser:
//
//   fast screenshots  adds CDP's `optimizeForSpeed` to Chromium's `Page.captureScreenshot` for PNGs (same pixels,
//                     faster encoding, larger files)
//   retry intervals   replaces the backoff of Playwright's own retry loop (assertions, waits, element resolution)
//
// Both touch private internals, so they are installed only for Playwright versions this package was tested with, check
// the shape of what they patch, and throw instead of falling back when anything differs.
import { createRequire } from 'node:module';

/** The playwright-core versions these hooks were tested with. */
export const TESTED_VERSIONS = ['1.64.1'];

const STOCK_BACKOFF = '[20, 50, 100, 100, 500]';

/** What the hooks do in this process right now, and what they have done. */
export const state = {
  installed: false,
  fastScreenshots: false,
  retryIntervals: undefined,
  /** Server pages seen in this process: zero after a page was created means the browser runs elsewhere. */
  pagesSeen: 0,
  /** Set when a patched internal did not have the expected shape. */
  error: undefined,
  frameHooked: false,
  sessionHooked: false,
  counters: { optimizedScreenshots: 0, shortenedRetries: 0 },
};

class IncompatibleError extends Error {
  constructor(message) {
    super(`suitetune: ${message}. Turn the experimental hooks off (fastScreenshots, retryIntervals) to run on stock Playwright.`);
    this.name = 'SuitetuneIncompatibleError';
  }
}

/** Loads the playwright-core instance the installed @playwright/test runs on. */
function loadCore() {
  const fromHere = createRequire(import.meta.url);
  const fromTest = createRequire(fromHere.resolve('@playwright/test'));
  const fromPlaywright = createRequire(fromTest.resolve('playwright/package.json'));
  const version = fromPlaywright('playwright-core/package.json').version;
  return { version, core: fromPlaywright('playwright-core/lib/coreBundle') };
}

function hookFrame(frame) {
  const proto = Object.getPrototypeOf(frame);
  const original = proto.retryWithProgressAndBackoff;
  if (typeof original !== 'function' || typeof proto.retryWithProgressAndTimeouts !== 'function') {
    throw new IncompatibleError("Playwright's frame has no retryWithProgressAndBackoff/retryWithProgressAndTimeouts");
  }
  if (!original.toString().includes(STOCK_BACKOFF)) {
    throw new IncompatibleError(`Playwright's retry backoff is not ${STOCK_BACKOFF}`);
  }
  proto.retryWithProgressAndBackoff = function retryWithProgressAndBackoff(progress, action) {
    if (!state.retryIntervals) return original.call(this, progress, action);
    state.counters.shortenedRetries++;
    const intervals = [...state.retryIntervals];
    // Stock behavior: no interval longer than a fifth of the timeout.
    if (progress.timeout) {
      while (intervals.length > 1 && intervals[intervals.length - 1] > progress.timeout / 5) intervals.pop();
    }
    return this.retryWithProgressAndTimeouts(progress, intervals, action);
  };
  state.frameHooked = true;
}

function hookChromiumSession(page) {
  const delegate = page.delegate;
  const session = delegate?._mainFrameSession?._client;
  if (!session) throw new IncompatibleError("Chromium's page has no main frame CDP session");
  if (!delegate.takeScreenshot?.toString().includes('"Page.captureScreenshot"')) {
    throw new IncompatibleError("Chromium's screenshot no longer calls Page.captureScreenshot");
  }
  const proto = Object.getPrototypeOf(session);
  const original = proto.send;
  if (typeof original !== 'function') throw new IncompatibleError("Chromium's CDP session has no send()");
  proto.send = function send(method, params) {
    if (state.fastScreenshots && method === 'Page.captureScreenshot' && params?.format === 'png') {
      state.counters.optimizedScreenshots++;
      return original.call(this, method, { ...params, optimizeForSpeed: true });
    }
    return original.call(this, method, params);
  };
  state.sessionHooked = true;
}

function isChromium(page) {
  return typeof page.delegate?._mainFrameSession === 'object';
}

/** Returns `intervals` when it is a usable retry backoff, throws otherwise. */
export function validIntervals(intervals) {
  if (intervals === undefined) return undefined;
  if (!Array.isArray(intervals) || !intervals.length || intervals.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error(`suitetune: retryIntervals must be a non-empty list of milliseconds, got ${JSON.stringify(intervals)}`);
  }
  return intervals;
}

/** Throws unless `version` is one the hooks were tested with, or `allowUntested`. */
export function checkVersion(version, allowUntested = false) {
  if (TESTED_VERSIONS.includes(version) || allowUntested) return;
  throw new IncompatibleError(
    `the experimental hooks are tested with playwright-core ${TESTED_VERSIONS.join(', ')}, and ${version} is installed. ` +
      'Run the compatibility tests and the benchmark with SUITETUNE_ALLOW_UNTESTED=1 before using this version',
  );
}

/**
 * Installs the hooks in this process. They stay inert until `state.fastScreenshots` or `state.retryIntervals` is set.
 * Throws when the installed Playwright is not a tested version, unless `allowUntested` (for compatibility testing).
 */
export function installHooks({ allowUntested = process.env.SUITETUNE_ALLOW_UNTESTED === '1' } = {}) {
  if (state.installed) return;
  const { version, core } = loadCore();
  checkVersion(version, allowUntested);
  const Page = core.server?.Page;
  if (typeof Page?.prototype?.reportAsNew !== 'function') throw new IncompatibleError("Playwright's server Page has no reportAsNew()");
  const reportAsNew = Page.prototype.reportAsNew;
  // Every new page passes through reportAsNew: the first one gives access to the classes to patch.
  Page.prototype.reportAsNew = function (...args) {
    state.pagesSeen++;
    try {
      if (!state.frameHooked) hookFrame(this.mainFrame());
      if (!state.sessionHooked && isChromium(this)) hookChromiumSession(this);
    } catch (error) {
      state.error ??= error;
    }
    return reportAsNew.apply(this, args);
  };
  state.installed = true;
}

/** Throws the first incompatibility a hook ran into, and checks that the browser runs in this process. */
export function assertHooksWork({ needsChromium }) {
  if (state.error) throw state.error;
  if (state.pagesSeen === 0) {
    throw new IncompatibleError('no page was created in the test worker, so the browser runs elsewhere (a remote or connected browser)');
  }
  if (needsChromium && !state.sessionHooked) {
    throw new IncompatibleError('fastScreenshots works on Chromium only');
  }
}
