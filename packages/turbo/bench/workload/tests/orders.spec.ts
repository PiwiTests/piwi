import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

const rows = (page: Page) => page.locator('#orders tbody tr');
const column = (page: Page, index: number) => page.locator(`#orders tbody tr td:nth-child(${index})`);

async function settled(page: Page) {
  await expect(page.locator('#orders')).not.toHaveAttribute('aria-busy');
}

test.describe('orders', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/orders');
    await settled(page);
  });

  test('shows the first page of 25 orders', async ({ page }) => {
    await expect(rows(page)).toHaveCount(25);
    await expect(page.locator('#page-label')).toContainText('Page 1 of');
  });

  test('searches by customer', async ({ page }) => {
    await page.getByLabel('Search orders').fill('Globex');
    await expect(page).toHaveURL(/q=Globex/);
    await settled(page);
    expect(new Set(await column(page, 2).allTextContents())).toEqual(new Set(['Globex']));
  });

  test('finds an order by its number', async ({ page }) => {
    await page.getByLabel('Search orders').fill('SO-10042');
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'SO-10042' })).toBeVisible();
  });

  test('says when nothing matches', async ({ page }) => {
    await page.getByLabel('Search orders').fill('no such customer');
    await expect(page.getByText('No orders match these filters')).toBeVisible();
  });

  test('filters by status', async ({ page }) => {
    await page.getByLabel('Status').selectOption('cancelled');
    await expect(page).toHaveURL(/status=cancelled/);
    await settled(page);
    expect(new Set(await column(page, 3).allTextContents())).toEqual(new Set(['cancelled']));
  });

  test('combines search and status', async ({ page }) => {
    await page.getByLabel('Status').selectOption('delivered');
    await page.getByLabel('Search orders').fill('Acme');
    await expect(page).toHaveURL(/q=Acme.*status=delivered|status=delivered.*q=Acme/);
    await settled(page);
    expect(new Set(await column(page, 2).allTextContents())).toEqual(new Set(['Acme Corp']));
    expect(new Set(await column(page, 3).allTextContents())).toEqual(new Set(['delivered']));
  });

  test('sorts by total, lowest first', async ({ page }) => {
    await page.getByRole('button', { name: 'Total' }).click();
    await expect(page.locator('th[data-key="total"]')).toHaveAttribute('aria-sort', 'ascending');
    await settled(page);
    const totals = (await column(page, 5).allTextContents()).map((text) => Number(text.replace(/[$,]/g, '')));
    expect(totals).toEqual(totals.toSorted((a, b) => a - b));
  });

  test('sorts by customer, last first', async ({ page }) => {
    const header = page.getByRole('button', { name: 'Customer' });
    await header.click();
    await expect(page.locator('th[data-key="customer"]')).toHaveAttribute('aria-sort', 'ascending');
    await header.click();
    await expect(page.locator('th[data-key="customer"]')).toHaveAttribute('aria-sort', 'descending');
    await settled(page);
    await expect(column(page, 2).first()).toHaveText('Zorg Industries');
  });

  test('pages forward and back', async ({ page }) => {
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.locator('#page-label')).toContainText('Page 2 of');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.locator('#page-label')).toContainText('Page 3 of');
    await page.getByRole('button', { name: 'Previous' }).click();
    await expect(page.locator('#page-label')).toContainText('Page 2 of');
    await expect(page.getByRole('button', { name: 'Previous' })).toBeEnabled();
  });

  test('shows 50 rows a page', async ({ page }) => {
    await page.getByLabel('Rows').selectOption('50');
    await expect(rows(page)).toHaveCount(50);
  });

  test('shows every order in one table', async ({ page, evidence }) => {
    await page.getByLabel('Rows').selectOption('all');
    await expect(page.locator('#page-label')).toContainText('Page 1 of 1');
    const row = page.getByRole('row', { name: /SO-10900/ });
    await expect(row).toBeVisible();
    await expect(row.getByRole('cell').nth(2)).toHaveText(/pending|paid|shipped|delivered|cancelled/);
    await row.getByRole('link').click();
    await expect(page.getByRole('heading', { name: 'SO-10900' })).toBeVisible();
    await evidence('order SO-10900', { fullPage: false });
  });

  test('keeps the filters across a reload', async ({ page }) => {
    await page.goto('/orders?status=paid&q=Hooli');
    await settled(page);
    await page.reload();
    await expect(page.getByLabel('Status')).toHaveValue('paid');
    await expect(page.getByLabel('Search orders')).toHaveValue('Hooli');
    await settled(page);
    expect(new Set(await column(page, 3).allTextContents())).toEqual(new Set(['paid']));
  });

  test('opens an order from the table', async ({ page }) => {
    const link = rows(page).first().getByRole('link');
    const number = await link.textContent();
    await link.click();
    await expect(page.getByRole('heading', { name: number! })).toBeVisible();
    await expect(page.locator('[data-field="customer"]')).not.toBeEmpty();
  });

  test('prepares a CSV export', async ({ page, evidence }) => {
    await page.getByRole('button', { name: 'Export CSV' }).click();
    await expect(page.getByText('Preparing export…')).toBeVisible();
    const link = page.getByRole('link', { name: 'Download export' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', /\.csv$/);
    await evidence('export ready');
  });
});
