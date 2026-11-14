import { test, expect, signInViaApi } from './fixtures';

// Settings belong to the session: each test signs in with a session of its own so parallel tests never share one.
test.use({ signedIn: false, storageState: { cookies: [], origins: [] } });

test.describe('settings', () => {
  test.beforeEach(async ({ page }) => {
    await signInViaApi(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('saves the notification preferences', async ({ page }) => {
    await page.getByLabel('Weekly digest').check();
    await page.getByLabel('Email notifications').uncheck();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('status')).toContainText('Settings saved');
    await page.reload();
    await expect(page.getByLabel('Weekly digest')).toBeChecked();
    await expect(page.getByLabel('Email notifications')).not.toBeChecked();
  });

  test('changes the currency', async ({ page }) => {
    await page.getByLabel('Currency').selectOption('EUR');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('status')).toContainText('Settings saved');
    await page.reload();
    await expect(page.getByLabel('Currency')).toHaveValue('EUR');
  });
});
