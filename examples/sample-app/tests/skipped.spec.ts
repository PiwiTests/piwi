import { test } from './fixtures';

// Skipped tests produce no capture attachments and no errors: they simply
// show up as skipped on the dashboard.
test.skip('skipped on purpose', async ({ page }) => {
  await page.goto('/');
});
