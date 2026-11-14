// `test` with @piwitests/turbo's fixtures: request blocking, failure screenshots, instant animations, and
// the experimental hooks, each off until enabled in `use`.
import { test as base, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
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

export const test = base.extend<TurboOptions>({
  blockRequests: [[], { option: true }],
  failureScreenshots: [false, { option: true }],
  instantAnimations: [false, { option: true }],
  fastScreenshots: [false, { option: true }],
  retryIntervals: [undefined, { option: true }],
  failFast: [false, { option: true }],

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
      connectOptions,
      browserName,
    },
    use,
    testInfo,
  ) => {
    const intervals = validIntervals(retryIntervals);
    // Baselines keep stock encoding: a run that writes snapshots takes them without the fast PNG option.
    const updating = testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed';
    const fast = fastScreenshots && browserName === 'chromium' && !updating;
    const hooks = fast || !!intervals || failFast;
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
    try {
      if (failFast) await context.addInitScript(IDLE_TRACKER);
      for (const rule of blockRequests)
        await context.route(routeMatcher(rule), (route) => route.abort('blockedbyclient'));
      const speedUps = new Map<Page, Promise<void>>();
      if (instantAnimations && browserName === 'chromium')
        context.on('page', (page) => speedUps.set(page, speedUpAnimations(context, page)));
      if (hooks || (instantAnimations && browserName === 'chromium')) {
        // A page the test gets from newPage, the `page` fixture's included, is ready before the test uses it.
        const newPage = context.newPage.bind(context);
        context.newPage = async (...args) => {
          const page = await newPage(...args);
          if (hooks) assertHooksWork({ needsChromium: fast });
          await speedUps.get(page);
          return page;
        };
      }
      await use(context);
      await Promise.all(speedUps.values());
      if (failureScreenshots) await captureFailure(context, testInfo);
    } finally {
      state.fastScreenshots = false;
      state.retryIntervals = undefined;
      state.failFast = false;
    }
  },
});

export { expect };
export type { TurboOptions };
