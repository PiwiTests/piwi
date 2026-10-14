import { test, expect } from './fixtures';

// The standard `page` fixture path: locator actions, a fetch call, and the
// console.warn the page emits on load are all captured automatically.
test('loads items from the API', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('load-items').click();
  await expect(page.locator('#items li').first()).toBeVisible();
  await expect(page.locator('#items li')).toHaveCount(3);
});
