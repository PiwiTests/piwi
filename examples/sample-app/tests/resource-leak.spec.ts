import { test, expect, BASE_URL } from './fixtures';

// On purpose: this test opens a context of its own and never closes it. The run's summary and the dashboard's
// Resources tab list it as a leak, with this line, and with leakCheck: 'fail' the test would fail here.
test('leaves a context open (a resource leak, on purpose)', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/form`);
  await expect(page.getByRole('heading', { name: 'Contact form' })).toBeVisible();
});
