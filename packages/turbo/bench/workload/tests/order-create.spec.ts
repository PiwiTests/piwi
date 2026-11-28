import { test, expect } from './fixtures';

test.describe('new order', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/orders/new');
  });

  test('creates an order', async ({ page, evidence }, testInfo) => {
    const customer = `Created ${testInfo.testId}`;
    await page.getByLabel('Customer').fill(customer);
    await page.getByLabel('Email').fill('buyer@example.com');
    await page.getByLabel('Quantity').fill('4');
    await page.getByLabel('Notes').fill('Leave at the loading dock');
    await page.getByRole('button', { name: 'Create order' }).click();
    await expect(page.getByRole('status')).toContainText(/Order SO-\d+ created/);
    await expect(page.locator('[data-field="customer"]')).toHaveText(customer);
    await expect(page.locator('[data-field="notes"]')).toHaveText('Leave at the loading dock');
    await evidence('new order');

    await page.getByRole('link', { name: 'All orders' }).click();
    await page.getByLabel('Search orders').fill(customer);
    await expect(page.locator('#orders tbody tr')).toHaveCount(1);
  });

  test('explains every missing field', async ({ page }) => {
    await page.getByLabel('Quantity').fill('0');
    await page.getByRole('button', { name: 'Create order' }).click();
    await expect(page.getByText('Customer is required')).toBeVisible();
    await expect(page.getByText('Enter a valid email address')).toBeVisible();
    await expect(page.getByText('Quantity must be between 1 and 999')).toBeVisible();
  });

  test('refuses an invalid email', async ({ page }) => {
    await page.getByLabel('Customer').fill('Initech');
    await page.getByLabel('Email').fill('not-an-email');
    await page.getByRole('button', { name: 'Create order' }).click();
    await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Customer')).not.toHaveAttribute('aria-invalid');
  });

  test('cancels back to the orders', async ({ page }) => {
    await page.getByRole('link', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
  });
});
