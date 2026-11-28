import { test, expect, createOrder } from './fixtures';

// Assertions that fail the way real regressions do: a wrong expectation after the page has settled. They run only with
// BENCH_FAILING=1, to measure what a red run costs.
test.describe('regressions', { tag: '@failing' }, () => {
  test('expects a heading the orders page no longer has', async ({ page }) => {
    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: 'Order history' })).toBeVisible();
  });

  test('expects 26 rows on the first page', async ({ page }) => {
    await page.goto('/orders');
    await expect(page.locator('#orders tbody tr')).toHaveCount(26);
  });

  test('expects a total the dashboard does not show', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.kpi', { hasText: 'Revenue' }).locator('strong')).toHaveText('$0.00');
  });

  test('expects the status an edit did not set', async ({ page }, testInfo) => {
    const order = await createOrder(page, `Regression ${testInfo.testId}`);
    await page.goto(`/orders/${order.id}`);
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('[data-field="status"]')).toHaveText('shipped');
  });

  test('expects a validation message the form does not give', async ({ page }) => {
    await page.goto('/orders/new');
    await page.getByRole('button', { name: 'Create order' }).click();
    await expect(page.getByText('Customer name is required')).toBeVisible();
  });

  test('expects an export link before asking for one', async ({ page }) => {
    await page.goto('/orders');
    await expect(page.getByRole('link', { name: 'Download export' })).toBeVisible();
  });
});
