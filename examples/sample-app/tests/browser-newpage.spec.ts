import { test, expect, BASE_URL } from './fixtures';

// Capture is wired at the browser level, so pages created straight from the
// worker-scoped `browser` fixture are captured too, with no `page` fixture.
test('captures pages created from the worker browser', async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto(`${BASE_URL}/`);
  await page.getByTestId('load-items').click();
  await expect(page.locator('#items li')).toHaveCount(3);
  await page.close();
});
