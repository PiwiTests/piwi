import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { openDevtoolsPage, selectElement } from './devtools-stub.js';
import { playwrightLocator } from './playwright-locator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');
const ORIGIN = 'http://piwi-devtools.test';

const SHOP = `<!doctype html><html><body>
  <main>
    <label>Coupon <input name="coupon"></label>
    <button class="btn">Apply coupon</button>
    <button class="btn">Show popup</button>
    <section aria-label="Offers"><button class="btn">Show popup</button></section>
  </main>
</body></html>`;

async function openShop(page: Page): Promise<void> {
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: SHOP }));
  await page.goto(`${ORIGIN}/cart`);
}

/**
 * The Elements sidebar (`devtools-sidebar.html`), opened as a tab with
 * `chrome.devtools` stubbed: the ranking content script runs in the shop
 * page's own world, where the stubbed `inspectedWindow.eval` evaluates.
 */
test.describe('the Elements sidebar', () => {
  test('ranks the node selected in DevTools, and its top locator finds it in Playwright', async ({
    context,
    extensionId,
  }) => {
    const shop = await context.newPage();
    await openShop(shop);
    await shop.addScriptTag({ path: path.join(DIST, 'devtools-rank.js') });
    const sidebar = await openDevtoolsPage(context, extensionId, 'devtools-sidebar.html', shop);
    await expect(sidebar.getByText('Select an element in the Elements panel')).toBeVisible();

    await selectElement(sidebar, shop, 'button:nth-of-type(1)');
    await expect(sidebar.getByRole('heading', { name: 'button · Apply coupon' })).toBeVisible();
    const first = sidebar.getByRole('listitem').first();
    await expect(first.locator('code')).toHaveText("getByRole('button', { name: 'Apply coupon' })");
    await expect(first).toContainText('unique · stable');
    // Every locator listed finds the selection with real Playwright.
    const locators = await sidebar.locator('li.locator code').allTextContents();
    expect(locators.length).toBeGreaterThan(1);
    await expect(playwrightLocator(shop, locators[0]!)).toHaveText('Apply coupon');

    // A name two buttons share is narrowed, and the narrowed locator holds in Playwright.
    await selectElement(sidebar, shop, 'section button');
    await expect(sidebar.getByRole('heading', { name: 'button · Show popup' })).toBeVisible();
    const top = (await sidebar.locator('li.locator code').first().textContent())!;
    expect(top).toContain('Offers');
    await expect(playwrightLocator(shop, top)).toHaveCount(1);
    await expect(sidebar.locator('li.locator').filter({ hasText: '2 matches' }).first()).toBeVisible();
  });

  test('copies a locator in each mode and adds it to the pick session', async ({ context, extensionId }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const shop = await context.newPage();
    await openShop(shop);
    await shop.addScriptTag({ path: path.join(DIST, 'devtools-rank.js') });
    const sidebar = await openDevtoolsPage(context, extensionId, 'devtools-sidebar.html', shop);
    await selectElement(sidebar, shop, 'button:nth-of-type(1)');
    const first = sidebar.getByRole('listitem').first();

    await first.getByRole('button', { name: 'Action' }).click();
    await expect(first.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await sidebar.evaluate(() => navigator.clipboard.readText())).toBe(
      "await page.getByRole('button', { name: 'Apply coupon' }).click();",
    );
    await first.getByRole('button', { name: 'Assertion' }).click();
    expect(await sidebar.evaluate(() => navigator.clipboard.readText())).toBe(
      "await expect(page.getByRole('button', { name: 'Apply coupon' })).toBeVisible();",
    );

    await first.getByRole('button', { name: 'Add to session' }).click();
    await first.getByRole('textbox', { name: 'Name for this element' }).fill('applyCoupon');
    await first.getByRole('button', { name: 'Save' }).click();
    await expect(first).toContainText('Added to the session as applyCoupon.');
    const picks = await sidebar.evaluate(
      async () => (await chrome.storage.session.get('piwiPickSession')).piwiPickSession,
    );
    expect(picks).toEqual([
      { name: 'applyCoupon', locator: "getByRole('button', { name: 'Apply coupon' })", pageUrl: `${ORIGIN}/cart` },
    ]);
  });

  test('asks for the site when the ranking script cannot be injected', async ({ context, extensionId }) => {
    const shop = await context.newPage();
    await openShop(shop);
    const sidebar = await openDevtoolsPage(context, extensionId, 'devtools-sidebar.html', shop, {
      contentScript: false,
    });
    await selectElement(sidebar, shop, 'button');
    await expect(sidebar.getByText(`Piwi Picker needs access to ${ORIGIN} to read this page.`)).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Allow on this site' })).toBeVisible();
  });
});
