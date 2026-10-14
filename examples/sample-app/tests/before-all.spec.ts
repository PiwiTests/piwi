import { test, expect, BASE_URL } from './fixtures';

let markerStatus = 0;

// Activity in beforeAll/afterAll is intentionally NOT captured: the marker
// request below must not appear in any test's network data on the dashboard.
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  const response = await page.goto(`${BASE_URL}/api/before-all-marker`);
  markerStatus = response?.status() ?? 0;
  await page.close();
});

test('beforeAll activity is not attributed to this test', async ({ page }) => {
  expect(markerStatus).toBe(200);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Piwi sample app' })).toBeVisible();
});
