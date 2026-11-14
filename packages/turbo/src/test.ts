// `test` with @piwitests/turbo's fixtures: request and resource blocking, failure screenshots, instant animations, and
// the experimental hooks, each off until enabled in `use`.
import { test as base, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { assertHooksWork, installHooks, state, validIntervals } from './hooks';
import { IDLE_TRACKER } from './idle-tracker';
import type { BlockRule, TurboOptions } from './types';

type HookSettings = { fastScreenshots: boolean; retryIntervals: number[] | undefined; failFast: boolean };

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

/** The animation speed-ups still being applied, per context: the `page` fixture waits for them before the test. */
const speedUps = new WeakMap<BrowserContext, Set<Promise<void>>>();

export const test = base.extend<TurboOptions & { _turboHooks: HookSettings }>({
  blockRequests: [[], { option: true }],
  blockResources: [[], { option: true }],
  failureScreenshots: [false, { option: true }],
  instantAnimations: [false, { option: true }],
  fastScreenshots: [false, { option: true }],
  retryIntervals: [undefined, { option: true }],
  failFast: [false, { option: true }],

  // Turns the hooks on for this test only. A worker runs one test at a time, so the setting covers every page of the
  // test, including the ones it opens itself, and no other test. Fast screenshots apply to Chromium only.
  _turboHooks: [
    async ({ fastScreenshots, retryIntervals, failFast, connectOptions, browserName }, use, testInfo) => {
      const intervals = validIntervals(retryIntervals);
      // Baselines keep stock encoding: a run that writes snapshots takes them without the fast PNG option.
      const updating = testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed';
      const fast = fastScreenshots && browserName === 'chromium' && !updating;
      if (fast || intervals || failFast) {
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
      try {
        await use({ fastScreenshots: fast, retryIntervals: intervals, failFast });
      } finally {
        state.fastScreenshots = false;
        state.retryIntervals = undefined;
        state.failFast = false;
      }
    },
    { auto: true },
  ],

  context: async ({ context, blockRequests, blockResources, instantAnimations, browserName, _turboHooks }, use) => {
    if (_turboHooks.failFast) await context.addInitScript(IDLE_TRACKER);
    for (const rule of blockRequests)
      await context.route(routeMatcher(rule), (route) => route.abort('blockedbyclient'));
    if (blockResources.length) {
      const types = new Set<string>(blockResources);
      await context.route('**/*', (route) =>
        types.has(route.request().resourceType()) ? route.abort('blockedbyclient') : route.fallback(),
      );
    }
    if (instantAnimations && browserName === 'chromium') {
      const pending = new Set<Promise<void>>();
      speedUps.set(context, pending);
      context.on('page', (page) => {
        const done = speedUpAnimations(context, page).finally(() => pending.delete(done));
        pending.add(done);
      });
      await use(context);
      await Promise.all(pending);
      return;
    }
    await use(context);
  },

  page: async ({ page, failureScreenshots, _turboHooks }, use, testInfo) => {
    if (_turboHooks.fastScreenshots || _turboHooks.retryIntervals || _turboHooks.failFast)
      assertHooksWork({ needsChromium: _turboHooks.fastScreenshots });
    await Promise.all(speedUps.get(page.context()) ?? []);
    await use(page);
    if (failureScreenshots) await captureFailure(page.context(), testInfo);
  },
});

export { expect };
export type { TurboOptions };
