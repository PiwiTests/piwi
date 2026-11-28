import { state } from '../../src/hooks';
import { expect, test } from '../../src/test';
import { defineIsolationTests } from './reuse-isolation';

// The same pairs with fastReset, storage cleared without navigating, and keepStaticCache.
test.use({ reuseContextWithReset: true, fastReset: true, keepStaticCache: true });
defineIsolationTests(test);

test('resets through the fast path', async ({ page }) => {
  await page.goto('about:blank');
  expect(state.counters.fastResets).toBeGreaterThan(0);
  expect(state.counters.skippedPointerResets).toBeGreaterThan(0);
  expect(state.counters.lightPageResets).toBeGreaterThan(0);
  expect(state.counters.keptCaches).toBeGreaterThan(0);
});
