import { test, expect, createOrder } from './fixtures';

test.describe('order detail', () => {
  let order: Awaited<ReturnType<typeof createOrder>>;

  test.beforeEach(async ({ page }, testInfo) => {
    order = await createOrder(page, `Suite ${testInfo.testId}`);
    await page.goto(`/orders/${order.id}`);
    await expect(page.getByRole('heading', { name: order.number })).toBeVisible();
  });

  test('shows the order', async ({ page }) => {
    await expect(page.locator('[data-field="customer"]')).toHaveText(order.customer);
    await expect(page.locator('[data-field="status"]')).toHaveText('pending');
    await expect(page.locator('[data-field="items"]')).toHaveText('3');
    await expect(page.locator('[data-field="total"]')).toHaveText('$148.50');
  });

  test('edits the customer and quantity', async ({ page, evidence }) => {
    await page.getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog', { name: `Edit ${order.number}` });
    await dialog.getByLabel('Customer').fill(`${order.customer} (renamed)`);
    await dialog.getByLabel('Quantity').fill('7');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText('Order updated');
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-field="customer"]')).toHaveText(`${order.customer} (renamed)`);
    await expect(page.locator('[data-field="items"]')).toHaveText('7');
    await evidence('edited order');
  });

  test('changes the status', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Status').selectOption('shipped');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('[data-field="status"]')).toHaveText('shipped');
  });

  test('refuses an empty customer', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Customer').fill('');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByText('Customer is required')).toBeVisible();
    await expect(dialog.getByLabel('Customer')).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog).toBeVisible();
  });

  test('cancels an edit', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Customer').fill('Not saved');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-field="customer"]')).toHaveText(order.customer);
  });

  test('deletes the order after confirmation', async ({ page }) => {
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog', { name: `Delete ${order.number}?` }).getByRole('button', { name: 'Delete order' }).click();
    await expect(page).toHaveURL(/\/orders\?/);
    await expect(page.getByRole('status')).toContainText(`Order ${order.number} deleted`);
    expect((await page.request.get(`/api/orders/${order.id}`)).status()).toBe(404);
  });

  test('keeps the order when deletion is cancelled', async ({ page }) => {
    await page.getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Keep order' }).click();
    await expect(dialog).toBeHidden();
    expect((await page.request.get(`/api/orders/${order.id}`)).status()).toBe(200);
  });
});

test('shows a not-found page for a missing order', async ({ page }) => {
  await page.goto('/orders/999999');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
