// Experimental hooks into Playwright's server, which runs inside each test worker for a browser the worker launches:
//
//   fast screenshots  adds CDP's `optimizeForSpeed` to Chromium's `Page.captureScreenshot` for PNGs (same pixels,
//                     faster encoding, larger files)
//   retry intervals   replaces the backoff of Playwright's retry loop (assertions, waits, element resolution)
//   fail fast         ends a failing web-first assertion once nothing can change the page before its timeout
//   fast reset        when Playwright resets a reused context, clears the storage of the origins the test visited
//                     through CDP, so the reset has no origin to load, moves the mouse away only from a tab a
//                     pointer acted in, and leaves out the tab's second load of about:blank and its emulation
//                     updates when the test changed neither, left no clock or WebAuthn script, and the next test asks
//                     for the same context options
//   early injection   creates Playwright's injected script and utility script in the utility world of a tab's new
//                     document as soon as its context exists, while the document loads, instead of at its first call
//   fast traces       a trace that leaves out script bodies does not request them from the browser, and on Chromium
//                     a traced call returns while its DOM snapshots are taken
//   skip stability wait  pointer actions stop waiting for the element to keep still for two animation frames; the
//                     visible, enabled and hit-target checks stay
//   fast stack traces the worker's stack traces format the frames of Node and of node_modules without looking up a
//                     source map, and with other hooks on, an evaluation's race against its context's destruction
//                     captures no stack
//   keep static cache when Playwright resets a reused context, leaves its HTTP cache when the last test loaded
//                     nothing the browser could reuse without asking the server but static assets
//   screenshot matches  a screenshot assertion passes without decoding its first capture when that capture's bytes
//                     are the baseline's, or those of a capture that matched the same baseline with the same options
//
// They wrap private internals, so they install only on the Playwright versions they were tested with, check the shape
// of what they wrap, and throw instead of falling back when anything differs.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { defaultCacheRoot, privateFolder } from './cache-folder';
import { cacheVerdict } from './static-cache';
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
  /** Screenshot assertions in progress with no baseline to compare with: what they take becomes the baseline. */
  baselinesBeingWritten: 0,
  retryIntervals: undefined as number[] | undefined,
  failFast: false,
  skipStabilityWait: false,
  fastReset: false,
  keepStaticCache: false,
  /** What each reused context received since its last reset, which keepStaticCache judges at the next. */
  staticCacheResponses: new WeakMap<object, CacheWatch>(),
  screenshotMatches: false,
  earlyInjection: false,
  fastTraces: false,
  /** fastStackTraces' server part: an evaluation's race against its context's destruction captures no stack. */
  lightRaces: false,
  /** source-map-support's formatter, which fastStackTraces calls for the frames that may have a source map. */
  sourceMappedStackTrace: undefined as ((error: Error, stack: NodeJS.CallSite[]) => string) | undefined,
  /** Server pages seen in this process: zero after a page was created means the browser runs elsewhere. */
  pagesSeen: 0,
  /** The first internal that did not have the expected shape. */
  error: undefined as Error | undefined,
  frameHooked: false,
  sessionHooked: false,
  tracerHooked: false,
  injectedScriptHooked: false,
  raceHooked: false,
  counters: {
    optimizedScreenshots: 0,
    shortenedRetries: 0,
    failedFast: 0,
    skippedStabilityWaits: 0,
    fastResets: 0,
    skippedPointerResets: 0,
    screenshotMatches: 0,
    rememberedScreenshots: 0,
    keptCaches: 0,
    lightPageResets: 0,
    earlyInjections: 0,
    skippedScriptBodies: 0,
    deferredSnapshots: 0,
    lightRaces: 0,
  },
  elementHooked: false,
};

/** What a reused context received since its last reset, as keepStaticCache judges it. */
interface CacheWatch {
  responses: ServerPage[];
  /** Its requests that have not finished, or that failed once their response had arrived. */
  unfinished: Set<ServerPage>;
  /** On Chromium, by protocol id: the requests a tab's renderer announced, and those answered over the network. */
  announced: Set<string>;
  answered: Set<string>;
  /** A tab whose protocol session it cannot watch, where a response may come unannounced. */
  blind: boolean;
}

class IncompatibleError extends Error {
  constructor(message: string) {
    super(
      `@piwitests/turbo: ${message}. Turn the experimental hooks off (the \`experimental\` options, or a preset ` +
        'other than max) to run on stock Playwright.',
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
      'Set PIWI_TURBO_ALLOW_UNTESTED=1 to run them on it anyway',
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
  // Every page of the context: a popup or another tab can post to the page, or change what it shows.
  const frames: ServerPage[] = frame._page.browserContext.pages().flatMap((page: ServerPage) => page.frames());
  if (frames.some((each) => !(each._inflightRequests instanceof Set)))
    throw new IncompatibleError("Playwright's frames no longer keep their requests in flight in _inflightRequests");
  if (frames.some((each) => each._inflightRequests.size)) return false;
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

/** A screenshot assertion without a baseline writes what it takes as the baseline: in the stock encoding. */
function hookBaselines(Page: ServerPage): void {
  const expectScreenshot = Page.prototype.expectScreenshot as
    | ((progress: unknown, options: { expected?: unknown }) => Promise<unknown>)
    | undefined;
  if (typeof expectScreenshot !== 'function')
    throw new IncompatibleError("Playwright's server Page has no expectScreenshot()");
  Page.prototype.expectScreenshot = async function (
    this: ServerPage,
    progress: unknown,
    options: { expected?: unknown },
  ) {
    if (options?.expected) return expectScreenshot.call(this, progress, options);
    state.baselinesBeingWritten++;
    try {
      return await expectScreenshot.call(this, progress, options);
    } finally {
      state.baselinesBeingWritten--;
    }
  };
}

const sha1 = (data: Buffer | string) => createHash('sha1').update(data).digest('hex');

/**
 * The captures known to match a baseline, by a key of the baseline's bytes, the comparison's options and Playwright's
 * version: in memory, and in the cache folder when only this user can write to it.
 */
export const screenshotMatchStore = {
  /** The cache folder; `defaultCacheRoot()` unless set. */
  root: undefined as string | undefined,
  folder: undefined as string | null | undefined,
  known: new Map<string, Set<string>>(),
  /** Forgets what this process read, and keeps the store in `root` from now on. */
  reset(root?: string): void {
    this.root = root;
    this.folder = undefined;
    this.known.clear();
  },
  directory(): string | null {
    if (this.folder === undefined) {
      const root = this.root ?? defaultCacheRoot();
      this.folder = privateFolder(root) ? join(root, 'screenshot-matches') : null;
    }
    return this.folder;
  },
  hashes(key: string): Set<string> {
    let hashes = this.known.get(key);
    if (!hashes) {
      hashes = new Set();
      const folder = this.directory();
      try {
        if (folder) for (const hash of readFileSync(join(folder, key), 'utf8').split('\n')) if (hash) hashes.add(hash);
      } catch {}
      this.known.set(key, hashes);
    }
    return hashes;
  },
  add(key: string, hash: string): void {
    const hashes = this.hashes(key);
    if (hashes.has(hash)) return;
    hashes.add(hash);
    const folder = this.directory();
    try {
      if (folder) {
        mkdirSync(folder, { recursive: true });
        appendFileSync(join(folder, key), `${hash}\n`);
      }
    } catch {}
  },
};

type ScreenshotOptions = { expected?: Buffer; isNot?: boolean; locator?: { frame: ServerPage; selector: string } };

/** The key of a baseline and the options of its comparison; the options that are objects only shape the capture. */
function matchKey(version: string, options: ScreenshotOptions): string {
  const primitives = Object.entries(options)
    .filter(([, value]) => value === null || typeof value !== 'object')
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return sha1([version, sha1(options.expected!), JSON.stringify(primitives)].join('\0'));
}

/**
 * A screenshot assertion against a baseline takes its first capture here, as Playwright's own first attempt takes it,
 * and passes without decoding it when its bytes are the baseline's or those of a capture that matched the same
 * baseline with the same options before. Otherwise Playwright's comparison runs and receives that capture as its
 * first: a capture that passes there at the first attempt is remembered.
 */
function hookScreenshotMatches(Page: ServerPage, version: string): void {
  const expectScreenshot = Page.prototype.expectScreenshot as (
    progress: Progress,
    options: ScreenshotOptions,
  ) => Promise<unknown>;
  Page.prototype.expectScreenshot = async function (this: ServerPage, progress: Progress, options: ScreenshotOptions) {
    if (!state.screenshotMatches || !Buffer.isBuffer(options?.expected) || options.isNot)
      return expectScreenshot.call(this, progress, options);
    // The capture Playwright's first attempt takes: the element's, or the page's after the pre-action checks.
    const owner = options.locator ? options.locator.frame : this.screenshotter;
    const method = options.locator ? 'rafrafTimeoutScreenshotElementWithProgress' : 'screenshotPage';
    const capture = owner?.[method] as ((...args: unknown[]) => Promise<Buffer>) | undefined;
    if (typeof capture !== 'function') throw new IncompatibleError(`Playwright's screenshots have no ${method}()`);
    let first: Buffer | undefined;
    try {
      if (options.locator) first = await capture.call(owner, progress, options.locator.selector, 0, options);
      else {
        await this.performActionPreChecks(progress);
        first = await capture.call(owner, progress, options);
      }
    } catch {}
    const key = matchKey(version, options);
    const hash = first && sha1(first);
    if (first && hash && (first.equals(options.expected) || screenshotMatchStore.hashes(key).has(hash))) {
      state.counters.screenshotMatches++;
      return {};
    }
    // Playwright's comparison takes the capture above as its first, and its own after that.
    let captures = 0;
    owner[method] = async function (...args: unknown[]) {
      captures++;
      if (captures === 1 && first) return first;
      return capture.apply(owner, args);
    };
    try {
      const result = await expectScreenshot.call(this, progress, options);
      if (first && hash && captures === 1) {
        screenshotMatchStore.add(key, hash);
        state.counters.rememberedScreenshots++;
      }
      return result;
    } finally {
      delete owner[method];
    }
  };
}

type HeaderList = Array<{ name: string; value: string }>;

const headerMap = (list: HeaderList) => Object.fromEntries(list.map(({ name, value }) => [name.toLowerCase(), value]));

/** A promise, or `null` after a second: raw headers that never come count as unknown. */
const withinASecond = <T>(promise: Promise<T>) =>
  Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000))]);

/**
 * keepStaticCache: records the requests and responses of a reused context in Playwright's server, from now until each
 * reset judges them, so a response that arrives once its test has ended counts too, and a request still in flight at
 * the reset clears the cache.
 */
export function watchStaticCache(serverContext: ServerPage): void {
  if (state.staticCacheResponses.has(serverContext)) return;
  const received: CacheWatch = {
    responses: [],
    unfinished: new Set(),
    announced: new Set(),
    answered: new Set(),
    blind: false,
  };
  state.staticCacheResponses.set(serverContext, received);
  serverContext.on('request', (request: ServerPage) => received.unfinished.add(request));
  serverContext.on('response', (response: ServerPage) => received.responses.push(response));
  serverContext.on('requestfinished', (finished: { request?: ServerPage } | undefined) => {
    if (finished?.request) received.unfinished.delete(finished.request);
    else state.error ??= new IncompatibleError("Playwright's requestfinished event no longer carries its request");
  });
  // A request that failed with no response left nothing in the cache; one with a response may have.
  serverContext.on('requestfailed', (request: ServerPage) => {
    if (typeof request?._existingResponse !== 'function')
      state.error ??= new IncompatibleError("Playwright's server requests no longer have _existingResponse()");
    else if (!request._existingResponse()) received.unfinished.delete(request);
  });
  for (const page of serverContext.pages?.() ?? []) watchTabNetwork(page, received);
  serverContext.on('page', (page: ServerPage) => watchTabNetwork(page, received));
}

/**
 * A request a document makes while it is being replaced, as by the reset's navigation, is answered and cached by the
 * browser, but its renderer never announces it, so Playwright never reports it. On Chromium, a tab's protocol session
 * still carries the browser's own events of it; a tab without one leaves the context blind to such requests.
 */
function watchTabNetwork(page: ServerPage, received: CacheWatch): void {
  const session = page?.delegate?._mainFrameSession?._client;
  if (typeof session?.on !== 'function') {
    received.blind = true;
    return;
  }
  session.on('Network.requestWillBeSent', (event: { requestId?: string }) => {
    if (event?.requestId) received.announced.add(event.requestId);
  });
  session.on('Network.responseReceivedExtraInfo', (event: { requestId?: string }) => {
    if (event?.requestId) received.answered.add(event.requestId);
  });
}

/**
 * Whether the responses a context received since its last reset left nothing in the HTTP cache but static assets.
 * A response that may be static is judged again with its raw headers: the request's cookie and credentials, and the
 * cookie the response sets.
 */
async function onlyStaticAssets(responses: ServerPage[]): Promise<boolean> {
  for (const response of responses) {
    const request = response.request?.();
    if (
      typeof request?.method !== 'function' ||
      typeof request.internalRawRequestHeaders !== 'function' ||
      typeof response.headers !== 'function' ||
      typeof response.internalRawResponseHeaders !== 'function'
    )
      throw new IncompatibleError("Playwright's server responses no longer have the methods keepStaticCache reads");
    const verdict = cacheVerdict(request.method(), response.status(), headerMap(response.headers()));
    if (verdict === 'reusable') return false;
    if (verdict !== 'static') continue;
    const [raw, rawRequest] = await Promise.all([
      withinASecond(response.internalRawResponseHeaders() as Promise<HeaderList>),
      withinASecond(request.internalRawRequestHeaders() as Promise<HeaderList>),
    ]);
    if (!raw || !rawRequest) return false;
    const judged = cacheVerdict(request.method(), response.status(), headerMap(raw), headerMap(rawRequest));
    if (judged !== 'static' && judged !== 'revalidated') return false;
  }
  return true;
}

function hookContextReset(core: ServerPage): void {
  const proto = core.server?.BrowserContext?.prototype;
  const resetForReuse = proto?.resetForReuse as ((progress: unknown, params: unknown) => Promise<unknown>) | undefined;
  const setStorageState = proto?.setStorageState as
    | ((progress: unknown, storageState: unknown, mode: string) => Promise<unknown>)
    | undefined;
  if (typeof resetForReuse !== 'function' || typeof setStorageState !== 'function')
    throw new IncompatibleError("Playwright's server BrowserContext has no resetForReuse()/setStorageState()");
  if (!String(setStorageState).includes('this.clearCache()'))
    throw new IncompatibleError("Playwright's context reset no longer clears the HTTP cache through clearCache()");
  const setStorage = setStorageState;
  const reset = String(resetForReuse);
  const blank = reset.indexOf('gotoImpl(progress2, "about:blank", {})');
  const storage = reset.indexOf('setStorageState(progress2, this._options.storageState, "resetForReuse")');
  if (blank < 0 || storage < blank || !String(setStorageState).includes('this._origins'))
    throw new IncompatibleError("Playwright's context reset no longer runs the steps fastReset expects");
  // fastReset: whether the next test asks for the context options the last one had, which the tab's own reset applies
  // again otherwise, and whether the test left the clock's or WebAuthn's page scripts, which leave the context only after
  // its reset loaded about:blank, so that document still runs them (hookPageReset).
  proto.resetForReuse = function (this: ServerPage, progress: unknown, params: unknown) {
    if (state.fastReset) {
      const options = JSON.stringify(params ?? null);
      sameOptions.set(this, lastOptions.get(this) === options);
      lastOptions.set(this, options);
      pageScriptsLeft.set(this, pageScriptsInstalled(this));
    }
    return resetForReuse.call(this, progress, params);
  };
  // keepStaticCache: the reset leaves the HTTP cache of a context whose last test loaded static assets only.
  proto.setStorageState = async function (this: ServerPage, progress: unknown, storageState: unknown, mode: string) {
    restoringStorage++;
    try {
      const received = state.staticCacheResponses.get(this);
      if (mode !== 'resetForReuse' || !state.keepStaticCache || !received)
        return await resetStorage.call(this, progress, storageState, mode);
      // A request still in flight, one that failed after its response arrived, or one the browser answered without its
      // renderer announcing it, may have left anything in the cache.
      const unannounced = [...received.answered].some((id) => !received.announced.has(id));
      const keep =
        !received.blind &&
        !unannounced &&
        received.unfinished.size === 0 &&
        (await onlyStaticAssets(received.responses));
      received.responses.length = 0;
      received.unfinished.clear();
      received.announced.clear();
      received.answered.clear();
      if (!keep) return await resetStorage.call(this, progress, storageState, mode);
      this.clearCache = async () => {
        state.counters.keptCaches++;
      };
      try {
        return await resetStorage.call(this, progress, storageState, mode);
      } finally {
        delete this.clearCache;
      }
    } finally {
      restoringStorage--;
    }
  };
  // Playwright's reset restores the storage once the test's other pages are closed and its tab is on about:blank. The
  // storage of every origin the test visited, the tab's session storage included, is cleared here through CDP, so
  // Playwright loads only the configured storage state's origins. With no page left, Playwright opens one and loads
  // each origin to clear it, all but its Cache Storage, cleared after.
  async function resetStorage(this: ServerPage, progress: unknown, storageState: unknown, mode: string) {
    const origins = this._origins as Set<string> | undefined;
    if (mode !== 'resetForReuse' || !state.fastReset || !(origins instanceof Set))
      return setStorage.call(this, progress, storageState, mode);
    const visited = [...origins];
    const session = mainSession(this);
    if (session) {
      state.counters.fastResets++;
      for (const origin of visited)
        await session.send('Storage.clearDataForOrigin', { origin, storageTypes: CLEARED_STORAGE });
      origins.clear();
      return setStorage.call(this, progress, storageState, mode);
    }
    const result = await setStorage.call(this, progress, storageState, mode);
    const opened = mainSession(this);
    if (opened) {
      for (const origin of visited)
        await opened.send('Storage.clearDataForOrigin', { origin, storageTypes: 'cache_storage' });
    }
    return result;
  }
}

/** The context options each reused context was last reset with, as JSON. */
const lastOptions = new WeakMap<object, string>();
/** Whether each reused context's last reset asked for the options of the reset before it. */
const sameOptions = new WeakMap<object, boolean>();
/** Whether each reused context had the clock's or WebAuthn's page scripts when its last reset began. */
const pageScriptsLeft = new WeakMap<object, boolean>();

/** Whether the clock or the WebAuthn credentials of a server context have scripts installed in its pages. */
function pageScriptsInstalled(context: ServerPage): boolean {
  const clockScripts = context.clock?._initScripts;
  const credentials = context.credentials;
  const dispose = String(credentials?.dispose);
  if (!Array.isArray(clockScripts) || !dispose.includes('this._initScript') || !dispose.includes('this._binding'))
    throw new IncompatibleError(
      "Playwright's clock and WebAuthn credentials no longer keep their page scripts as read",
    );
  return clockScripts.length > 0 || !!credentials._initScript || !!credentials._binding;
}
/** Storage restores in progress: they load documents that run no action. */
let restoringStorage = 0;

/** Whether the test left the tab's own viewport, media and extra headers alone. */
function untouchedEmulation(page: ServerPage): boolean {
  const media = (page._emulatedMedia ?? {}) as Record<string, unknown>;
  return (
    page._emulatedSize === undefined &&
    page._extraHTTPHeaders === undefined &&
    Object.values(media).every((value) => value === undefined)
  );
}

/**
 * fastReset: the context's reset has just loaded about:blank in the tab, so the tab's own reset loads it again and
 * applies the context's viewport and media to it again only when the test changed them, left the clock's or WebAuthn's
 * scripts in that document, or the next test asks for other context options. Its mouse reset always runs.
 */
function hookPageReset(Page: ServerPage): void {
  const reset = Page.prototype.resetForReuse as ((progress: unknown) => Promise<void>) | undefined;
  const source = String(reset);
  if (
    typeof reset !== 'function' ||
    !source.includes('gotoImpl(progress2, "about:blank", {})') ||
    !source.includes('this.delegate.resetForReuse(progress2)') ||
    !['_emulatedSize', '_emulatedMedia', '_extraHTTPHeaders'].every((field) => source.includes(`this.${field} =`))
  ) {
    throw new IncompatibleError("Playwright's page reset no longer loads about:blank, then resets emulation and input");
  }
  Page.prototype.resetForReuse = function (this: ServerPage, progress: unknown) {
    if (
      state.fastReset &&
      isChromium(this) &&
      sameOptions.get(this.browserContext) &&
      pageScriptsLeft.get(this.browserContext) === false &&
      untouchedEmulation(this) &&
      this.mainFrame().url() === 'about:blank'
    ) {
      state.counters.lightPageResets++;
      return this.delegate.resetForReuse(progress);
    }
    return reset.call(this, progress);
  };
}

/** The selector registry each injected script created early was built with, until its first call. */
const earlyScripts = new WeakMap<object, string>();

/** The custom selector engines and test id attribute an injected script built in `context` now holds. */
function registryOf(context: ServerPage): string {
  const registry = context.frame._page.browserContext.selectors();
  return `${[...registry._engines.keys()].join(',')}\0${registry.testIdAttributeName()}`;
}

/**
 * Playwright builds the selector engines and test id attribute registered at that moment into an injected script, and
 * never updates it. An injected script created early whose registry changed before its first call is created again at
 * that call, as Playwright creates it.
 */
function hookInjectedScript(proto: ServerPage): void {
  const injectedScript = proto.injectedScript as (() => Promise<ServerPage>) | undefined;
  const source = String(injectedScript);
  if (
    typeof injectedScript !== 'function' ||
    !source.includes('selectorsRegistry._engines') ||
    !source.includes('selectorsRegistry.testIdAttributeName()') ||
    !source.includes('this._injectedScriptPromise')
  ) {
    throw new IncompatibleError("Playwright's injected script no longer reads the selector registry as it is created");
  }
  proto.injectedScript = function (this: ServerPage) {
    const built = earlyScripts.get(this);
    if (built !== undefined) {
      earlyScripts.delete(this);
      if (built !== registryOf(this)) {
        const stale = this._injectedScriptPromise as Promise<ServerPage> | undefined;
        this._injectedScriptPromise = undefined;
        stale?.then((handle) => handle.dispose()).catch(() => {});
      }
    }
    return injectedScript.call(this);
  };
  state.injectedScriptHooked = true;
}

/**
 * earlyInjection: the utility world of a tab's new document, where Playwright's actions and assertions run, gets its
 * injected script and utility script as soon as it exists, while the document loads, rather than at its first call.
 */
function hookEarlyInjection(proto: ServerPage): void {
  const contextCreated = proto.contextCreated as ((world: string, context: ServerPage) => void) | undefined;
  if (typeof contextCreated !== 'function') throw new IncompatibleError("Playwright's frame has no contextCreated()");
  proto.contextCreated = function (this: ServerPage, world: string, context: ServerPage) {
    contextCreated.call(this, world, context);
    if (!state.earlyInjection || world !== 'utility' || restoringStorage || this.url() === 'about:blank') return;
    if (this !== this._page?.mainFrame?.()) return;
    if (typeof context?.injectedScript !== 'function' || typeof context._utilityScript !== 'function') {
      state.error ??= new IncompatibleError("Playwright's execution context has no injectedScript()/_utilityScript()");
      return;
    }
    try {
      if (!state.injectedScriptHooked) hookInjectedScript(Object.getPrototypeOf(context));
    } catch (error) {
      state.error ??= error as Error;
      return;
    }
    state.counters.earlyInjections++;
    // A document replaced before they are created rejects them: its context is gone with it.
    context
      .injectedScript()
      .then(() => context._utilityScript())
      .catch(() => {});
    earlyScripts.set(context, registryOf(context));
  };
}

/**
 * fastStackTraces, with other hooks on: every evaluation in a page races its context's destruction, and the race
 * captures and formats a stack of the server's frames as it starts, in case it must clone the destruction's error with
 * it. The client gives a failed call the test's own frames, so the test's error reads the same without it; a trace
 * records the server's error with no internal frames. The race captures no stack instead.
 */
/** Whether Playwright shows its internal stack frames in the errors it gives (`PWDEBUGIMPL`, its own tests). */
export function internalFramesShown(): boolean {
  const utils = playwrightCore().load('playwright-core/lib/coreBundle').utils as
    | { showInternalStackFrames?: () => boolean; isUnderTest?: () => boolean }
    | undefined;
  if (typeof utils?.showInternalStackFrames !== 'function' || typeof utils.isUnderTest !== 'function')
    throw new IncompatibleError('playwright-core has no showInternalStackFrames()/isUnderTest()');
  return utils.showInternalStackFrames() || utils.isUnderTest();
}

function hookContextRaces(proto: ServerPage): void {
  const contextCreated = proto.contextCreated as ((world: string, context: ServerPage) => void) | undefined;
  if (typeof contextCreated !== 'function') throw new IncompatibleError("Playwright's frame has no contextCreated()");
  proto.contextCreated = function (this: ServerPage, world: string, context: ServerPage) {
    if (!state.raceHooked) {
      try {
        hookContextRace(context);
      } catch (error) {
        state.error ??= error as Error;
      }
    }
    return contextCreated.call(this, world, context);
  };
}

function hookContextRace(context: ServerPage): void {
  let owner = context && Object.getPrototypeOf(context);
  while (owner && !Object.prototype.hasOwnProperty.call(owner, 'raceAgainstContextDestroyed'))
    owner = Object.getPrototypeOf(owner);
  const race = owner?.raceAgainstContextDestroyed as ((promise: Promise<unknown>) => Promise<unknown>) | undefined;
  const scope = context?._contextDestroyedScope;
  const scopeRace = scope && Object.getPrototypeOf(scope)._race;
  const scopeSource = String(scopeRace);
  const capture = scopeSource.indexOf('new Error().stack');
  if (
    typeof race !== 'function' ||
    !String(race).includes('this._contextDestroyedScope.race(promise)') ||
    !String(Object.getPrototypeOf(scope).race).includes('return this._race(') ||
    typeof scopeRace !== 'function' ||
    capture < 0
  ) {
    throw new IncompatibleError(
      "Playwright's race against a destroyed context no longer captures its stack as it starts",
    );
  }
  // The stack is captured before the race's first await: everything the race runs until then runs at a limit of 0,
  // its stack capture and the promises it creates.
  if (scopeSource.slice(0, capture).includes('await '))
    throw new IncompatibleError("Playwright's race against a destroyed context awaits before it captures its stack");
  owner.raceAgainstContextDestroyed = function (this: ServerPage, promise: Promise<unknown>) {
    if (!state.lightRaces) return race.call(this, promise);
    state.counters.lightRaces++;
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try {
      return race.call(this, promise);
    } finally {
      Error.stackTraceLimit = limit;
    }
  };
  state.raceHooked = true;
}

const NO_BODY = Buffer.alloc(0);

/**
 * fastTraces: Playwright's trace recorder requests the body of every response, then leaves out those of scripts unless
 * the trace is live. A script's body is not requested. The override covers the recorder's own request alone, so
 * `response.body()` still reads the body.
 */
function hookTracer(page: ServerPage): void {
  hookSnapshots(page.browserContext?.tracing);
  const tracer = page.browserContext?.tracing?._harTracer;
  const proto = tracer && Object.getPrototypeOf(tracer);
  const finished = proto?._onRequestFinished as ((request: ServerPage, response: ServerPage) => unknown) | undefined;
  const source = String(finished);
  const bodyRequest = source.indexOf('response2.internalBody()');
  if (
    typeof finished !== 'function' ||
    bodyRequest < 0 ||
    !source.includes('this._options.omitScripts && request2.resourceType() === "script"')
  ) {
    throw new IncompatibleError(
      "Playwright's trace recorder no longer requests script bodies and then leaves them out",
    );
  }
  // Up to its body request the handler runs without awaiting, so the override is in place for that request only.
  if (source.slice(0, bodyRequest).includes('await '))
    throw new IncompatibleError("Playwright's trace recorder awaits before it requests a response body");
  proto._onRequestFinished = function (this: ServerPage, request: ServerPage, response: ServerPage) {
    if (!state.fastTraces || !response || !this._options?.omitScripts || request.resourceType() !== 'script')
      return finished.call(this, request, response);
    state.counters.skippedScriptBodies++;
    response.internalBody = () => Promise.resolve(NO_BODY);
    try {
      return finished.call(this, request, response);
    } finally {
      delete response.internalBody;
    }
  };
  state.tracerHooked = true;
}

/** At most this many DOM snapshots of a trace in flight: one more is taken the stock way, holding its call. */
const MAX_PENDING_SNAPSHOTS = 20;
/** How long a snapshot in flight holds the calls that wait for it, as long as Playwright waits for one. */
const SNAPSHOT_WAIT_MS = 3_000;
/**
 * The calls whose own before-snapshot may be left in flight. Each acts on its frame through that frame's protocol
 * session, after the snapshot's request, or sends input only after the snapshot Playwright awaits right before input
 * or a round trip to the page, so the page takes the snapshot first.
 */
const SNAPSHOT_FREE_CALLS = new Set([
  ...['Frame', 'ElementHandle'].flatMap((type) =>
    [
      'check',
      'click',
      'dblclick',
      'dispatchEvent',
      'evalOnSelector',
      'evalOnSelectorAll',
      'evaluateExpression',
      'evaluateExpressionHandle',
      'fill',
      'focus',
      'getAttribute',
      'hover',
      'innerHTML',
      'innerText',
      'inputValue',
      'isChecked',
      'isDisabled',
      'isEditable',
      'isEnabled',
      'isHidden',
      'isVisible',
      'press',
      'querySelector',
      'querySelectorAll',
      'selectOption',
      'setInputFiles',
      'tap',
      'textContent',
      'type',
      'uncheck',
      'waitForSelector',
    ].map((method) => `${type}.${method}`),
  ),
  'Frame.blur',
  'Frame.content',
  'Frame.expect',
  'Frame.queryCount',
  'Frame.waitForFunction',
  'Frame.waitForTimeout',
  'ElementHandle.boundingBox',
  'ElementHandle.scrollIntoViewIfNeeded',
  'ElementHandle.waitForElementState',
  'JSHandle.evaluateExpression',
  'JSHandle.evaluateExpressionHandle',
]);
/**
 * The calls that wait for the snapshots in flight before they start: those that reach the page outside the order of
 * its protocol session (navigation, closing, the page's own input, rendering, emulation, a CDP session the test
 * opened), and the trace's stop, which writes what the trace holds.
 */
const SNAPSHOT_BARRIER_CALLS = new Set([
  'Frame.goto',
  'Frame.dragAndDrop',
  'Frame.drop',
  'Page.reload',
  'Page.goBack',
  'Page.goForward',
  'Page.close',
  'Page.keyboardDown',
  'Page.keyboardUp',
  'Page.keyboardInsertText',
  'Page.keyboardType',
  'Page.keyboardPress',
  'Page.mouseMove',
  'Page.mouseDown',
  'Page.mouseUp',
  'Page.mouseClick',
  'Page.mouseWheel',
  'Page.touchscreenTap',
  'Page.screenshot',
  'Page.expectScreenshot',
  'ElementHandle.screenshot',
  'Page.setViewportSize',
  'Page.emulateMedia',
  'BrowserContext.close',
  'CDPSession.send',
  'Tracing.tracingStopChunk',
  'Tracing.tracingStop',
]);
/** The DOM snapshots in flight, per trace recorder; each leaves the set when taken, or after `SNAPSHOT_WAIT_MS`. */
const pendingSnapshots = new WeakMap<object, Set<Promise<void>>>();
/** The trace recorder prototypes hookSnapshots has wrapped. */
const snapshotsHooked = new WeakSet<object>();

/**
 * fastTraces, on Chromium: the DOM snapshot a trace takes after a call, and before a call in `SNAPSHOT_FREE_CALLS`, is
 * left in flight rather than awaited, when it is the only capture of that phase (no screen or aria snapshots, no
 * coverage). A call in `SNAPSHOT_BARRIER_CALLS` waits for the snapshots in flight first. The snapshot taken right
 * before an action's input is awaited as in stock.
 */
function hookSnapshots(tracing: ServerPage): void {
  const proto = tracing && Object.getPrototypeOf(tracing);
  if (proto && snapshotsHooked.has(proto)) return;
  const capture = proto?._captureSnapshot as
    | ((progress: ServerPage, sdkObject: ServerPage, phase: string) => Promise<void>)
    | undefined;
  const onBeforeCall = proto?.onBeforeCall as ((...args: unknown[]) => Promise<void>) | undefined;
  const captureSource = String(capture);
  if (
    typeof capture !== 'function' ||
    typeof onBeforeCall !== 'function' ||
    !String(onBeforeCall).includes('return this._captureSnapshot(progress2, sdkObject, "before")') ||
    !String(proto.onAfterCall).includes('return this._captureSnapshot(progress2, sdkObject, "after")') ||
    !String(proto.onBeforeInputAction).includes('return this._captureSnapshot(progress2, sdkObject, "action")') ||
    !captureSource.includes('this._snapshotter.captureSnapshot(page, progress2.metadata.id, phase') ||
    !captureSource.includes('const options = this._state?.options;') ||
    !captureSource.includes('options?.snapshotScreen') ||
    !captureSource.includes('options?.snapshotAria') ||
    !captureSource.includes('this._captureCoverage(') ||
    !String(proto._captureCoverage).includes('this._coverageRecorder')
  ) {
    throw new IncompatibleError(
      "Playwright's trace recorder no longer takes its DOM snapshots the way fastTraces expects",
    );
  }
  proto._captureSnapshot = function (this: ServerPage, progress: ServerPage, sdkObject: ServerPage, phase: string) {
    const { type, method } = progress.metadata ?? {};
    const options = this._state?.options;
    let pending = pendingSnapshots.get(this);
    if (
      !state.fastTraces ||
      (phase !== 'after' && !(phase === 'before' && SNAPSHOT_FREE_CALLS.has(`${type}.${method}`))) ||
      !isChromium(sdkObject.attribution?.page ?? {}) ||
      options?.snapshotScreen ||
      options?.snapshotAria ||
      this._coverageRecorder ||
      (pending?.size ?? 0) >= MAX_PENDING_SNAPSHOTS
    ) {
      return capture.call(this, progress, sdkObject, phase);
    }
    if (!pending) pendingSnapshots.set(this, (pending = new Set()));
    const snapshots = pending;
    state.counters.deferredSnapshots++;
    const snapshot = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SNAPSHOT_WAIT_MS);
      timer.unref();
      void capture
        .call(this, progress, sdkObject, phase)
        .catch(() => {})
        .then(() => {
          clearTimeout(timer);
          resolve();
        });
    });
    snapshots.add(snapshot);
    void snapshot.then(() => snapshots.delete(snapshot));
    return Promise.resolve();
  };
  proto.onBeforeCall = function (this: ServerPage, progress: ServerPage, ...rest: unknown[]) {
    const { type, method } = progress.metadata ?? {};
    const pending = pendingSnapshots.get(this);
    if (!pending?.size || !SNAPSHOT_BARRIER_CALLS.has(`${type}.${method}`))
      return onBeforeCall.call(this, progress, ...rest);
    return Promise.all(pending).then(() => onBeforeCall.call(this, progress, ...rest));
  };
  snapshotsHooked.add(proto);
}

/** The CDP session of a server context's first page, on Chromium. */
function mainSession(context: ServerPage): ServerPage {
  return context.pages?.()[0]?.delegate?._mainFrameSession?._client;
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
  hookEarlyInjection(proto);
  hookContextRaces(proto);
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
    if (
      state.fastScreenshots &&
      !state.baselinesBeingWritten &&
      method === 'Page.captureScreenshot' &&
      params?.format === 'png'
    ) {
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
 * Installs the hooks in this process. Each stays inert until its flag in `state` is set.
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
  hookPageReset(Page);
  hookBaselines(Page);
  hookScreenshotMatches(Page, version);
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
    if (!state.tracerHooked) hookTracer(page);
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
