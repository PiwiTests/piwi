// Experimental hooks into Playwright's server, which runs inside each test worker for a browser the worker launches:
//
//   fast screenshots  adds CDP's `optimizeForSpeed` to Chromium's `Page.captureScreenshot` for PNGs (same pixels,
//                     faster encoding, larger files)
//   retry intervals   replaces the backoff of Playwright's retry loop (assertions, waits, element resolution)
//   fail fast         ends a failing web-first assertion once nothing can change the page before its timeout
//   fast reset        when Playwright resets a reused context, clears the storage of the origins the test visited
//                     from the frames still on them and through CDP, so the reset has no origin to load
//   skip stability wait  pointer actions stop waiting for the element to keep still for two animation frames; the
//                     visible, enabled and hit-target checks stay
//
// Both wrap private internals, so they install only on the Playwright versions they were tested with, check the shape
// of what they wrap, and throw instead of falling back when anything differs.
import { createRequire } from 'node:module';
import { TESTED_VERSIONS } from './versions';

const STOCK_BACKOFF = '[20, 50, 100, 100, 500]';

/* eslint-disable @typescript-eslint/no-explicit-any -- Playwright's server classes have no public types. */
type ServerPage = any;
type Progress = { timeout?: number; log?: (message: string) => void };
type RetryAction = (...args: any[]) => Promise<unknown>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** What the hooks do in this process right now, and what they have done. */
export const state = {
  installed: false,
  fastScreenshots: false,
  retryIntervals: undefined as number[] | undefined,
  failFast: false,
  skipStabilityWait: false,
  fastReset: false,
  /** Server pages seen in this process: zero after a page was created means the browser runs elsewhere. */
  pagesSeen: 0,
  /** The first internal that did not have the expected shape. */
  error: undefined as Error | undefined,
  frameHooked: false,
  sessionHooked: false,
  counters: { optimizedScreenshots: 0, shortenedRetries: 0, failedFast: 0, skippedStabilityWaits: 0, fastResets: 0 },
  elementHooked: false,
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

/** Thrown inside the retry loop to end an assertion the page can no longer satisfy. */
class FailFastError extends Error {
  constructor() {
    super('@piwitests/turbo: nothing can change the page before the timeout');
    this.name = 'FailFastError';
  }
}

const IDLE_CHECK_MS = 250;

/** Whether nothing in `frame`'s page can change it within `remaining` milliseconds. */
async function pageIsIdle(frame: ServerPage, remaining: number): Promise<boolean> {
  const frames: ServerPage[] = frame._page.frames();
  if (frames.some((each) => each._inflightRequests?.size)) return false;
  const checks = frames.map(async (each) => {
    const context = await each.context('main');
    const injected = await context.injectedScript();
    return await injected.evaluate(
      (_: unknown, ms: number) =>
        (globalThis as { __piwiTurboIdle?: (ms: number) => boolean }).__piwiTurboIdle?.(ms) === true,
      remaining,
    );
  });
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), IDLE_CHECK_MS));
  try {
    return await Promise.race([Promise.all(checks).then((results) => results.every(Boolean)), timeout]);
  } catch {
    return false;
  }
}

function hookFailFast(proto: ServerPage): void {
  const { expect, _expectInternal: expectInternal, isNonRetriableError } = proto;
  if (
    typeof expect !== 'function' ||
    typeof expectInternal !== 'function' ||
    typeof isNonRetriableError !== 'function'
  ) {
    throw new IncompatibleError("Playwright's frame has no expect/_expectInternal/isNonRetriableError");
  }
  const source = String(expect);
  if (!source.includes('retryWithProgressAndBackoff') || !source.includes('_expectInternal')) {
    throw new IncompatibleError("Playwright's frame.expect no longer polls through _expectInternal");
  }
  const startedAt = new WeakMap<object, number>();
  const idleStreak = new WeakMap<object, number>();
  proto.expect = function (this: ServerPage, progress: Progress, ...rest: unknown[]) {
    startedAt.set(progress, Date.now());
    return expect.call(this, progress, ...rest);
  };
  proto._expectInternal = async function (
    this: ServerPage,
    progress: Progress,
    selector: unknown,
    options: { isNot: boolean },
    lastIntermediateResult: unknown,
    noAbort: boolean,
  ) {
    const result = await expectInternal.call(this, progress, selector, options, lastIntermediateResult, noAbort);
    if (!state.failFast || noAbort || result.matches !== options.isNot) return result;
    const started = startedAt.get(progress);
    const remaining = progress.timeout && started !== undefined ? started + progress.timeout - Date.now() : Infinity;
    if (!(await pageIsIdle(this, remaining))) {
      idleStreak.set(progress, 0);
      return result;
    }
    // Idle on two polls in a row: an event that was on its way has had a poll to land.
    const streak = (idleStreak.get(progress) ?? 0) + 1;
    idleStreak.set(progress, streak);
    if (streak < 2) return result;
    state.counters.failedFast++;
    (progress as { log?: (message: string) => void }).log?.(
      '  @piwitests/turbo: nothing can change the page before the timeout, failing now',
    );
    throw new FailFastError();
  };
  proto.isNonRetriableError = function (this: ServerPage, error: unknown) {
    return error instanceof FailFastError || isNonRetriableError.call(this, error);
  };
}

const CLEARED_STORAGE =
  'local_storage,indexeddb,cache_storage,service_workers,file_systems,websql,shared_storage,storage_buckets';

// Run in each frame of the page a reset leaves: clears the tab's session storage of the frame's origin, and drops what
// the page writes to storage until it is gone.
const SEAL_STORAGE = `(() => {
  try { sessionStorage.clear(); } catch {}
  Storage.prototype.setItem = function () {};
})()`;

/** False when a frame went away before its storage was sealed: Playwright's reset then clears its origin. */
async function sealStorage(frames: ServerPage[], progress: unknown): Promise<boolean> {
  try {
    for (const frame of frames) await frame.evaluateExpression(progress, SEAL_STORAGE, { world: 'main' });
    return true;
  } catch {
    return false;
  }
}

/** Contexts whose next storage reset clears their visited origins through CDP. */
const sealedContexts = new WeakSet<object>();

function hookContextReset(core: ServerPage): void {
  const proto = core.server?.BrowserContext?.prototype;
  const resetForReuse = proto?.resetForReuse as ((progress: unknown, params: unknown) => Promise<unknown>) | undefined;
  const setStorageState = proto?.setStorageState as
    | ((progress: unknown, storageState: unknown, mode: string) => Promise<unknown>)
    | undefined;
  if (typeof resetForReuse !== 'function' || typeof setStorageState !== 'function')
    throw new IncompatibleError("Playwright's server BrowserContext has no resetForReuse()/setStorageState()");
  const steps = [
    'gotoImpl(progress2, "about:blank", {})',
    'setStorageState(progress2, this._options.storageState, "resetForReuse")',
  ];
  if (
    !steps.every((step) => String(resetForReuse).includes(step)) ||
    !String(setStorageState).includes('this._origins')
  ) {
    throw new IncompatibleError("Playwright's context reset no longer runs the steps fastReset expects");
  }
  // Before Playwright's reset: the frames still on the visited origins clear their session storage, which belongs to
  // the tab, and stop writing to storage until the reset navigates them away.
  proto.resetForReuse = async function (this: ServerPage, progress: unknown, params: unknown) {
    sealedContexts.delete(this);
    const origins = this._origins as Set<string> | undefined;
    const page = this.pages?.()[0];
    if (state.fastReset && origins instanceof Set && page?.delegate?._mainFrameSession?._client) {
      const frames = page.frames() as ServerPage[];
      if (frames.some((frame) => typeof frame.origin !== 'function' || typeof frame.evaluateExpression !== 'function'))
        throw new IncompatibleError("Playwright's server frame has no origin()/evaluateExpression()");
      const kept = frames.filter((frame) => origins.has(frame.origin()));
      // An origin the test left has no frame to reach its session storage from: Playwright's reset loads it.
      const reachable = [...origins].every((origin) => kept.some((frame) => frame.origin() === origin));
      if (reachable && (await sealStorage(kept, progress))) sealedContexts.add(this);
    }
    return resetForReuse.call(this, progress, params);
  };
  // Playwright's reset restores the storage once no page of the test is left on a visited origin: the rest of their
  // storage is cleared through CDP, so only the configured storage state's origins are loaded.
  proto.setStorageState = async function (this: ServerPage, progress: unknown, storageState: unknown, mode: string) {
    const session = this.pages?.()[0]?.delegate?._mainFrameSession?._client;
    if (mode === 'resetForReuse' && sealedContexts.delete(this) && session) {
      state.counters.fastResets++;
      const origins = this._origins as Set<string>;
      for (const origin of origins)
        await session.send('Storage.clearDataForOrigin', { origin, storageTypes: CLEARED_STORAGE });
      origins.clear();
    }
    return setStorageState.call(this, progress, storageState, mode);
  };
}

function hookElementHandle(handle: ServerPage): void {
  const proto = Object.getPrototypeOf(handle);
  const evaluateInUtility = proto.evaluateInUtility as ((fn: unknown, arg: unknown) => Promise<unknown>) | undefined;
  if (typeof evaluateInUtility !== 'function' || typeof proto._performPointerAction !== 'function') {
    throw new IncompatibleError("Playwright's element handle has no evaluateInUtility/_performPointerAction");
  }
  if (!String(proto._performPointerAction).includes('checkElementStates(node, elementStates2')) {
    throw new IncompatibleError("Playwright's pointer action no longer checks its element states in one call");
  }
  proto.evaluateInUtility = function (this: ServerPage, fn: unknown, arg: unknown) {
    const states = (arg as { elementStates?: unknown } | undefined)?.elementStates;
    if (state.skipStabilityWait && Array.isArray(states) && states.includes('stable')) {
      state.counters.skippedStabilityWaits++;
      return evaluateInUtility.call(this, fn, {
        ...(arg as object),
        elementStates: states.filter((each) => each !== 'stable'),
      });
    }
    return evaluateInUtility.call(this, fn, arg);
  };
  state.elementHooked = true;
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
  hookFailFast(proto);
  const retryIfNotConnected = proto._retryWithProgressIfNotConnected as
    | ((progress: Progress, target: unknown, options: unknown, action: RetryAction) => Promise<unknown>)
    | undefined;
  if (typeof retryIfNotConnected !== 'function') {
    throw new IncompatibleError("Playwright's frame has no _retryWithProgressIfNotConnected");
  }
  // The element handle class is reached from the first action's handle.
  proto._retryWithProgressIfNotConnected = function (
    this: ServerPage,
    progress: Progress,
    target: unknown,
    options: unknown,
    action: RetryAction,
  ) {
    return retryIfNotConnected.call(
      this,
      progress,
      target,
      options,
      (inner: unknown, handle: unknown, ...rest: unknown[]) => {
        if (!state.elementHooked) {
          try {
            hookElementHandle(handle);
          } catch (error) {
            state.error ??= error as Error;
            if (state.skipStabilityWait) throw error;
          }
        }
        return action(inner, handle, ...rest);
      },
    );
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
  hookContextReset(core);
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
