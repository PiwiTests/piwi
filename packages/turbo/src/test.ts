// `test` with @piwitests/turbo's fixtures: request blocking, failure screenshots, instant animations, and
// the experimental hooks, each off until enabled in `use`.
import {
  test as base,
  expect,
  type BrowserContext,
  type CDPSession,
  type Page,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
  type Request,
  type TestInfo,
  type TestType,
} from '@playwright/test';
import {
  assertHooksWork,
  hookExistingPage,
  installFastStackTraces,
  installHooks,
  state,
  validIntervals,
  watchStaticCache,
} from './hooks';
import { IDLE_TRACKER } from './idle-tracker';
import type { BlockRule, TurboOptions } from './types';

function routeMatcher(rule: BlockRule): string | RegExp | ((url: URL) => boolean) {
  return typeof rule === 'function' ? (url: URL) => rule(url) : rule;
}

/** The guid of a page or context, which stays the same across the tests of a reused context. */
function guidOf(object: Page | BrowserContext): string {
  return (object as unknown as { _guid: string })._guid;
}

/** Playwright's server object behind a context, which the hooks see. */
function serverContextOf(context: BrowserContext): object {
  const toImpl = (context as unknown as { _connection?: { toImpl?: (object: unknown) => object } })._connection?.toImpl;
  const server = toImpl?.(context);
  if (!server) throw new Error('@piwitests/turbo: keepStaticCache needs a browser launched by the test worker');
  return server;
}

/** The CDP sessions turbo opens and keeps: a test's own are detached as it ends. */
const ownSessions = new WeakSet<CDPSession>();

/** The tabs whose animations run faster, by guid: a reused context keeps its tab, and the tab its playback rate. */
const fastTabs = new Set<string>();

/**
 * Runs the page's document timeline 1000 times faster: CSS transitions and animations, and Web Animations. The rate
 * holds while the CDP session that set it stays attached, for the tab's life: across navigations and, on a reused
 * context, the next tests. The Animation domain stays disabled, so the session receives no events.
 */
async function speedUpAnimations(context: BrowserContext, page: Page): Promise<void> {
  if (fastTabs.has(guidOf(page))) return;
  try {
    const session = await context.newCDPSession(page);
    ownSessions.add(session);
    await session.send('Animation.setPlaybackRate', { playbackRate: 1000 });
    fastTabs.add(guidOf(page));
  } catch (error) {
    // A page the test already closed has nothing left to speed up.
    if (!page.isClosed()) throw error;
  }
}

type ContextSettings = {
  extraHTTPHeaders: Record<string, string> | undefined;
  permissions: string[] | undefined;
  geolocation: { latitude: number; longitude: number; accuracy?: number } | undefined;
  offline: boolean | undefined;
  httpCredentials: Parameters<BrowserContext['setHTTPCredentials']>[0] | undefined;
};

const SETTERS = [
  'setOffline',
  'setExtraHTTPHeaders',
  'grantPermissions',
  'clearPermissions',
  'setGeolocation',
  'setHTTPCredentials',
] as const;
type Setter = (typeof SETTERS)[number];

/** The settings a test changed on a reused context, recorded by wrapping the context's setters once. */
const changedSettings = new WeakMap<BrowserContext, Set<Setter>>();

function watchSettings(context: BrowserContext): Set<Setter> {
  let changed = changedSettings.get(context);
  if (changed) return changed;
  const watched = new Set<Setter>();
  changed = watched;
  changedSettings.set(context, watched);
  for (const name of SETTERS) {
    const original = (context[name] as (...args: unknown[]) => Promise<void>).bind(context);
    (context as unknown as Record<Setter, (...args: unknown[]) => Promise<void>>)[name] = (...args: unknown[]) => {
      watched.add(name);
      return original(...args);
    };
  }
  return changed;
}

/**
 * Puts back what Playwright's context reuse leaves from the previous test, only where the test changed it: offline
 * mode, extra HTTP headers, permissions, geolocation and HTTP credentials as configured.
 */
async function resetForNextTest(
  context: BrowserContext,
  settings: ContextSettings,
  changed: Set<Setter>,
): Promise<void> {
  const touched = new Set(changed);
  if (touched.has('setOffline')) await context.setOffline(settings.offline ?? false);
  if (touched.has('setExtraHTTPHeaders')) await context.setExtraHTTPHeaders(settings.extraHTTPHeaders ?? {});
  if (touched.has('grantPermissions') || touched.has('clearPermissions')) {
    await context.clearPermissions();
    if (settings.permissions?.length) await context.grantPermissions(settings.permissions);
  }
  if (touched.has('setGeolocation')) await context.setGeolocation(settings.geolocation ?? null);
  if (touched.has('setHTTPCredentials')) await context.setHTTPCredentials(settings.httpCredentials ?? null);
  // The resets above go through the watched setters too: the next test starts with nothing recorded.
  changed.clear();
}

/** The origins whose Cache Storage the last test of a reused context left, by context guid. */
const cachesLeft = new Map<string, Set<string>>();

/**
 * Clears the Cache Storage the last test left, which Playwright's reset keeps. It runs as the next test starts, after
 * that reset: no page of the last test can write to it any more, and its service workers are gone.
 */
async function clearCachesLeft(context: BrowserContext): Promise<void> {
  const origins = cachesLeft.get(guidOf(context));
  cachesLeft.delete(guidOf(context));
  if (!origins?.size) return;
  // In a reused context, the `page` fixture takes this page.
  const page = context.pages()[0] ?? (await context.newPage());
  const session = await context.newCDPSession(page);
  for (const origin of origins)
    await session.send('Storage.clearDataForOrigin', { origin, storageTypes: 'cache_storage' });
  await session.detach();
}

type Outcome = Pick<TestInfo, 'status' | 'expectedStatus' | 'attach'>;

type CaptureOptions = { fullPage?: boolean; omitBackground?: boolean };

/**
 * Attaches a screenshot of every open page of `context` and of the other contexts of its browser, which the test
 * opened, when the test failed, and does nothing when it passed.
 */
export async function captureFailure(
  context: BrowserContext,
  testInfo: Outcome,
  options: CaptureOptions = {},
): Promise<number> {
  if (testInfo.status === testInfo.expectedStatus) return 0;
  const contexts = [context, ...(context.browser()?.contexts() ?? []).filter((other) => other !== context)];
  let captured = 0;
  for (const open of contexts.flatMap((each) => each.pages())) {
    if (open.isClosed()) continue;
    const body = await open
      .screenshot({ timeout: 5000, fullPage: options.fullPage, omitBackground: options.omitBackground })
      .catch(() => undefined);
    if (!body) continue;
    await testInfo.attach('screenshot', { body, contentType: 'image/png' });
    captured++;
  }
  return captured;
}

type WorkerOptions =
  | 'reuseContextWithReset'
  | 'fastReset'
  | 'keepStaticCache'
  | 'fastStackTraces'
  | 'failureScreenshots';

function modeOf(setting: unknown): string | undefined {
  return typeof setting === 'object' && setting !== null ? (setting as { mode?: string }).mode : (setting as string);
}

/** The worker's failure capture, which the `screenshot` fixture sets up: none, or the options of its screenshots. */
let failureCapture: CaptureOptions | undefined;

/** `test` with turbo's options, typed from `@playwright/test` alone. */
export type TurboTest = TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & Omit<TurboOptions, WorkerOptions>,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions & Pick<TurboOptions, WorkerOptions>
>;

export const test: TurboTest = base.extend<
  Omit<TurboOptions, WorkerOptions>,
  Pick<TurboOptions, WorkerOptions> & { _turboStackTraces: void; _turboReused: boolean }
>({
  // turbo's `test` hands this option to Playwright's reuseContext, so its context is reused with the reset below.
  reuseContextWithReset: [false, { scope: 'worker', option: true }],
  fastReset: [false, { scope: 'worker', option: true }],
  keepStaticCache: [false, { scope: 'worker', option: true }],
  fastStackTraces: [false, { scope: 'worker', option: true }],
  // Installed once the worker has loaded the test files, after Playwright set up source-map-support.
  _turboStackTraces: [
    async ({ fastStackTraces }, use) => {
      if (fastStackTraces) installFastStackTraces();
      await use();
    },
    { scope: 'worker', auto: true },
  ],
  // Whether Playwright reuses the context, by its own rule: the option or PW_TEST_REUSE_CONTEXT, and no video.
  _turboReused: [
    async ({ reuseContextWithReset, video }, use) => {
      const requested = reuseContextWithReset || !!process.env.PW_TEST_REUSE_CONTEXT;
      await use(requested && (modeOf(video) ?? 'off') === 'off');
    },
    { scope: 'worker' },
  ],
  reuseContext: [
    async ({ reuseContextWithReset, _turboReused, fastReset, keepStaticCache, connectOptions }, use) => {
      // The reset of a reused context runs before each test's fixtures, so fastReset and keepStaticCache hold for the
      // whole worker.
      if (_turboReused && (fastReset || keepStaticCache)) {
        if (connectOptions || process.env.PW_TEST_CONNECT_WS_ENDPOINT) {
          throw new Error(
            '@piwitests/turbo: fastReset and keepStaticCache need a browser launched by the test worker, not a connected one',
          );
        }
        installHooks();
        state.fastReset = fastReset;
        state.keepStaticCache = keepStaticCache;
      }
      await use(reuseContextWithReset);
    },
    { scope: 'worker' },
  ],
  blockRequests: [[], { option: true }],
  failureScreenshots: [false, { scope: 'worker', option: true }],
  // turbo captures failed tests in place of Playwright's `only-on-failure`, which screenshots every test's pages and
  // keeps the failed ones: for the tests on this `test` only, so a spec on @playwright/test's keeps Playwright's.
  screenshot: [
    async ({ screenshot, failureScreenshots }, use) => {
      const mode = modeOf(screenshot);
      const options: CaptureOptions = typeof screenshot === 'object' && screenshot ? screenshot : {};
      failureCapture =
        failureScreenshots && mode !== 'on' && mode !== 'on-first-failure'
          ? { fullPage: options.fullPage, omitBackground: options.omitBackground }
          : undefined;
      await use(failureCapture && mode === 'only-on-failure' ? 'off' : screenshot);
    },
    { scope: 'worker' },
  ],
  instantAnimations: [false, { option: true }],
  fastScreenshots: [false, { option: true }],
  screenshotMatches: [false, { option: true }],
  retryIntervals: [undefined, { option: true }],
  failFast: [false, { option: true }],
  skipStabilityWait: [false, { option: true }],
  earlyInjection: [false, { option: true }],
  fastTraces: [false, { option: true }],

  // One fixture does everything, so a test pays for one extra fixture whatever the options. The hooks are on for this
  // test only: a worker runs one test at a time, so the setting covers every page of the test, including the ones it
  // opens itself, and no other test. Fast screenshots and instant animations apply to Chromium only.
  context: async (
    {
      context,
      blockRequests,
      screenshot,
      instantAnimations,
      fastScreenshots,
      screenshotMatches,
      retryIntervals,
      failFast,
      skipStabilityWait,
      earlyInjection,
      fastTraces,
      fastStackTraces,
      connectOptions,
      browserName,
      _turboReused: reused,
      fastReset,
      extraHTTPHeaders,
      permissions,
      geolocation,
      offline,
      httpCredentials,
    },
    use,
    testInfo,
  ) => {
    // Depending on `screenshot` sets the worker's failure capture up before this fixture runs.
    void screenshot;
    const intervals = validIntervals(retryIntervals);
    // Baselines keep stock encoding: a run that writes snapshots takes them without the fast PNG option.
    const updating = testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed';
    const fast = fastScreenshots && browserName === 'chromium' && !updating;
    const matches = screenshotMatches && !updating;
    const early = earlyInjection && browserName === 'chromium';
    // fastStackTraces' server part needs the browser in the worker, and is left out where internal frames are shown.
    const connected = !!(connectOptions || process.env.PW_TEST_CONNECT_WS_ENDPOINT);
    const lightRaces = fastStackTraces && !connected && !process.env.PWDEBUGIMPL;
    const hooks =
      fast ||
      matches ||
      !!intervals ||
      failFast ||
      skipStabilityWait ||
      early ||
      fastTraces ||
      lightRaces ||
      (reused && fastReset);
    if (hooks) {
      if (connected) {
        throw new Error(
          '@piwitests/turbo: the experimental hooks need a browser launched by the test worker, not a connected one',
        );
      }
      installHooks();
      // A reused context's tab may predate the hooks: they reach Playwright's classes through it.
      const pages = context.pages();
      for (const page of pages) hookExistingPage(page);
      if (pages.length) assertHooksWork({ needsChromium: fast });
    }
    state.fastScreenshots = fast;
    state.screenshotMatches = matches;
    state.retryIntervals = intervals;
    state.failFast = failFast;
    state.skipStabilityWait = skipStabilityWait;
    state.earlyInjection = early;
    state.fastTraces = fastTraces;
    state.lightRaces = lightRaces;
    try {
      if (failFast) await context.addInitScript(IDLE_TRACKER);
      for (const rule of blockRequests)
        await context.route(routeMatcher(rule), (route) => route.abort('blockedbyclient'));
      // A reused context comes back for the next test: whatever this test adds to it is removed when it ends.
      const listeners: Array<() => void> = [];
      // The origins whose Cache Storage the reset of a reused context keeps; fastReset clears it itself.
      const clearCaches = reused && browserName === 'chromium' && !fastReset;
      if (clearCaches) await clearCachesLeft(context);
      const speedUps = new Map<Page, Promise<void>>();
      // A reused context starts the test with the last test's tab, which the test gets without newPage. A tab an
      // earlier test sped up is closed for a test without instant animations, which gets a new one.
      for (const page of context.pages()) {
        if (instantAnimations || !fastTabs.delete(guidOf(page))) continue;
        await page.close();
      }
      if (instantAnimations && browserName === 'chromium') {
        const onPage = (page: Page) => speedUps.set(page, speedUpAnimations(context, page));
        for (const page of context.pages()) onPage(page);
        await Promise.all(speedUps.values());
        context.on('page', onPage);
        listeners.push(() => context.off('page', onPage));
      }
      if (hooks || (instantAnimations && browserName === 'chromium')) {
        // A page the test gets from newPage, the `page` fixture's included, is ready before the test uses it.
        const newPage = context.newPage;
        context.newPage = async (...args) => {
          const page = await newPage.apply(context, args);
          if (hooks) assertHooksWork({ needsChromium: fast });
          await speedUps.get(page);
          return page;
        };
        listeners.push(() => (context.newPage = newPage));
      }
      const changed = reused ? watchSettings(context) : new Set<Setter>();
      // A reused context keeps the CDP sessions a test opens, and what they set: they are detached as it ends.
      const sessions: CDPSession[] = [];
      if (reused) {
        const newCDPSession = context.newCDPSession;
        context.newCDPSession = async (...args) => {
          const session = await newCDPSession.apply(context, args);
          sessions.push(session);
          return session;
        };
        listeners.push(() => (context.newCDPSession = newCDPSession));
      }
      // keepStaticCache: the next reset judges what the reused context receives from here on.
      if (reused && state.keepStaticCache) watchStaticCache(serverContextOf(context));
      const origins = new Set<string>();
      if (clearCaches) {
        const onRequest = (request: Request) => {
          const { protocol, origin } = new URL(request.url());
          if (protocol === 'http:' || protocol === 'https:') origins.add(origin);
        };
        context.on('request', onRequest);
        listeners.push(() => context.off('request', onRequest));
      }
      try {
        await use(context);
        await Promise.all(speedUps.values());
        if (failureCapture) await captureFailure(context, testInfo, failureCapture);
      } finally {
        for (const remove of listeners) remove();
      }
      if (clearCaches) cachesLeft.set(guidOf(context), origins);
      if (reused) {
        for (const session of sessions) if (!ownSessions.has(session)) await session.detach().catch(() => {});
        await resetForNextTest(
          context,
          { extraHTTPHeaders, permissions, geolocation, offline, httpCredentials },
          changed,
        );
      }
    } finally {
      state.fastScreenshots = false;
      state.screenshotMatches = false;
      state.retryIntervals = undefined;
      state.failFast = false;
      state.skipStabilityWait = false;
      state.earlyInjection = false;
      state.fastTraces = false;
      state.lightRaces = false;
    }
  },
});

export { expect };
export type { TurboOptions };
