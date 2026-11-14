import { test, expect } from './fixtures';

test.describe('dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('shows the key figures', async ({ page }) => {
    const figure = (label: string) => page.locator('.kpi', { hasText: label }).locator('strong');
    await expect(figure('Orders')).toHaveText(/^\d{1,3}(,\d{3})*$/);
    await expect(figure('Revenue')).toHaveText(/^\$[\d,]+\.\d{2}$/);
    await expect(figure('Average order')).toHaveText(/^\$/);
    await expect(figure('Pending')).toHaveText(/^\d+$/);
  });

  test('draws the orders-by-status chart', async ({ page }) => {
    await expect(page.getByRole('img', { name: 'Orders by status chart' })).toHaveAttribute('data-state', 'ready');
  });

  test('lists the eight latest events', async ({ page }) => {
    const activity = page.locator('#activity');
    await expect(activity).not.toHaveAttribute('aria-busy');
    await expect(activity.getByRole('listitem')).toHaveCount(8);
  });

  test('opens the orders from the main navigation', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Orders' }).click();
    await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
    await expect(page.locator('#orders tbody tr')).toHaveCount(25);
  });

  test('marks the current page in the navigation', async ({ page }) => {
    await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  });
});
