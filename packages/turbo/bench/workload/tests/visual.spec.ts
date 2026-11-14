import { test, expect } from './fixtures';

// Seeded data only: the suite's own orders use other customer names, so these views stay the same between runs.
test.describe('visual', { tag: '@visual' }, () => {
  test('orders table', async ({ page }) => {
    await page.goto('/orders?q=Acme&status=delivered&sort=number&dir=asc');
    await expect(page.locator('#orders')).not.toHaveAttribute('aria-busy');
    await expect(page).toHaveScreenshot('orders-table.png', { fullPage: true });
  });

  test('order detail', async ({ page }) => {
    await page.goto('/orders/7');
    await expect(page.getByRole('heading', { name: 'SO-10007' })).toBeVisible();
    await expect(page).toHaveScreenshot('order-detail.png');
  });

  test('edit dialog', async ({ page }) => {
    await page.goto('/orders/7');
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('dialog')).toHaveScreenshot('edit-dialog.png');
  });

  test('dashboard', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('img', { name: 'Orders by status chart' })).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('#activity')).not.toHaveAttribute('aria-busy');
    await expect(page).toHaveScreenshot('dashboard.png', {
      mask: [page.locator('.kpi strong'), page.locator('#activity'), page.locator('#chart')],
    });
  });
});

test.describe('visual, signed out', { tag: '@visual' }, () => {
  test.use({ signedIn: false, storageState: { cookies: [], origins: [] } });

  test('sign-in page', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveScreenshot('sign-in.png');
  });
});
