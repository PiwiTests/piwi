import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { openDevtoolsPage } from './devtools-stub.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');
const ORIGIN = 'http://piwi-tools.test';

const SHOP = `<!doctype html><html><body><main>
  <button data-testid="apply-coupon">Apply coupon</button>
  <button id="first">Show popup</button>
  <section aria-label="Offers"><button id="second">Show popup</button></section>
  <div id="host"></div>
  <script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button id="wrap">Gift wrap</button>';</script>
</main></body></html>`;

/** The shop with the DevTools content script in its own world, and `inspect()` as DevTools' command line gives it. */
async function openShop(context: BrowserContext): Promise<Page> {
  const shop = await context.newPage();
  await shop.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: SHOP }));
  await shop.goto(`${ORIGIN}/cart`);
  await shop.addScriptTag({ path: path.join(DIST, 'devtools-rank.js') });
  await shop.evaluate(() => {
    (globalThis as { inspect?: (el: Element) => void }).inspect = (el) => {
      (globalThis as { __inspected?: string }).__inspected = el.id || el.localName;
    };
  });
  return shop;
}

test.describe('the Piwi panel’s Locators tab', () => {
  test('lists what a locator finds, outlines it on the page and reveals it in Elements', async ({
    context,
    extensionId,
  }) => {
    const shop = await openShop(context);
    const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop);
    await panel.getByRole('tab', { name: 'Locators' }).click();
    await expect(panel.getByText('Type a locator: the elements it finds')).toBeVisible();

    const input = panel.getByRole('textbox', { name: 'Locator to try' });
    await input.fill("getByRole('button', { name: 'Show popup' })");
    await expect(panel.getByRole('status')).toHaveText('2 elements: strict mode fails');
    const matches = panel.getByRole('list', { name: 'Elements found' }).getByRole('listitem');
    await expect(matches).toHaveText([/button · Show popup/, /button · Show popup/]);
    await expect(shop.getByRole('button', { name: 'Show popup' })).toHaveCount(2);

    await matches.nth(1).hover();
    await expect(shop.locator('#piwi-devtools-highlight')).toBeAttached();
    await matches.nth(1).getByRole('button', { name: 'Reveal' }).click();
    await expect.poll(() => shop.evaluate(() => (globalThis as { __inspected?: string }).__inspected)).toBe('second');
    await panel.mouse.move(0, 0);
    await expect(shop.locator('#piwi-devtools-highlight')).toHaveCount(0);

    await input.fill("getByTestId('apply-coupon')");
    await expect(panel.getByRole('status')).toHaveText('One element: strict mode passes');
    await input.fill("getByRole('button', {");
    await expect(panel.getByRole('status')).toContainText('The console can’t read this locator');
  });

  test('opened with a click, puts the caret in its field', async ({ context, extensionId }) => {
    const shop = await openShop(context);
    const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop);
    await panel.getByRole('tab', { name: 'Locators' }).click();
    const input = panel.getByRole('textbox', { name: 'Locator to try' });
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('placeholder', "getByLabel('Email')");
  });

  test('reveals an element inside an open shadow root', async ({ context, extensionId }) => {
    const shop = await openShop(context);
    const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop);
    await panel.getByRole('tab', { name: 'Locators' }).click();
    await panel.getByRole('textbox', { name: 'Locator to try' }).fill("getByRole('button', { name: 'Gift wrap' })");
    await expect(panel.getByRole('status')).toHaveText('One element: strict mode passes');
    const match = panel.getByRole('list', { name: 'Elements found' }).getByRole('listitem');
    await match.getByRole('button', { name: 'Reveal' }).click();
    await expect.poll(() => shop.evaluate(() => (globalThis as { __inspected?: string }).__inspected)).toBe('wrap');
    expect(await shop.evaluate(() => document.querySelector('#host')!.shadowRoot!.innerHTML)).not.toContain(
      'data-piwi-devtools-reveal',
    );
  });

  test('says so when the element to reveal has left the page', async ({ context, extensionId }) => {
    const shop = await openShop(context);
    const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop);
    await panel.getByRole('tab', { name: 'Locators' }).click();
    await panel.getByRole('textbox', { name: 'Locator to try' }).fill("getByTestId('apply-coupon')");
    const match = panel.getByRole('list', { name: 'Elements found' }).getByRole('listitem');
    await expect(match).toHaveCount(1);
    await shop.evaluate(() => document.querySelector('[data-testid="apply-coupon"]')!.remove());
    await match.getByRole('button', { name: 'Reveal' }).click();
    await expect(panel.getByText('This element could not be selected in the Elements panel')).toBeVisible();
    expect(await shop.evaluate(() => (globalThis as { __inspected?: string }).__inspected)).toBeUndefined();
  });
});

test.describe('the Piwi panel’s Session tab', () => {
  test('lists the named elements, copies them and removes them', async ({ context, extensionId }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const shop = await openShop(context);
    const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop);
    await panel.getByRole('tab', { name: 'Session' }).click();
    await expect(panel.getByText('No named element yet.')).toBeVisible();

    await panel.evaluate(() =>
      chrome.storage.session.set({
        piwiPickSession: [
          { name: 'applyCoupon', locator: "getByTestId('apply-coupon')", pageUrl: 'http://piwi-tools.test/cart' },
          {
            name: 'offersPopup',
            locator: "getByRole('region', { name: 'Offers' }).getByRole('button')",
            pageUrl: 'http://piwi-tools.test/cart',
          },
        ],
      }),
    );
    await expect(panel.getByRole('status')).toHaveText('2 named elements');
    await expect(panel.getByRole('listitem')).toHaveCount(2);
    await panel.getByRole('button', { name: 'Copy as page object (.ts)' }).click();
    expect(await panel.evaluate(() => navigator.clipboard.readText())).toContain('applyCoupon');

    await panel.getByRole('button', { name: 'Remove offersPopup' }).click();
    await expect(panel.getByRole('status')).toHaveText('1 named element');
    await panel.getByRole('button', { name: 'Clear the list' }).click();
    await expect(panel.getByText('No named element yet.')).toBeVisible();
  });
});
