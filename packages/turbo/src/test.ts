// `test` with @piwitests/turbo's fixtures: request blocking, failure screenshots, instant animations, and
// the experimental hooks, each off until enabled in `use`.
import { test as base, expect, type BrowserContext, type Page, type Request, type TestInfo } from '@playwright/test';
import { assertHooksWork, installHooks, state, validIntervals } from './hooks';
import { IDLE_TRACKER } from './idle-tracker';
import type { BlockRule, TurboOptions } from './types';

function routeMatcher(rule: BlockRule): string | RegExp | ((url: URL) => boolean) {
  return typeof rule === 'function' ? (url: URL) => rule(url) : rule;
}

/** Runs the page's document timeline 1000 times faster: CSS transitions and animations, and Web Animations. */
async function speedUpAnimations(context: BrowserContext, page: Page): Promise<void> {
  try {
    const session = await context.newCDPSession(page);
    await session.send('Animation.enable');
    await session.send('Animation.setPlaybackRate', { playbackRate: 1000 });
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
};

const SETTERS = [
  'setOffline',
  'setExtraHTTPHeaders',
  'grantPermissions',
  'clearPermissions',
  'setGeolocation',
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
 * mode, extra HTTP headers, permissions and geolocation as configured. Without fastReset, which clears it itself,
 * also clears the Cache Storage of every origin the test visited, on Chromium.
 */
async function resetForNextTest(
  context: BrowserContext,
  settings: ContextSettings,
  changed: Set<Setter>,
  origins: Set<string>,
  clearCaches: boolean,
): Promise<void> {
  const touched = new Set(changed);
  if (touched.has('setOffline')) await context.setOffline(settings.offline ?? false);
  if (touched.has('setExtraHTTPHeaders')) await context.setExtraHTTPHeaders(settings.extraHTTPHeaders ?? {});
  if (touched.has('grantPermissions') || touched.has('clearPermissions')) {
    await context.clearPermissions();
    if (settings.permissions?.length) await context.grantPermissions(settings.permissions);
  }
  if (touched.has('setGeolocation')) await context.setGeolocation(settings.geolocation ?? null);
  // The resets above go through the watched setters too: the next test starts with nothing recorded.
  changed.clear();
  const page = context.pages()[0];
  if (!clearCaches || !page || !origins.size) return;
  const session = await context.newCDPSession(page);
  for (const origin of origins)
    await session.send('Storage.clearDataForOrigin', { origin, storageTypes: 'cache_storage' });
  await session.detach();
}

type Outcome = Pick<TestInfo, 'status' | 'expectedStatus' | 'attach'>;

/** Attaches a screenshot of every open page of `context` when the test failed, and does nothing when it passed. */
export async function captureFailure(context: BrowserContext, testInfo: Outcome): Promise<number> {
  if (testInfo.status === testInfo.expectedStatus) return 0;
  let captured = 0;
  for (const open of context.pages()) {
    if (open.isClosed()) continue;
    const body = await open.screenshot({ timeout: 5000 }).catch(() => undefined);
    if (!body) continue;
    await testInfo.attach('screenshot', { body, contentType: 'image/png' });
    captured++;
  }
  return captured;
}

type WorkerOptions = 'reuseContextWithReset' | 'fastReset';

export const test = base.extend<Omit<TurboOptions, WorkerOptions>, Pick<TurboOptions, WorkerOptions>>({
  // Playwright reuses one context per worker only through this option, so a suite on plain @playwright/test never
  // reuses a context without the reset below.
  reuseContextWithReset: [false, { scope: 'worker', option: true }],
  fastReset: [false, { scope: 'worker', option: true }],
  reuseContext: [
    async ({ reuseContextWithReset, fastReset, connectOptions }, use) => {
      // The reset of a reused context runs before each test's fixtures, so fastReset holds for the whole worker.
      if (reuseContextWithReset && fastReset) {
        if (connectOptions || process.env.PW_TEST_CONNECT_WS_ENDPOINT) {
          throw new Error(
            '@piwitests/turbo: fastReset needs a browser launched by the test worker, not a connected one',
          );
        }
        installHooks();
        state.fastReset = true;
      }
      await use(reuseContextWithReset);
    },
    { scope: 'worker' },
  ],
  blockRequests: [[], { option: true }],
  failureScreenshots: [false, { option: true }],
  instantAnimations: [false, { option: true }],
  fastScreenshots: [false, { option: true }],
  retryIntervals: [undefined, { option: true }],
  failFast: [false, { option: true }],
  skipStabilityWait: [false, { option: true }],

  // One fixture does everything, so a test pays for one extra fixture whatever the options. The hooks are on for this
  // test only: a worker runs one test at a time, so the setting covers every page of the test, including the ones it
  // opens itself, and no other test. Fast screenshots and instant animations apply to Chromium only.
  context: async (
    {
      context,
      blockRequests,
      failureScreenshots,
      instantAnimations,
      fastScreenshots,
      retryIntervals,
      failFast,
      skipStabilityWait,
      connectOptions,
      browserName,
      reuseContextWithReset,
      fastReset,
      extraHTTPHeaders,
      permissions,
      geolocation,
      offline,
    },
    use,
    testInfo,
  ) => {
    const intervals = validIntervals(retryIntervals);
    // Baselines keep stock encoding: a run that writes snapshots takes them without the fast PNG option.
    const updating = testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed';
    const fast = fastScreenshots && browserName === 'chromium' && !updating;
    const hooks = fast || !!intervals || failFast || skipStabilityWait;
    if (hooks) {
      if (connectOptions || process.env.PW_TEST_CONNECT_WS_ENDPOINT) {
        throw new Error(
          '@piwitests/turbo: the experimental hooks need a browser launched by the test worker, not a connected one',
        );
      }
      installHooks();
    }
    state.fastScreenshots = fast;
    state.retryIntervals = intervals;
    state.failFast = failFast;
    state.skipStabilityWait = skipStabilityWait;
    try {
      if (failFast) await context.addInitScript(IDLE_TRACKER);
      for (const rule of blockRequests)
        await context.route(routeMatcher(rule), (route) => route.abort('blockedbyclient'));
      // A reused context comes back for the next test: whatever this test adds to it is removed when it ends.
      const listeners: Array<() => void> = [];
      const speedUps = new Map<Page, Promise<void>>();
      if (instantAnimations && browserName === 'chromium') {
        const onPage = (page: Page) => speedUps.set(page, speedUpAnimations(context, page));
        // A reused context starts the test with the last test's tab, which the test gets without newPage.
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
      const origins = new Set<string>();
      const changed = reuseContextWithReset ? watchSettings(context) : new Set<Setter>();
      if (reuseContextWithReset) {
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
        if (failureScreenshots) await captureFailure(context, testInfo);
      } finally {
        for (const remove of listeners) remove();
      }
      if (reuseContextWithReset) {
        await resetForNextTest(
          context,
          { extraHTTPHeaders, permissions, geolocation, offline },
          changed,
          origins,
          browserName === 'chromium' && !fastReset,
        );
      }
    } finally {
      state.fastScreenshots = false;
      state.retryIntervals = undefined;
      state.failFast = false;
      state.skipStabilityWait = false;
    }
  },
});

export { expect };
export type { TurboOptions };
