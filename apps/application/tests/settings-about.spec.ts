import { test, expect } from './fixtures';
import { waitForHydration } from './utils';

/**
 * Settings → About: the build's relative time reads the browser's clock alone, so a browser whose clock is days
 * ahead of the server's still hydrates the page without a mismatch.
 */

test.describe('Settings → About', () => {
  test('the build time hydrates without a mismatch when the clocks disagree', async ({ page }) => {
    // Vue only reports mismatches in a dev build; in a production run this stays empty.
    const hydrationErrors: string[] = [];
    page.on('console', (msg) => {
      if (/Hydration (completed but contains mismatches|text content mismatch)/.test(msg.text())) {
        hydrationErrors.push(msg.text());
      }
    });
    await page.clock.install({ time: Date.now() + 3 * 24 * 60 * 60 * 1000 });

    await page.goto('/settings/about');
    await waitForHydration(page);

    await expect(page.getByText(/^Built \d+ days ago$/)).toBeVisible();
    expect(hydrationErrors).toEqual([]);
  });
});
