import { test, expect } from './fixtures';

// Popups (window.open) are instrumented as soon as the context reports them:
// the child window's console.warn and fetch call are captured.
test('captures activity inside a popup window', async ({ page }) => {
  await page.goto('/popup');
  const popupPromise = page.waitForEvent('popup');
  await page.getByTestId('open-child').click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await popup.getByTestId('child-action').click();
  await expect(popup.locator('#child-result')).toHaveText('child done');
});
