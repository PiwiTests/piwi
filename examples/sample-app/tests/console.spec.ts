import { test, expect } from './fixtures';

// Console capture keeps warnings, errors, and failed asserts; console.log
// noise is intentionally not collected.
test('captures console warnings, errors and asserts (not logs)', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    console.log('demo: this log line is NOT captured');
    console.warn('demo: something looks off');
    console.error('demo: something went wrong');
    console.assert(false, 'demo: assertion failed');
  });
  await expect(page.getByRole('heading', { name: 'Piwi sample app' })).toBeVisible();
});
