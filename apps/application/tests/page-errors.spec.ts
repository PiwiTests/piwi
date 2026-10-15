import { test, expect } from './fixtures';
import { waitForHydration } from './utils';

// A link to an entity that does not exist answers 404 with the error page, inside
// the dashboard so the sidebar still leads elsewhere. The 403 for a project the
// viewer has no role on is covered in `tests/reporter-with-auth.spec.ts`, since
// authentication is off on this server.

const MISSING_ID = 2_000_000_000;

for (const { path, heading } of [
  { path: `/projects/${MISSING_ID}`, heading: 'Project not found' },
  { path: `/test-runs/${MISSING_ID}`, heading: 'Test run not found' },
  { path: `/test-cases/${MISSING_ID}`, heading: 'Test not found' },
  { path: `/test-run-cases/${MISSING_ID}`, heading: 'Execution not found' },
  { path: `/failure-clusters/${MISSING_ID}`, heading: 'Failure cluster not found' },
]) {
  test(`${path} answers 404 with the error page`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);

    const errorPage = page.locator('[data-shot="error-page"]');
    await expect(errorPage.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(errorPage).toContainText('It may have been deleted, or the link may be wrong.');
    await expect(page).toHaveTitle(`${heading} — Piwi Dashboard`);
  });
}

test('the error page leads back home', async ({ page }) => {
  await page.goto(`/test-runs/${MISSING_ID}`);
  await waitForHydration(page);

  await page.locator('[data-shot="error-page"]').getByRole('button', { name: 'Back to home' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('[data-shot="error-page"]')).toHaveCount(0);
});

test('the error page keeps the sidebar, and a client-side navigation shows it too', async ({ page }) => {
  await page.goto(`/test-runs/${MISSING_ID}`);
  await waitForHydration(page);

  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.locator('[data-shot="error-page"]')).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/test-runs/${MISSING_ID}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Test run not found' })).toBeVisible();
});
