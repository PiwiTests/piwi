// `test` with suitetune's fixtures: request blocking, and the experimental hooks, each off until enabled in `use`.
import { test as base, expect } from '@playwright/test';
import { assertHooksWork, installHooks, state, validIntervals } from './hooks.mjs';

function routeMatcher(rule) {
  if (typeof rule === 'function') return (url) => rule(url);
  return rule;
}

export const test = base.extend({
  blockRequests: [[], { option: true }],
  fastScreenshots: [false, { option: true }],
  retryIntervals: [undefined, { option: true }],

  // Turns the hooks on for this test only. A worker runs one test at a time, so the toggle covers every page of the
  // test, including the ones it opens itself, and no other test.
  _suitetuneHooks: [
    async ({ fastScreenshots, retryIntervals, connectOptions }, use, testInfo) => {
      const intervals = validIntervals(retryIntervals);
      // Baselines keep stock encoding: a run that writes snapshots takes them without the fast PNG option.
      const updating = ['all', 'changed'].includes(testInfo.config.updateSnapshots);
      const fast = fastScreenshots && !updating;
      if (fast || intervals) {
        if (connectOptions || process.env.PW_TEST_CONNECT_WS_ENDPOINT) {
          throw new Error('suitetune: the experimental hooks need a browser launched by the test worker, not a connected one');
        }
        installHooks();
      }
      state.fastScreenshots = fast;
      state.retryIntervals = intervals;
      try {
        await use({ fastScreenshots: fast, retryIntervals: intervals });
      } finally {
        state.fastScreenshots = false;
        state.retryIntervals = undefined;
      }
    },
    { auto: true },
  ],

  context: async ({ context, blockRequests, _suitetuneHooks }, use) => {
    void _suitetuneHooks;
    for (const rule of blockRequests) await context.route(routeMatcher(rule), (route) => route.abort('blockedbyclient'));
    await use(context);
  },

  page: async ({ page, _suitetuneHooks }, use) => {
    if (_suitetuneHooks.fastScreenshots || _suitetuneHooks.retryIntervals) {
      assertHooksWork({ needsChromium: _suitetuneHooks.fastScreenshots });
    }
    await use(page);
  },
});

export { expect };
