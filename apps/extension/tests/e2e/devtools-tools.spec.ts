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

test.describe('the Piwi panel’s Locators console', () => {
  test('evaluates on Enter, keeps a history the arrow keys walk, and recalls it when the panel opens again', async ({
    context,
    extensionId,
  }) => {
    const shop = await openShop(context);
    const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop);
    await panel.getByRole('tab', { name: 'Locators' }).click();
    const input = panel.getByRole('textbox', { name: 'Locator to try' });

    await input.fill("getByTestId('apply-coupon')");
    await input.press('Enter');
    await expect(panel.getByRole('status')).toHaveText('One element: strict mode passes');
    await input.fill("getByRole('button', { name: 'Show popup' })");
    await input.press('Enter');
    await expect(panel.getByRole('status')).toHaveText('2 elements: strict mode fails');
    await expect
      .poll(() =>
        panel.evaluate(async () => (await chrome.storage.session.get('piwiLocatorHistory')).piwiLocatorHistory),
      )
      .toEqual(["getByTestId('apply-coupon')", "getByRole('button', { name: 'Show popup' })"]);

    // Like a shell: Up goes back, and Down past the newest gives back what was being typed.
    await input.fill("getByRole('button', { name: 'Gift");
    await input.press('ArrowUp');
    await expect(input).toHaveValue("getByRole('button', { name: 'Show popup' })");
    await input.press('ArrowUp');
    await expect(input).toHaveValue("getByTestId('apply-coupon')");
    // An entry recalled is evaluated at once.
    await expect(panel.getByRole('status')).toHaveText('One element: strict mode passes');
    await input.press('ArrowDown');
    await input.press('ArrowDown');
    await expect(input).toHaveValue("getByRole('button', { name: 'Gift");

    // Closed and opened again, the panel shows the newest expression, evaluated.
    await panel.close();
    const again = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop);
    await again.getByRole('tab', { name: 'Locators' }).click();
    const field = again.getByRole('textbox', { name: 'Locator to try' });
    await expect(field).toHaveValue("getByRole('button', { name: 'Show popup' })");
    await expect(again.getByRole('status')).toHaveText('2 elements: strict mode fails');
    await field.press('ArrowUp');
    await expect(field).toHaveValue("getByTestId('apply-coupon')");
  });

  test('copies the locator in each copy mode and adds it to the session', async ({ context, extensionId }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const shop = await openShop(context);
    const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop);
    await panel.getByRole('tab', { name: 'Locators' }).click();
    const input = panel.getByRole('textbox', { name: 'Locator to try' });
    // Typed as in a test, with the page in front: the copies hold the locator once.
    await input.fill("page.getByTestId('apply-coupon')");
    await expect(panel.getByRole('status')).toHaveText('One element: strict mode passes');

    await panel.getByRole('button', { name: 'Action' }).click();
    expect(await panel.evaluate(() => navigator.clipboard.readText())).toBe(
      "await page.getByTestId('apply-coupon').click();",
    );
    await panel.getByRole('button', { name: 'Locator', exact: true }).click();
    expect(await panel.evaluate(() => navigator.clipboard.readText())).toBe("page.getByTestId('apply-coupon')");
    // A copy keeps the expression in the history as Enter does.
    await expect
      .poll(() =>
        panel.evaluate(async () => (await chrome.storage.session.get('piwiLocatorHistory')).piwiLocatorHistory),
      )
      .toEqual(["page.getByTestId('apply-coupon')"]);

    await panel.getByRole('button', { name: 'Add to session' }).click();
    const name = panel.getByRole('textbox', { name: 'Name for this element' });
    await expect(name).toBeFocused();
    await name.fill('page');
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel.getByText('The page object already uses the name page')).toBeVisible();
    await name.fill('applyCoupon');
    await name.press('Enter');
    await expect(panel.getByText('Added to the session as applyCoupon.')).toBeVisible();
    expect(
      await panel.evaluate(async () => (await chrome.storage.session.get('piwiPickSession')).piwiPickSession),
    ).toEqual([{ name: 'applyCoupon', locator: "getByTestId('apply-coupon')", pageUrl: `${ORIGIN}/cart` }]);

    await panel.getByRole('tab', { name: 'Session' }).click();
    await expect(panel.getByRole('status')).toHaveText('1 named element');

    // An expression that does not read offers nothing to copy.
    await panel.getByRole('tab', { name: 'Locators' }).click();
    await input.fill("getByRole('button', {");
    await expect(panel.getByRole('status')).toContainText('The console can’t read this locator');
    await expect(panel.getByRole('button', { name: 'Add to session' })).toBeHidden();
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
