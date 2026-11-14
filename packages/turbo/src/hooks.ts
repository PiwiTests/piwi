// Experimental hooks into Playwright's server, which runs inside each test worker for a browser the worker launches:
//
//   fast screenshots  adds CDP's `optimizeForSpeed` to Chromium's `Page.captureScreenshot` for PNGs (same pixels,
//                     faster encoding, larger files)
//   retry intervals   replaces the backoff of Playwright's retry loop (assertions, waits, element resolution)
//   fail fast         ends a failing web-first assertion once nothing can change the page before its timeout; its idle
//                     tracker, an init script, stays in a reused context for its life
//   fast reset        when Playwright resets a reused context, clears the storage of the origins the test visited
//                     from the frames still on them and through CDP, so the reset has no origin to load, and moves
//                     the mouse away only from a tab a pointer acted in
//   skip stability wait  pointer actions stop waiting for the element to keep still for two animation frames; the
//                     visible, enabled and hit-target checks stay
//   fast stack traces the worker's stack traces format the frames of Node and of node_modules without looking up a
//                     source map
//
// They wrap private internals, so they install only on the Playwright versions they were tested with, check the shape
// of what they wrap, and throw instead of falling back when anything differs.
import { createRequire } from 'node:module';
import { IDLE_TRACKER } from './idle-tracker';
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
  /** source-map-support's formatter, which fastStackTraces calls for the frames that may have a source map. */
  sourceMappedStackTrace: undefined as ((error: Error, stack: NodeJS.CallSite[]) => string) | undefined,
  /** Server pages seen in this process: zero after a page was created means the browser runs elsewhere. */
  pagesSeen: 0,
  /** The first internal that did not have the expected shape. */
  error: undefined as Error | undefined,
  frameHooked: false,
  sessionHooked: false,
  counters: {
    optimizedScreenshots: 0,
    shortenedRetries: 0,
    failedFast: 0,
    skippedStabilityWaits: 0,
    fastResets: 0,
    skippedPointerResets: 0,
  },
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

/** Requires from the playwright-core instance the installed @playwright/test runs on. */
function playwrightCore(): { version: string; load: NodeJS.Require } {
  const fromTest = createRequire(require.resolve('@playwright/test'));
  const load = createRequire(fromTest.resolve('playwright/package.json'));
  return { version: (load('playwright-core/package.json') as { version: string }).version, load };
}

function loadCore(): { version: string; core: ServerPage } {
  const { version, load } = playwrightCore();
  return { version, core: load('playwright-core/lib/coreBundle') };
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

/** The idle tracker stays in the context it is added to for the context's life, across a reused context's tests. */
function hookIdleTracker(core: ServerPage): void {
  const proto = core.server?.BrowserContext?.prototype;
  const addInitScript = proto?.addInitScript as ((progress: unknown, source: string) => Promise<unknown>) | undefined;
  if (typeof addInitScript !== 'function')
    throw new IncompatibleError("Playwright's server BrowserContext has no addInitScript()");
  proto.addInitScript = async function (this: ServerPage, progress: unknown, source: string) {
    const script = (await addInitScript.call(this, progress, source)) as { dispose?: unknown };
    if (source !== IDLE_TRACKER) return script;
    if (typeof script?.dispose !== 'function')
      throw new IncompatibleError("Playwright's init scripts have no dispose()");
    // The reset of a reused context disposes what the test's client added: the tracker is kept.
    script.dispose = async () => {};
    return script;
  };
}

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
  // Playwright's reset restores the storage once no page of the test is left on a visited origin. Sealed, the rest
  // of their storage is cleared through CDP, so only the configured storage state's origins are loaded. Otherwise
  // Playwright loads each origin to clear its storage, all but Cache Storage, cleared here.
  proto.setStorageState = async function (this: ServerPage, progress: unknown, storageState: unknown, mode: string) {
    const sealed = sealedContexts.delete(this);
    const session = this.pages?.()[0]?.delegate?._mainFrameSession?._client;
    if (mode === 'resetForReuse' && state.fastReset && session) {
      const origins = this._origins as Set<string>;
      const storageTypes = sealed ? CLEARED_STORAGE : 'cache_storage';
      for (const origin of origins) await session.send('Storage.clearDataForOrigin', { origin, storageTypes });
      if (sealed) {
        state.counters.fastResets++;
        origins.clear();
      }
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
  hookPointerReset(delegate);
  state.sessionHooked = true;
}

/** The CDP clients of the Chromium tabs a pointer acted in since their last reset. */
const pointerUsed = new WeakSet<object>();

/** With fastReset, the reset of a tab no pointer acted in since its last one skips moving the mouse away. */
function hookPointerReset(delegate: ServerPage): void {
  const client = delegate._mainFrameSession._client;
  const mouse = delegate.rawMouse;
  const touchscreen = delegate.rawTouchscreen;
  if (mouse?._client !== client || touchscreen?._client !== client)
    throw new IncompatibleError("Chromium's raw mouse and touchscreen no longer use the page's CDP session");
  const reset = Object.getPrototypeOf(delegate).resetForReuse as ((progress: unknown) => Promise<void>) | undefined;
  const source = String(reset);
  if (!source.includes('this.rawMouse.move(progress2, -1, -1') || source.split('await ').length !== 2)
    throw new IncompatibleError("Chromium's page reset no longer only moves the mouse away");
  const inputs: Array<[object, string[]]> = [
    [Object.getPrototypeOf(mouse), ['move', 'down', 'up', 'wheel']],
    [Object.getPrototypeOf(touchscreen), ['tap']],
  ];
  for (const [proto, names] of inputs) {
    for (const name of names) {
      const original = (proto as Record<string, (...args: unknown[]) => unknown>)[name];
      if (typeof original !== 'function') throw new IncompatibleError(`Chromium's raw input has no ${name}()`);
      (proto as Record<string, unknown>)[name] = function (this: ServerPage, ...args: unknown[]) {
        pointerUsed.add(this._client);
        return original.apply(this, args);
      };
    }
  }
  Object.getPrototypeOf(delegate).resetForReuse = async function (this: ServerPage, progress: unknown) {
    const tab = this._mainFrameSession?._client;
    // The mouse was never over this tab's content since its last reset: no hover state to clear.
    if (state.fastReset && tab && !pointerUsed.has(tab)) {
      state.counters.skippedPointerResets++;
      return;
    }
    await reset!.call(this, progress);
    pointerUsed.delete(tab);
  };
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
  hookIdleTracker(core);
  const reportAsNew = Page.prototype.reportAsNew;
  // Every new page passes through reportAsNew: the first one gives access to the classes to wrap.
  Page.prototype.reportAsNew = function (this: ServerPage, ...args: unknown[]) {
    hookClassesOf(this);
    return reportAsNew.apply(this, args);
  };
  state.installed = true;
}

/** Wraps the frame class and, on Chromium, the CDP session class, reached through a server page. */
function hookClassesOf(page: ServerPage): void {
  state.pagesSeen++;
  try {
    if (!state.frameHooked) hookFrame(page.mainFrame());
    if (!state.sessionHooked && isChromium(page)) hookChromiumSession(page);
  } catch (error) {
    state.error ??= error as Error;
  }
}

/**
 * Hooks the classes through a page created before the hooks were installed, such as the tab a reused context keeps,
 * which never passes through reportAsNew again. Only a browser running in this process has a server page to reach.
 */
export function hookExistingPage(page: unknown): void {
  if (state.frameHooked && state.sessionHooked) return;
  const connection = (page as { _connection?: { toImpl?: (object: unknown) => ServerPage } })._connection;
  const server = connection?.toImpl?.(page);
  if (server) hookClassesOf(server);
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

const LIBRARY_FILE = /^node:|[\\/]node_modules[\\/]/;

type CallSitePosition = { name?: string } | null;
type WrapCallSite = (
  frame: NodeJS.CallSite,
  position: { nextPosition: CallSitePosition; curPosition: CallSitePosition },
) => NodeJS.CallSite;

/**
 * Formats this worker's stack traces as source-map-support does, without looking up a source map for the frames of
 * Node and of `node_modules`, which have none: Playwright captures a stack of 50 frames for every API call.
 */
export function installFastStackTraces({ allowUntested = process.env.PIWI_TURBO_ALLOW_UNTESTED === '1' } = {}): void {
  if (state.sourceMappedStackTrace) return;
  const { version, load } = playwrightCore();
  checkVersion(version, allowUntested);
  const sourceMapped = Error.prepareStackTrace;
  if (typeof sourceMapped !== 'function' || !String(sourceMapped).includes('wrapCallSite(stack[')) {
    throw new IncompatibleError("the worker's stack traces are not formatted by source-map-support");
  }
  const wrapCallSite = (load('playwright-core/lib/utilsBundle') as { sourceMapSupport?: { wrapCallSite?: unknown } })
    .sourceMapSupport?.wrapCallSite as WrapCallSite | undefined;
  if (typeof wrapCallSite !== 'function')
    throw new IncompatibleError('playwright-core has no sourceMapSupport.wrapCallSite');
  // source-map-support's own frame formatter, taken from a frame it wrapped.
  Error.prepareStackTrace = (_error, stack) => stack;
  const sample = (new Error().stack as unknown as NodeJS.CallSite[])[0];
  Error.prepareStackTrace = sourceMapped;
  const formatFrame = wrapCallSite(sample, { nextPosition: null, curPosition: null }).toString;
  if (formatFrame === Object.prototype.toString) {
    throw new IncompatibleError("source-map-support's wrapped frames no longer format themselves");
  }
  state.sourceMappedStackTrace = sourceMapped;
  // source-map-support's loop: a frame takes the name its caller's source map gives it, so such a frame is wrapped.
  Error.prepareStackTrace = (error: Error, stack: NodeJS.CallSite[]) => {
    const position = { nextPosition: null as CallSitePosition, curPosition: null as CallSitePosition };
    const lines: string[] = [];
    for (let i = stack.length - 1; i >= 0; i--) {
      const frame = stack[i];
      const file = frame.getFileName();
      if (file && LIBRARY_FILE.test(file) && !frame.isNative() && !frame.isEval() && !position.nextPosition?.name) {
        lines.push(`\n    at ${formatFrame.call(frame)}`);
        position.curPosition = null;
      } else {
        lines.push(`\n    at ${wrapCallSite(frame, position)}`);
      }
      position.nextPosition = position.curPosition;
    }
    return `${error?.name || 'Error'}: ${error?.message || ''}${lines.reverse().join('')}`;
  };
}
