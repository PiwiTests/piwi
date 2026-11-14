import { test, expect } from '../../src/test';
import { state } from '../../src/hooks';

// Trace is a worker option, so tracing gets a file of its own.
test.use({ trace: 'on', differentialSnapshots: true });

test('replaces the snapshot script Playwright injects for traces', async ({ page }) => {
  expect(state.counters.differentialStreamers).toBeGreaterThan(0);
  await page.setContent('<p>traced</p>');
  const differential = await page.evaluate(() =>
    Object.keys(window).some(
      (key) =>
        key.startsWith('__playwright_snapshot_streamer_') &&
        typeof (window as unknown as Record<string, { _markChangesWithoutMutations?: unknown }>)[key]
          ._markChangesWithoutMutations === 'function',
    ),
  );
  expect(differential).toBe(true);
  await page.getByText('traced').click();
});
