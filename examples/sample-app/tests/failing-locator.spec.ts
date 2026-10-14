import { test, expect } from './fixtures';

// Seeds a passing locator snapshot for the button, so the dashboard has
// known-good capture data for this element.
test('clicks the load button (seeds a passing locator snapshot)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('load-items').click();
  await expect(page.locator('#items li')).toHaveCount(3);
});

// INTENTIONALLY FAILING: do not "fix" this test.
// The button's accessible name is "Load items", but the locator still targets
// the old label. It demonstrates what the fixtures capture on failure: the
// ARIA snapshot of the page, a fresh locator suggestion (as a Playwright
// annotation on the test), and the Alternative locators panel on the dashboard.
test('intentionally fails: the button label changed', async ({ page }) => {
  test.info().annotations.push({
    type: 'example',
    description:
      'This failure is intentional: it lights up the failure-time ARIA snapshot, the locator suggestion, and locator healing in the dashboard.',
  });
  await page.goto('/');
  // The button is now labeled "Load items": this locator no longer matches.
  await page.getByRole('button', { name: 'Load records' }).click({ timeout: 2000 });
});
