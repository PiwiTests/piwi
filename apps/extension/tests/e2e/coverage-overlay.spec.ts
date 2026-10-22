import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  BRITTLE_TESTS,
  CARD_TEST,
  DEFAULT_CONNECTION,
  INSTANCE_URL,
  PAGE_TESTS,
  SHOP_TESTS,
  injectCoverage,
  openShop,
  openShopUnder,
  readCoverage,
  shopIndex,
  stubCoverageChrome,
} from './coverage-fixtures.js';
import { servePages } from './engine-bundle.js';
import { readCatalog } from './i18n-stub.js';
import { playwrightLocator } from './playwright-locator.js';
import { clippedInShadows } from './shadow.js';

/**
 * The "Tested elements" overlay (`coverage-overlay.js`) driven as a bundle on
 * a realistic page (`pages/shop.html`), with `chrome.*` stubbed: the locator
 * index of a fake project is in the extension cache, the worker answers
 * refreshes. The overlay renders into an open shadow root in tests, so its
 * boxes, badges, cards and panel can be inspected directly.
 */

const HOST = '#piwi-coverage-host';

async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  return box;
}

test.describe('coverage overlay on a page', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  test('lists what the tests reach, how, and the untested interactive elements', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const coverage = await readCoverage(page);

    const byDescription = new Map(coverage.covered.map((c) => [c.description, c]));
    expect(byDescription.get('searchbox "Search products"')).toMatchObject({ kind: 'operated', ambiguous: false });
    expect(byDescription.get('button "Cart, 2 items"')).toMatchObject({
      kind: 'checked',
      tests: ['adds a mug to the cart'],
    });
    expect(byDescription.get('checkbox "In stock"')).toMatchObject({
      kind: 'operated',
      tests: ['filters in-stock products'],
    });
    expect(byDescription.get('button "4 stars"')).toMatchObject({ kind: 'operated', tests: ['rates a product'] });
    expect(byDescription.get('textbox "Message"')).toMatchObject({
      kind: 'operated',
      tests: ['opens the support chat'],
    });
    expect(byDescription.get('heading "Your cart"')).toMatchObject({ kind: 'checked' });

    // The Blue mug's button is operated by one test and counted by another; the other three are only counted.
    const addToCart = coverage.covered.filter((c) => c.description === 'button "Add to cart"');
    expect(addToCart).toHaveLength(4);
    expect(addToCart[0]).toMatchObject({
      kind: 'operated',
      ambiguous: false,
      tests: ['adds a mug to the cart', 'filters in-stock products'],
    });
    for (const other of addToCart.slice(1)) expect(other).toMatchObject({ kind: 'checked', ambiguous: true });

    const uncovered = coverage.uncovered.map((u) => u.description);
    expect(uncovered).toEqual(
      expect.arrayContaining([
        'link "Shop now"',
        'checkbox "Free shipping"',
        'button "Add Blue mug to wishlist"',
        'textbox "Coupon code"',
        'button "Apply"',
        'button "Subscribe"',
        'link "Legal notice"',
        'button "1 star"',
      ]),
    );
    // Covered through their label or a child, never listed as untested; the overlay's own controls never count.
    expect(uncovered).not.toContain('checkbox "In stock"');
    expect(uncovered.some((d) => /panel|Collapse|Close/.test(d))).toBe(false);

    expect(coverage.tests[0]).toEqual({ title: 'shows prices', elements: 7 });
    expect(coverage.tests.map((t) => t.title)).not.toContain('uses a layout locator');
    // "Log in", "Password", and the cookie dialog's button while the dialog is closed.
    expect(coverage.unmatched).toBe(3);
    expect(coverage.errors).toEqual([
      { locator: 'locator(\'button:left-of(:text("Apply"))\')', message: ':left-of() is not supported' },
    ]);
  });

  test('draws a box per element and a badge with its number of tests', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);

    const search = await boxOf(page, 'input[type=search]');
    const boxes = await page.locator(`${HOST} .box`).evaluateAll((els) =>
      els.map((e) => ({
        kind: (e as HTMLElement).dataset.kind,
        rect: e.getBoundingClientRect().toJSON() as DOMRect,
      })),
    );
    const onSearch = boxes.find(
      (b) =>
        Math.abs(b.rect.left - search.x) < 1 &&
        Math.abs(b.rect.top - search.y) < 1 &&
        Math.abs(b.rect.width - search.width) < 1,
    );
    expect(onSearch?.kind).toBe('operated');
    expect(boxes.filter((b) => b.kind === 'uncovered').length).toBeGreaterThanOrEqual(15);

    // The badge of the Blue mug's button reads 2 tests and carries a flaky dot.
    const button = await boxOf(page, 'article:has-text("Blue mug") button.primary');
    const badges = await page.locator(`${HOST} .badge`).evaluateAll((els) =>
      els.map((e) => ({
        text: e.textContent,
        flaky: !!e.querySelector('.dot.flaky'),
        rect: e.getBoundingClientRect().toJSON() as DOMRect,
      })),
    );
    const onButton = badges.find(
      (b) =>
        b.rect.left >= button.x &&
        b.rect.left <= button.x + button.width + 8 &&
        Math.abs(b.rect.top - (button.y - 9)) < 3,
    );
    expect(onButton).toMatchObject({ text: '2', flaky: true });
  });

  test('hovering an element previews the tests that reach it', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const target = await boxOf(page, 'nav a[href="/deals"]');
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    const preview = page.locator(`${HOST} .card.preview`);
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('link "Deals"');
    await expect(preview).toContainText('Acted on by 1 test');
    await expect(preview).toContainText('navigation › visits the deals');
    await page.mouse.move(700, 880);
    await expect(preview).toBeHidden();
  });

  test('a badge opens a card with each locator, its tests and links into Piwi', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const button = await boxOf(page, 'article:has-text("Blue mug") button.primary');
    const badge = page.locator(`${HOST} .badge`).filter({ hasText: /^2/ });
    await badge.click();
    const card = page.locator(`${HOST} .card.pinned`);
    await expect(card).toBeVisible();
    await expect(card).toContainText('button "Add to cart"');
    await expect(card).toContainText(
      "getByTestId('product-card').filter({ hasText: 'Blue mug' }).getByRole('button', { name: 'Add to cart' })",
    );
    await expect(card).toContainText("getByRole('button', { name: 'Add to cart' })");
    await expect(card).toContainText('Finds 4 elements on this page');
    await expect(card.getByRole('link', { name: 'catalog › adds a mug to the cart' })).toHaveAttribute(
      'href',
      `${INSTANCE_URL}/test-cases/101`,
    );
    await expect(card).toContainText('Click · tests/catalog.spec.ts:9:5 · chromium');
    const find = card.getByRole('link', { name: /Find these locators in Piwi/ });
    const href = await find.getAttribute('href');
    expect(href).toContain(`${INSTANCE_URL}/projects/1/locators?q=`);
    expect(decodeURIComponent(href!.split('?q=')[1]!).split('\n')).toHaveLength(2);
    // The card sits next to the element.
    const cardBox = await card.boundingBox();
    expect(Math.abs(cardBox!.y - (button.y + button.height + 10))).toBeLessThan(2);

    // Escape closes the card first, then the overlay itself.
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    await expect(page.locator(HOST)).toBeAttached();
    await page.keyboard.press('Escape');
    await expect(page.locator(HOST)).not.toBeAttached();
  });

  test('the Tests list spotlights the elements one test reaches', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const panel = page.locator(`${HOST} .panel`);
    await panel.getByRole('button', { name: /^Tests \d+$/ }).click();
    const row = panel.locator('li.row', { hasText: 'shows prices' });
    await expect(row).toContainText('7 elements');
    await row.click();
    await expect(row).toContainText('showing only its elements');
    await expect(page.locator(`${HOST} .box.strong`)).toHaveCount(7);
    expect(await page.locator(`${HOST} .box.dim`).count()).toBeGreaterThan(20);
    await row.click();
    await expect(row).not.toContainText('showing only its elements');
    // The list re-renders under the pointer, and hovering a row spotlights it too. The pointer moves over the
    // redrawn row before it leaves, as a person's does: one jump away fires no mouseleave on a row the browser
    // has not yet seen under the pointer.
    await row.hover();
    await page.mouse.move(5, 5);
    await expect(page.locator(`${HOST} .box.strong`)).toHaveCount(0);
  });

  test('toggles hide the untested boxes and shade boxes by number of tests', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const panel = page.locator(`${HOST} .panel`);
    expect(await page.locator(`${HOST} .box.uncovered`).count()).toBeGreaterThan(10);
    await panel.getByLabel('Not tested').uncheck();
    await expect(page.locator(`${HOST} .box.uncovered`)).toHaveCount(0);
    await panel.getByLabel('Checked').uncheck();
    await expect(page.locator(`${HOST} .box.checked`)).toHaveCount(0);
    await expect(page.locator(`${HOST} .box.operated`).first()).toBeAttached();
    await panel.getByLabel('Heat map').check();
    const heats = await page
      .locator(`${HOST} .box.operated`)
      .evaluateAll((els) => els.map((e) => Number((e as HTMLElement).style.getPropertyValue('--heat'))));
    expect(Math.max(...heats)).toBe(1);
    expect(Math.min(...heats)).toBeGreaterThan(0);
  });

  test('the Not tested list suggests a locator to write a test with', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const panel = page.locator(`${HOST} .panel`);
    await panel.getByRole('button', { name: /^Not tested \d+$/ }).click();
    const row = panel.locator('li.row', { hasText: 'button "Subscribe"' });
    await expect(row.locator('code')).toHaveText("getByRole('button', { name: 'Subscribe' })");
    await expect(row.getByRole('button', { name: 'Copy locator' })).toBeVisible();
    // A checkbox named only by the label wrapping it is suggested by that name.
    await expect(panel.locator('li.row', { hasText: 'checkbox "Free shipping"' }).locator('code')).toHaveText(
      "getByRole('checkbox', { name: 'Free shipping' })",
    );
    await panel.getByLabel('Filter the list').fill('coupon');
    await expect(panel.locator('li.row')).toHaveCount(1);
  });

  test('the search keeps its focus while typing, and Escape clears it before it closes the overlay', async ({
    page,
    context,
  }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const panel = page.locator(`${HOST} .panel`);
    await panel.getByRole('button', { name: /^Not tested \d+$/ }).click();
    const rows = panel.locator('li.row');
    const all = await rows.count();
    expect(all).toBeGreaterThan(4);

    const search = panel.getByLabel('Filter the list');
    await search.click();
    await search.pressSequentially('wishlist');
    await expect(search).toHaveValue('wishlist');
    await expect(search).toBeFocused();
    await expect(rows).toHaveCount(4);
    for (const text of await rows.allTextContents()) expect(text).toContain('wishlist');

    await page.keyboard.press('Escape');
    await expect(search).toHaveValue('');
    await expect(rows).toHaveCount(all);
    await expect(page.locator(HOST)).toBeAttached();
    await page.keyboard.press('Escape');
    await expect(page.locator(HOST)).not.toBeAttached();
  });

  test('a rescan keeps the focused tab and the open notes', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const panel = page.locator(`${HOST} .panel`);
    const notes = panel.locator('details.notes');
    await notes.locator('summary').click();
    await expect(notes).toHaveJSProperty('open', true);
    const testsTab = panel.getByRole('button', { name: /^Tests \d+$/ });
    await testsTab.click();
    await expect(testsTab).toHaveAttribute('aria-pressed', 'true');
    await expect(testsTab).toBeFocused();

    const scans = (await readCoverage(page)).scans;
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.textContent = 'Gift wrap';
      document.querySelector('main')!.appendChild(button);
    });
    await expect.poll(async () => (await readCoverage(page)).scans).toBeGreaterThan(scans);
    await expect(testsTab).toBeFocused();
    await expect(notes).toHaveJSProperty('open', true);
  });

  test('follows the page: added and removed elements rescan', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const before = await readCoverage(page);
    expect(before.unmatched).toBe(3);

    await page.evaluate(() => {
      const login = document.createElement('button');
      login.textContent = 'Log in';
      document.querySelector('header')!.appendChild(login);
      document.querySelector('.newsletter')!.remove();
    });
    await page.waitForFunction(
      (scans) => (globalThis as unknown as { __piwiCoverage: { scans: number } }).__piwiCoverage.scans > scans,
      before.scans,
    );
    const after = await readCoverage(page);
    expect(after.covered.find((c) => c.description === 'button "Log in"')).toMatchObject({
      kind: 'operated',
      tests: ['pays by card'],
    });
    expect(after.unmatched).toBe(2);
    expect(after.uncovered.map((u) => u.description)).not.toContain('button "Subscribe"');
  });

  test('boxes follow the page when it scrolls', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div style="height: 1600px"></div>'));
    await injectCoverage(page);
    const hasBoxAt = async (y: number) =>
      (await page.locator(`${HOST} .box`).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top))).some(
        (top) => Math.abs(top - y) < 1,
      );
    const input = await boxOf(page, 'input[type=search]');
    expect(await hasBoxAt(input.y)).toBe(true);
    await page.mouse.wheel(0, 200);
    await expect
      .poll(async () => {
        const now = await boxOf(page, 'input[type=search]');
        return now.y < input.y - 100 && (await hasBoxAt(now.y));
      })
      .toBe(true);
  });

  test('a newer index from the instance replaces the cached one', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    expect((await readCoverage(page)).uncovered.map((u) => u.description)).toContain('button "Subscribe"');

    const withNewsletter = shopIndex([
      ...SHOP_TESTS,
      {
        title: 'subscribes to the newsletter',
        suite: ['newsletter'],
        file: 'tests/newsletter.spec.ts',
        status: 'passed',
        uses: [
          ["getByRole('form', { name: 'Newsletter' }).getByRole('textbox')", ['fill'], 4],
          ["getByRole('button', { name: 'Subscribe' })", ['click'], 5],
        ],
      },
    ]);
    await page.evaluate((index) => {
      (globalThis as Record<string, unknown>).__piwiTestRefreshAnswer = { ok: true, refreshed: true, index };
    }, withNewsletter);
    const scans = (await readCoverage(page)).scans;
    await page.locator(`${HOST} .panel`).getByRole('button', { name: 'Refresh' }).click();
    await page.waitForFunction(
      (n) => (globalThis as unknown as { __piwiCoverage: { scans: number } }).__piwiCoverage.scans > n,
      scans,
    );
    const coverage = await readCoverage(page);
    expect(coverage.covered.find((c) => c.description === 'button "Subscribe"')?.tests).toEqual([
      'subscribes to the newsletter',
    ]);
    expect(coverage.covered.find((c) => c.description === 'textbox "Email for the newsletter"')?.kind).toBe('operated');
    const sent = await page.evaluate(
      () => (globalThis as unknown as { __piwiTestSent: Array<{ type: string; force?: boolean }> }).__piwiTestSent,
    );
    expect(sent.filter((m) => m.type === 'piwi-refresh-locator-index').map((m) => m.force)).toEqual([false, true]);
  });

  test('draws above a modal dialog the page opened, and says the panel is blocked meanwhile', async ({
    page,
    context,
  }) => {
    await stubCoverageChrome(context);
    await openShop(page);
    await injectCoverage(page);
    // In the top layer, after the dialog: drawn above it.
    expect(await page.locator(HOST).evaluate((host) => host.matches(':popover-open'))).toBe(true);
    const coverage = await readCoverage(page);
    expect(coverage.covered.find((c) => c.description === 'button "Accept all"')).toMatchObject({
      kind: 'operated',
      visible: true,
    });
    expect(coverage.uncovered.map((u) => u.description)).toContain('button "Settings"');
    const accept = await boxOf(page, 'dialog button.primary');
    const tops = await page
      .locator(`${HOST} .box.operated`)
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
    expect(tops.some((r) => Math.abs(r.x - accept.x) < 1 && Math.abs(r.y - accept.y) < 1)).toBe(true);
    // Boxes of what sits behind the dialog are dimmed; the dialog's own stay bright.
    const dimmed = await page.locator(`${HOST} .box.dim`).count();
    expect(dimmed).toBeGreaterThan(20);
    expect(await page.locator(`${HOST} .box.operated:not(.dim)`).count()).toBe(1);
    // A modal dialog makes the rest of the page inert, the overlay included.
    await expect(page.locator(`${HOST} .panel`)).toContainText('The page has a dialog open');
  });

  test('collapses to a pill that keeps the summary, and expands back', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const panel = page.locator(`${HOST} .panel`);
    await panel.getByRole('button', { name: 'Shrink the panel to a summary' }).click();
    const pill = page.locator(`${HOST} .pill`);
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText(/Piwi · 14\/34 tested · 8 tests/);
    await expect(panel).toBeHidden();
    await pill.click();
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Move the panel to the other side' }).click();
    const box = await panel.boundingBox();
    expect(box!.x).toBeLessThan(20);
  });

  test('the panel is a named region, not a dialog, and its × closes the overlay', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const region = page.locator(HOST).getByRole('region', { name: 'Piwi: tested elements' });
    await expect(region).toBeVisible();
    await expect(page.locator(HOST).getByRole('dialog')).toHaveCount(0);
    await region.getByRole('button', { name: 'Close (Esc)' }).click();
    await expect(page.locator(HOST)).not.toBeAttached();
  });

  test('injecting it again turns it off', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    await injectCoverage(page, 'closed');
    await expect(page.locator(HOST)).not.toBeAttached();
  });

  test('a locator suggested right after a page change counts what the page holds now', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const panel = page.locator(`${HOST} .panel`);
    await panel.getByRole('button', { name: /^Not tested \d+$/ }).click();
    await expect(panel.locator('li.row', { hasText: 'button "Subscribe"' }).locator('code')).toHaveText(
      "getByRole('button', { name: 'Subscribe' })",
    );

    // A second Subscribe button, then the list filtered before the rescan: its suggestion is checked again.
    const shown = await page.evaluate(async () => {
      const scans = () => (globalThis as unknown as { __piwiCoverage: { scans: number } }).__piwiCoverage.scans;
      const before = scans();
      const button = document.createElement('button');
      button.textContent = 'Subscribe';
      document.querySelector('footer')!.appendChild(button);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const list = document.querySelector('#piwi-coverage-host')!.shadowRoot!.querySelector('.panel')!;
      const search = list.querySelector<HTMLInputElement>('input.search')!;
      search.value = 'subscribe';
      search.dispatchEvent(new Event('input'));
      return {
        rescanned: scans() !== before,
        locators: [...list.querySelectorAll('li.row code')].map((code) => code.textContent!),
      };
    });
    expect(shown.rescanned).toBe(false);
    expect(shown.locators).toHaveLength(1);
    expect(shown.locators[0]).not.toBe("getByRole('button', { name: 'Subscribe' })");
    await expect(playwrightLocator(page, shown.locators[0]!)).toHaveCount(1);
  });

  test('closed before the index arrives, it does nothing with the late answer', async ({ page, context }) => {
    await stubCoverageChrome(context, { cached: null });
    await openShop(page, '?nodialog');
    await page.evaluate(() => {
      const g = globalThis as Record<string, unknown>;
      g.__piwiTestRefreshAnswer = new Promise((resolve) => (g.__piwiTestAnswer = resolve));
    });
    await injectCoverage(page, 'loading');
    await injectCoverage(page, 'closed');
    await expect(page.locator(HOST)).not.toBeAttached();

    await page.evaluate(
      (index) =>
        (globalThis as unknown as { __piwiTestAnswer: (answer: unknown) => void }).__piwiTestAnswer({
          ok: true,
          refreshed: true,
          index,
        }),
      shopIndex(),
    );
    await page.waitForTimeout(800);
    // A change inside a web component, which an open overlay rescans for.
    await page.evaluate(() =>
      document
        .querySelector('rating-stars')!
        .shadowRoot!.querySelector('button')!
        .setAttribute('aria-label', 'No star'),
    );
    await page.waitForTimeout(1500);
    expect(await readCoverage(page)).toEqual({ status: 'closed' });
  });
});

test.describe('coverage overlay states', () => {
  test('not connected: explains how to connect and opens the settings', async ({ page, context }) => {
    await stubCoverageChrome(context, { connection: null, cached: null });
    await openShop(page, '?nodialog');
    await injectCoverage(page, 'not-connected');
    const panel = page.locator(`${HOST} .panel`);
    await expect(panel).toContainText('Piwi Picker is not connected to your Piwi instance yet. Open the settings');
    await panel.getByRole('button', { name: 'Open Piwi Picker settings' }).click();
    const sent = await page.evaluate(
      () => (globalThis as unknown as { __piwiTestSent: Array<{ type: string }> }).__piwiTestSent,
    );
    expect(sent.map((m) => m.type)).toContain('piwi-open-options');
    await expect(page.locator(`${HOST} .box`)).toHaveCount(0);
  });

  test('no project mapped to the page', async ({ page, context }) => {
    await stubCoverageChrome(context, {
      connection: {
        instanceUrl: INSTANCE_URL,
        apiKey: '',
        projectMappings: [{ urlPattern: 'https://elsewhere.test/**', projectId: 1, projectLabel: 'Acme Mugs' }],
      },
    });
    await openShop(page, '?nodialog');
    await injectCoverage(page, 'no-project');
    await expect(page.locator(`${HOST} .panel`)).toContainText('No project is set for this page');
  });

  test('no cached index and the instance unreachable: says why and offers a retry', async ({ page, context }) => {
    await stubCoverageChrome(context, {
      cached: null,
      refresh: { ok: false, error: 'Failed to fetch the locator index (502)' },
    });
    await openShop(page, '?nodialog');
    await injectCoverage(page, 'error');
    const panel = page.locator(`${HOST} .panel`);
    await expect(panel).toContainText(
      'Could not load the locator index of Acme Mugs: Failed to fetch the locator index (502)',
    );
    await page.evaluate((index) => {
      (globalThis as Record<string, unknown>).__piwiTestRefreshAnswer = { ok: true, refreshed: true, index };
    }, shopIndex());
    await panel.getByRole('button', { name: 'Try again' }).click();
    await page.waitForFunction(
      () => (globalThis as unknown as { __piwiCoverage: { status: string } }).__piwiCoverage.status === 'ready',
    );
    expect((await readCoverage(page)).covered.length).toBeGreaterThan(10);
  });

  test('no cached index: loads it from the instance', async ({ page, context }) => {
    await stubCoverageChrome(context, { cached: null, refresh: { ok: true, refreshed: true, index: shopIndex() } });
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    expect((await readCoverage(page)).coveredInteractive).toBe(14);
  });

  test('reads the project’s test id attribute', async ({ page, context }) => {
    const index = shopIndex(
      [
        {
          title: 'opens the cart',
          suite: [],
          file: 'tests/cart.spec.ts',
          status: 'passed',
          uses: [["getByTestId('open-cart')", ['click'], 3]],
        },
      ],
      { testIdAttributes: ['data-qa'] },
    );
    await stubCoverageChrome(context, { cached: index });
    await openShop(page, '?nodialog');
    await page.evaluate(() =>
      document.querySelector('[data-testid="cart-button"]')!.setAttribute('data-qa', 'open-cart'),
    );
    await injectCoverage(page);
    const coverage = await readCoverage(page);
    expect(coverage.covered.map((c) => c.description)).toEqual(['button "Cart, 2 items"']);
    await expect(page.locator(`${HOST} .panel`)).toContainText('getByTestId reads data-qa');
  });
});

/** A catalog page of 1,200 products, and an index of 600 tests using five locators each. */
async function openBigShop(page: Page, context: BrowserContext): Promise<void> {
  const products = 1200;
  const tests = Array.from({ length: 600 }, (_, i) => ({
    title: `product ${i}`,
    suite: ['catalog'],
    file: `tests/catalog-${i % 20}.spec.ts`,
    status: 'passed' as const,
    uses: [
      [`getByTestId('product-${i}').getByRole('button', { name: 'Add to cart' })`, ['click'], 10],
      [`getByRole('heading', { name: 'Product ${i}', exact: true })`, ['expect.toBeVisible'], 11],
      [`getByRole('link', { name: 'Missing page ${i}' })`, ['click'], 12],
      [`getByLabel('Quantity for product ${i}', { exact: true })`, ['fill'], 13],
      [`locator('#product-${i} .price')`, ['expect.toHaveText'], 14],
    ] as Array<[string, string[], number]>,
  }));
  const cards = Array.from(
    { length: products },
    (_, i) => `<article data-testid="product-${i}" id="product-${i}"><h3>Product ${i}</h3><p class="price">${i} €</p>
      <label>Quantity for product ${i} <input type="number" value="1"></label><button>Add to cart</button></article>`,
  ).join('');
  await servePages(page, 'https://big.test', {
    'big.html': `<!doctype html><html><body><main>${cards}</main></body></html>`,
  });
  await stubCoverageChrome(context, {
    cached: shopIndex(tests),
    connection: {
      instanceUrl: INSTANCE_URL,
      apiKey: '',
      projectMappings: [{ urlPattern: 'https://big.test/**', projectId: 1, projectLabel: 'Big' }],
    },
  });
  await page.goto('https://big.test/big.html');
}

test('scans a large page against a large index without freezing it', async ({ page, context }) => {
  await openBigShop(page, context);
  // Count animation frames while the scan runs: a scan in slices leaves the page painting.
  await page.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    g.__frames = 0;
    const tick = () => {
      g.__frames = (g.__frames as number) + 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const started = Date.now();
  await injectCoverage(page);
  const elapsed = Date.now() - started;
  const coverage = await readCoverage(page);
  expect(coverage.tests).toHaveLength(600);
  expect(coverage.unmatched).toBe(600);
  expect(coverage.covered.filter((c) => c.kind === 'operated').length).toBe(1200);
  expect(coverage.coveredInteractive).toBe(1200);
  expect(coverage.uncoveredCount).toBe(1200);
  expect(coverage.uncovered.length).toBe(500);
  expect(elapsed).toBeLessThan(20_000);
  const frames = await page.evaluate(() => (globalThis as unknown as Record<string, number>).__frames);
  expect(frames).toBeGreaterThan(3);
});

test('rescans a large page about as fast as it first scanned it, the panel open', async ({ page, context }) => {
  await openBigShop(page, context);
  await injectCoverage(page);
  const first = (await readCoverage(page)).durationMs!;
  await page.evaluate(() => document.querySelector('main')!.append(document.createElement('hr')));
  await page.waitForFunction(
    () => (globalThis as unknown as { __piwiCoverage: { scans: number } }).__piwiCoverage.scans >= 2,
    undefined,
    { timeout: 50_000 },
  );
  expect((await readCoverage(page)).durationMs!).toBeLessThan(first * 2);
});

test('a page change in the middle of a scan is in what that scan finds', async ({ page, context }) => {
  await openBigShop(page, context);
  await injectCoverage(page);
  expect((await readCoverage(page)).scans).toBe(1);
  await page.evaluate(() => document.querySelector('main')!.append(document.createElement('hr')));
  // While the rescan runs (its progress bar is up), the link one test looks for appears.
  await page.waitForFunction(() => {
    const panel = document.querySelector('#piwi-coverage-host')!.shadowRoot!.querySelector('.panel')!;
    if (!panel.querySelector('.progress')) return false;
    const link = document.createElement('a');
    link.href = '/missing-7';
    link.textContent = 'Missing page 7';
    document.querySelector('main')!.prepend(link);
    return true;
  });
  await page.waitForFunction(
    () => (globalThis as unknown as { __piwiCoverage: { scans: number } }).__piwiCoverage.scans >= 2,
  );
  const coverage = await readCoverage(page);
  expect(coverage.scans).toBe(2);
  expect(coverage.covered.find((c) => c.description === 'link "Missing page 7"')).toMatchObject({
    kind: 'operated',
    tests: ['product 7'],
  });
  expect(coverage.unmatched).toBe(599);
});

test.describe('coverage overlay limited to one element', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  const BLUE_CARD = 'article:has-text("Blue mug")';

  test('limits the view to an element chosen on the page, then widens it', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const whole = await readCoverage(page);
    const panel = page.locator(`${HOST} .panel`);

    await panel.getByRole('button', { name: 'Limit to an element' }).click();
    await expect(panel.locator('.scope-bar')).toContainText('Click a part of the page');
    expect((await readCoverage(page)).drawn).toBe(0);

    // Point at the Blue mug's Add to cart button, then widen to its card with ↑.
    await page.hover(`${BLUE_CARD} button.primary`);
    await expect.poll(async () => (await readCoverage(page)).choosing).toBe('button "Add to cart"');
    await expect(page.locator(`${HOST} .frame.choosing`)).toBeVisible();
    for (let i = 0; i < 4 && !(await readCoverage(page)).choosing?.startsWith('article'); i++) {
      await page.keyboard.press('ArrowUp');
    }
    expect((await readCoverage(page)).choosing).toMatch(/^article\.card "Blue mug/);
    await page.keyboard.press('ArrowDown');
    expect((await readCoverage(page)).choosing).not.toMatch(/^article/);
    await page.keyboard.press('ArrowUp');

    // The click that chooses never reaches the page.
    await page.evaluate(() => {
      (globalThis as { __clicks?: number }).__clicks = 0;
      document.addEventListener('click', () => (globalThis as { __clicks?: number }).__clicks!++);
    });
    await page.mouse.click(...(await centerOf(page, `${BLUE_CARD} button.primary`)));
    expect(await page.evaluate(() => (globalThis as { __clicks?: number }).__clicks)).toBe(0);

    const scoped = await readCoverage(page);
    expect(scoped.scope).toMatch(/^article\.card "Blue mug/);
    expect(scoped.choosing).toBeNull();
    expect(scoped.covered.map((c) => c.description).sort()).toEqual(
      ['button "4 stars"', 'button "Add to cart"', 'paragraph.price "12 €"'].sort(),
    );
    expect(scoped.uncovered.map((u) => u.description)).toContain('button "Add Blue mug to wishlist"');
    expect(scoped.uncovered.map((u) => u.description)).not.toContain('button "Add Red mug to wishlist"');
    expect(scoped.tests.map((t) => t.title).sort()).toEqual(
      ['adds a mug to the cart', 'filters in-stock products', 'rates a product', 'shows prices'].sort(),
    );
    expect(scoped.coveredInteractive + scoped.uncoveredCount).toBeLessThan(
      whole.coveredInteractive + whole.uncoveredCount,
    );
    await expect(panel.locator('.scope-bar')).toContainText('Inside article.card "Blue mug');
    await expect(page.locator(`${HOST} .frame.scope`)).toBeVisible();
    await expect(page.locator(`${HOST} .frame-tag`)).toContainText('Inside article.card');
    await expect(panel.getByRole('button', { name: /^Tests \d+$/ })).toHaveText('Tests 4');

    // Container ↑ widens to the product grid, Whole page drops the limit.
    await panel.getByRole('button', { name: 'Container ↑' }).click();
    const grid = await readCoverage(page);
    expect(grid.scope).toMatch(/^div\.grid/);
    expect(grid.covered.filter((c) => c.description === 'button "Add to cart"')).toHaveLength(4);
    // Esc goes back to the whole page before it closes the overlay.
    await page.keyboard.press('Escape');
    await expect(page.locator(HOST)).toBeAttached();
    const again = await readCoverage(page);
    expect(again.scope).toBeNull();
    expect(again.covered).toHaveLength(whole.covered.length);
    await expect(page.locator(`${HOST} .frame`)).toHaveCount(0);
  });

  test('Esc cancels choosing, and a link clicked to choose it does not navigate', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const panel = page.locator(`${HOST} .panel`);

    await panel.getByRole('button', { name: 'Limit to an element' }).click();
    await page.keyboard.press('Escape');
    expect((await readCoverage(page)).choosing).toBeNull();
    await expect(page.locator(HOST)).toBeAttached();
    await expect(panel.locator('.scope-bar')).toContainText('Whole page');

    await panel.getByRole('button', { name: 'Limit to an element' }).click();
    const url = page.url();
    await page.locator('nav').getByRole('link', { name: 'Deals' }).click();
    expect(page.url()).toBe(url);
    const scoped = await readCoverage(page);
    expect(scoped.scope).toBe('link "Deals"');
    expect(scoped.tests.map((t) => t.title)).toEqual(['visits the deals']);
  });

  test('opens limited to the element the pick results hand over, with the containers tests reach', async ({
    page,
    context,
  }) => {
    await stubCoverageChrome(context, { cached: shopIndex([...SHOP_TESTS, CARD_TEST]) });
    await openShop(page, '?nodialog');
    await page.evaluate((selector) => {
      (globalThis as { __piwiCoverageScopeRequest?: Element }).__piwiCoverageScopeRequest =
        document.querySelector(selector)!;
    }, '.grid article:first-child button.primary');
    await injectCoverage(page);
    const coverage = await readCoverage(page);
    expect(coverage.scope).toBe('button "Add to cart"');
    expect(coverage.containers).toEqual([
      { description: expect.stringMatching(/^article\.card "Blue mug/), tests: ['shows the Blue mug card'] },
    ]);
    const around = page.locator(`${HOST} .panel .around`);
    await expect(around).toContainText('Around it');
    await around.locator('li.row').first().hover();
    await expect(page.locator(`${HOST} .frame.around`)).toBeVisible();
    await around.locator('li.row').first().click();
    const card = await readCoverage(page);
    expect(card.scope).toMatch(/^article\.card "Blue mug/);
    expect(card.tests.map((t) => t.title)).toContain('shows the Blue mug card');
    await page.locator(`${HOST} .panel`).getByRole('button', { name: 'Whole page' }).click();
    expect((await readCoverage(page)).scope).toBeNull();
  });
});

async function centerOf(page: Page, selector: string): Promise<[number, number]> {
  const box = await boxOf(page, selector);
  return [box.x + box.width / 2, box.y + box.height / 2];
}

test.describe('coverage overlay on a branch', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  /** On feature/voucher, only the search test ran; it now uses the search button alone. */
  const featureIndex = () =>
    shopIndex(
      [
        {
          ...SHOP_TESTS[0]!,
          uses: [["getByRole('button', { name: 'Search' })", ['click'], 6]],
        },
      ],
      {
        branch: 'feature/voucher',
        branches: [{ name: 'feature/voucher', lastSeenAt: '2026-09-25T10:00:00.000Z', tests: 1 }],
      },
    );

  test('reads the branch the URL mapping names, and the panel switches branches', async ({ page, context }) => {
    await stubCoverageChrome(context, {
      connection: {
        ...DEFAULT_CONNECTION,
        projectMappings: [{ ...DEFAULT_CONNECTION.projectMappings[0]!, branch: 'feature/voucher' }],
      },
      cachedBranches: { 'feature/voucher': featureIndex() },
    });
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const onFeature = await readCoverage(page);
    expect(onFeature.branch).toBe('feature/voucher');
    expect(onFeature.tests.map((t) => t.title)).toEqual(['finds a product by name']);
    const select = page.locator(`${HOST} .panel select.branch-select`);
    await expect(select).toHaveValue('feature/voucher');
    const sent = () =>
      page.evaluate(
        () =>
          (globalThis as unknown as { __piwiTestSent: Array<{ type: string; branch?: string | null }> }).__piwiTestSent,
      );
    expect((await sent()).filter((m) => m.type === 'piwi-refresh-locator-index').map((m) => m.branch)).toEqual([
      'feature/voucher',
    ]);

    // Back to the default branch: its cached index, remembered for the session.
    await select.selectOption('');
    await page.waitForFunction(
      () =>
        (globalThis as { __piwiCoverage?: { branch?: string | null; status?: string } }).__piwiCoverage?.branch ===
        null,
    );
    await expect.poll(async () => (await readCoverage(page)).status).toBe('ready');
    expect((await readCoverage(page)).tests.length).toBeGreaterThan(1);
    expect((await sent()).filter((m) => m.type === 'piwi-refresh-locator-index').map((m) => m.branch)).toEqual([
      'feature/voucher',
      null,
    ]);
    const remembered = await page.evaluate(async () =>
      (globalThis as any).chrome.storage.session.get('piwiLocatorBranchOverride'),
    );
    expect(remembered).toEqual({ piwiLocatorBranchOverride: { '1': '' } });
  });
});

test.describe('coverage overlay: locators at risk', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  test('lists the brittle locators, with a replacement that finds only their element', async ({ page, context }) => {
    await stubCoverageChrome(context, { cached: shopIndex([...SHOP_TESTS, ...BRITTLE_TESTS]) });
    await openShop(page, '?nodialog');
    // The replacement offered below finds the Checkout button with real Playwright, and only it. (Checked before
    // the overlay opens: in tests it renders into an open shadow root, whose badges Playwright would find too.)
    await expect(page.getByRole('button', { name: 'Checkout' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Checkout' })).toHaveText('Checkout');
    await injectCoverage(page);
    const coverage = await readCoverage(page);

    expect(coverage.brittle.map((b) => b.locator)).toEqual([
      // Used by a flaky test, so listed first.
      "locator('.grid .primary').nth(1)",
      "locator('.card .price').first()",
      "locator('.card .primary')",
      "locator('aside.cart > button')",
    ]);
    const [redMug, price, buttons, checkout] = coverage.brittle;
    expect(redMug).toMatchObject({
      rules: ['position', 'css-class', 'css-class'],
      elements: ['button "Add to cart"'],
      count: 1,
      tests: ['adds the red mug'],
      callSites: ['tests/legacy.spec.ts:12:5'],
      // Its name finds every card's button: the card showing "Red mug" sets it apart.
      replacement: {
        recommended:
          "getByTestId('product-card').filter({ hasText: 'Red mug' }).getByRole('button', { name: 'Add to cart' })",
        durable: null,
      },
    });
    // The card holding "Blue mug" sets it apart from the other prices, and its role, paragraph, from the card's other texts.
    expect(price).toMatchObject({
      rules: ['css-class', 'css-class', 'position'],
      replacement: {
        recommended: "getByRole('article').filter({ hasText: 'Blue mug' }).getByRole('paragraph')",
        durable: null,
      },
    });
    // Finding four buttons, no single element to build a replacement from.
    expect(buttons).toMatchObject({ count: 4, replacement: null });
    expect(checkout).toMatchObject({
      rules: ['css-class', 'css-structure'],
      elements: ['button "Checkout"'],
      replacement: { recommended: "getByRole('button', { name: 'Checkout' })", durable: null },
    });
    // Six elements carry the mark: the first price, the four cards' buttons and Checkout.
    await expect(page.locator(`${HOST} .box.brittle`)).toHaveCount(6);
    const panel = page.locator(`${HOST} .panel`);
    await expect(panel.locator('.meter-label')).toContainText('6 tested elements reached through brittle locators');
    await panel.getByLabel('Brittle').uncheck();
    await expect(page.locator(`${HOST} .box.brittle`)).toHaveCount(0);
  });

  test('opens without a long freeze on a page with hundreds of brittle locators', async ({ page, context }) => {
    const products = 400;
    const tests = Array.from({ length: products }, (_, i) => ({
      title: `adds product ${i}`,
      suite: ['legacy'],
      file: 'tests/legacy.spec.ts',
      status: 'passed' as const,
      uses: [[`locator('#product-${i} > div > button.primary')`, ['click'], i + 1]] as Array<
        [string, string[], number]
      >,
    }));
    // Cards that no text tells apart: every stable locator also finds the other cards' buttons.
    const cards = Array.from(
      { length: products },
      (_, i) => `<article class="card" id="product-${i}"><h3>Mug</h3>
        <div><button class="primary">Add to cart</button><button>Details</button></div></article>`,
    ).join('');
    await servePages(page, 'https://brittle.test', {
      'brittle.html': `<!doctype html><html><body><main>${cards}</main></body></html>`,
    });
    await stubCoverageChrome(context, {
      cached: shopIndex(tests),
      connection: {
        instanceUrl: INSTANCE_URL,
        apiKey: '',
        projectMappings: [{ urlPattern: 'https://brittle.test/**', projectId: 1, projectLabel: 'Brittle' }],
      },
    });
    await page.goto('https://brittle.test/brittle.html');
    await page.evaluate(() => {
      const g = globalThis as unknown as { __longTasks: number[] };
      g.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) g.__longTasks.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    });
    await injectCoverage(page);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const longest = await page.evaluate(() =>
      Math.max(0, ...(globalThis as unknown as { __longTasks: number[] }).__longTasks),
    );
    expect(longest).toBeLessThan(1500);
    // The At risk tab still offers what it offers for each.
    const coverage = await readCoverage(page);
    expect(coverage.brittle).toHaveLength(products);
    expect(coverage.brittle[0]).toMatchObject({ count: 1, replacement: 'add-test-id' });
  });

  test('the At risk tab copies the replacement and the edit to make', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await stubCoverageChrome(context, { cached: shopIndex([...SHOP_TESTS, ...BRITTLE_TESTS]) });
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const panel = page.locator(`${HOST} .panel`);
    await panel.getByRole('button', { name: 'At risk 4' }).click();
    await expect(panel.locator('.section-head')).toHaveText('Brittle locators · 4');

    const row = panel.locator('li.row', { hasText: "locator('aside.cart > button')" });
    await expect(row.locator('.detail').first()).toHaveText('CSS class · CSS structure · tests/legacy.spec.ts:20:5');
    await expect(row.locator('code.suggestion')).toHaveText("→ getByRole('button', { name: 'Checkout' })");
    await row.getByRole('button', { name: 'Copy the change' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "tests/legacy.spec.ts:20:5\n- locator('aside.cart > button')\n+ getByRole('button', { name: 'Checkout' })",
    );
    await expect(
      panel.locator('li.row', { hasText: "locator('.grid .primary').nth(1)" }).locator('code.suggestion'),
    ).toHaveText(
      "→ getByTestId('product-card').filter({ hasText: 'Red mug' }).getByRole('button', { name: 'Add to cart' })",
    );
    await expect(panel.locator('li.row', { hasText: "locator('.card .primary')" })).toContainText(
      'Finds 4 elements here, so no replacement is offered.',
    );

    // The card of the Checkout button says the same, next to the locator.
    await row.click();
    const card = page.locator(`${HOST} .card.pinned`);
    await expect(card.locator('.note.stability')).toHaveText('Brittle: CSS class, CSS structure');
    await expect(card.locator('.replacement code')).toHaveText("getByRole('button', { name: 'Checkout' })");

    await panel.getByLabel('Filter the list').fill('checkout');
    await expect(panel.locator('li.row')).toHaveCount(1);
  });
});

test.describe('coverage overlay: what tests do on this page', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  test('This page counts what tests do here, and lists what they use here that finds nothing', async ({
    page,
    context,
  }) => {
    await stubCoverageChrome(context, { cached: shopIndex([...SHOP_TESTS, ...PAGE_TESTS]) });
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    let coverage = await readCoverage(page);
    expect(coverage).toMatchObject({ page: '/shop.html', pageScoped: true });

    // Only a locator tests use on /newsletter finds Subscribe: not tested here, and the row says why.
    expect(coverage.covered.some((c) => c.description === 'button "Subscribe"')).toBe(false);
    expect(coverage.uncovered.find((u) => u.description === 'button "Subscribe"')?.elsewhere).toEqual([
      "getByRole('button', { name: 'Subscribe' })",
    ]);
    // Uses with no recorded page count here, as before.
    expect(coverage.covered.some((c) => c.description === 'searchbox "Search products"')).toBe(true);

    // Used here and found nowhere: the one used as the page loads first. The negative assertion is never listed.
    expect(coverage.missing).toEqual([
      {
        locator: "getByRole('button', { name: 'Pay now' })",
        arrival: true,
        actions: ['click'],
        tests: ['pays in one click'],
      },
      {
        locator: "getByRole('menuitem', { name: 'Sign out' })",
        arrival: false,
        actions: ['click'],
        tests: ['signs out'],
      },
    ]);
    // Clicked here, and four buttons share the name: strict mode refuses the click.
    expect(coverage.several).toEqual([
      {
        locator: "getByRole('button', { name: 'Add to cart' })",
        count: 4,
        actions: ['click'],
        tests: ['adds the first mug it sees'],
      },
    ]);

    const panel = page.locator(`${HOST} .panel`);
    await expect(panel.locator('.sub')).toContainText('Acme Mugs · /shop.html');
    await panel.getByRole('button', { name: /^At risk \d+$/ }).click();
    await expect(panel.locator('.section-head')).toHaveText([
      'Missing here · 2',
      'Several match here · 1',
      /^Brittle locators · \d+$/,
    ]);
    const payNow = panel.locator('li.row', { hasText: "getByRole('button', { name: 'Pay now' })" });
    await expect(payNow.locator('.label')).toHaveText('Not found as the page loads');
    await expect(payNow.locator('.detail')).toHaveText('Click · tests/one-click.spec.ts:8:5 · chromium');

    // The card of the Blue mug's button gives the page of each use, and links to the Locators page of this page.
    await page.locator(`${HOST} .badge`).filter({ hasText: '2' }).first().click();
    const card = page.locator(`${HOST} .card.pinned`);
    await expect(card).toContainText('on /shop.html, as it loads');
    expect(await card.getByRole('link', { name: /Find these locators in Piwi/ }).getAttribute('href')).toContain(
      'page=%2Fshop.html',
    );

    // All pages: every locator that matches here counts, and the page's own risks go.
    await panel.getByRole('button', { name: 'All pages' }).click();
    coverage = await readCoverage(page);
    expect(coverage.pageScoped).toBe(false);
    expect(coverage.missing).toEqual([]);
    expect(coverage.covered.some((c) => c.description === 'button "Subscribe"')).toBe(true);
  });

  test('the rows show their locators as highlighted code', async ({ page, context }) => {
    await stubCoverageChrome(context, { cached: shopIndex([...SHOP_TESTS, ...PAGE_TESTS]) });
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const panel = page.locator(`${HOST} .panel`);
    const first = panel.locator('li.row .detail.mono').first().locator('.piwi-loc');
    await expect(first).toHaveText(/^(getBy|locator)/);
    await expect(first.locator('.piwi-tok-fn').first()).toBeAttached();

    await panel.getByRole('button', { name: /^Not tested \d+$/ }).click();
    const hint = panel.locator('li.row', { hasText: 'button "Subscribe"' }).locator('.detail', { hasText: 'Found by' });
    await expect(hint.locator('.piwi-loc')).toHaveText("getByRole('button', { name: 'Subscribe' })");
    await expect(hint.locator('.piwi-loc .piwi-tok-fn')).toHaveText('getByRole');
  });

  test('a row is a button the keyboard reaches, its own Copy locator beside it', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const panel = page.locator(`${HOST} .panel`);
    await panel.getByRole('button', { name: /^Not tested \d+$/ }).click();
    const row = panel.locator('li.row', { hasText: 'button "Subscribe"' });
    const select = row.getByRole('button', { name: 'button "Subscribe"', exact: true });
    await select.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(`${HOST} .card.pinned`)).toBeVisible();
    await expect(row.getByRole('button', { name: 'Copy locator' })).toBeVisible();
  });

  test('the collapsed pill says what tests will not find as the page loads', async ({ page, context }) => {
    await stubCoverageChrome(context, { cached: shopIndex([...SHOP_TESTS, ...PAGE_TESTS]) });
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    await page.locator(`${HOST} .panel`).getByRole('button', { name: 'Shrink the panel to a summary' }).click();
    await expect(page.locator(`${HOST} .pill`)).toContainText('1 missing here');
  });

  test('a client-side route change reads the new page', async ({ page, context }) => {
    await stubCoverageChrome(context, { cached: shopIndex([...SHOP_TESTS, ...PAGE_TESTS]) });
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    await page.evaluate(() => history.pushState({}, '', '/newsletter'));
    await expect.poll(async () => (await readCoverage(page)).page, { timeout: 10_000 }).toBe('/newsletter');
    await expect
      .poll(async () => (await readCoverage(page)).covered.some((c) => c.description === 'button "Subscribe"'))
      .toBe(true);
    // What tests use on /shop.html is elsewhere now.
    expect((await readCoverage(page)).missing).toEqual([]);
  });

  test('an index without pages keeps the view as it was, with no switch', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    expect(await readCoverage(page)).toMatchObject({ pageScoped: false, missing: [], several: [] });
    await expect(page.locator(`${HOST} .panel .page-switch`)).toHaveCount(0);
  });
});

test.describe('coverage overlay where the site and the tests use different path prefixes', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  const underApp = (pathPrefix?: string, testPathPrefix?: string) => ({
    ...DEFAULT_CONNECTION,
    projectMappings: [
      {
        ...DEFAULT_CONNECTION.projectMappings[0]!,
        ...(pathPrefix ? { pathPrefix } : {}),
        ...(testPathPrefix ? { testPathPrefix } : {}),
      },
    ],
  });

  test('This page removes the mapping’s prefix, then lists the uses of the route, missing and several here', async ({
    page,
    context,
  }) => {
    await stubCoverageChrome(context, {
      connection: underApp('/app'),
      cached: shopIndex([...SHOP_TESTS, ...PAGE_TESTS]),
    });
    await openShopUnder(page, '/app', '?nodialog');
    await injectCoverage(page);
    const coverage = await readCoverage(page);
    expect(coverage).toMatchObject({ page: '/shop.html', prefixRemoved: '/app', pageScoped: true });
    // What tests use on /shop.html counts here, and what they use on /newsletter does not.
    expect(coverage.covered.some((c) => c.description === 'button "Subscribe"')).toBe(false);
    expect(coverage.uncovered.find((u) => u.description === 'button "Subscribe"')?.elsewhere).toEqual([
      "getByRole('button', { name: 'Subscribe' })",
    ]);
    expect(coverage.missing.map((row) => row.locator)).toEqual([
      "getByRole('button', { name: 'Pay now' })",
      "getByRole('menuitem', { name: 'Sign out' })",
    ]);
    expect(coverage.several.map((row) => [row.locator, row.count])).toEqual([
      ["getByRole('button', { name: 'Add to cart' })", 4],
    ]);

    const panel = page.locator(`${HOST} .panel`);
    await expect(panel.locator('.sub')).toContainText('Acme Mugs · /shop.html (without /app)');
    await panel.locator('details.notes > summary').click();
    await expect(panel.locator('details.notes')).toContainText(
      'The path prefix /app of this site’s URL mapping was removed from the address first',
    );
  });

  test('the tests’ prefix is put in front when the tests ran the pages under a path the site does not use', async ({
    page,
    context,
  }) => {
    // The suite ran the shop under /app; this deployment serves it at the root.
    const index = shopIndex([...SHOP_TESTS, ...PAGE_TESTS]);
    const underTests = { ...index, pages: index.pages!.map((p) => `/app${p}`) };
    await stubCoverageChrome(context, {
      connection: {
        ...DEFAULT_CONNECTION,
        projectMappings: [{ ...DEFAULT_CONNECTION.projectMappings[0]!, testPathPrefix: '/app' }],
      },
      cached: underTests,
    });
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const coverage = await readCoverage(page);
    expect(coverage).toMatchObject({
      page: '/app/shop.html',
      prefixRemoved: null,
      prefixAdded: '/app',
      pageScoped: true,
    });
    expect(coverage.covered.some((c) => c.description === 'button "Subscribe"')).toBe(false);
    expect(coverage.missing.map((row) => row.locator)).toEqual([
      "getByRole('button', { name: 'Pay now' })",
      "getByRole('menuitem', { name: 'Sign out' })",
    ]);
    expect(coverage.several.map((row) => [row.locator, row.count])).toEqual([
      ["getByRole('button', { name: 'Add to cart' })", 4],
    ]);

    const panel = page.locator(`${HOST} .panel`);
    await expect(panel.locator('.sub')).toContainText('Acme Mugs · /app/shop.html (with /app added)');
    await panel.locator('details.notes > summary').click();
    await expect(panel.locator('details.notes')).toContainText(
      'The tests’ path prefix /app of this site’s URL mapping was put in front of the address first',
    );
  });

  test('one prefix swapped for the other: the site under /app, the tests under /v2', async ({ page, context }) => {
    const index = shopIndex([...SHOP_TESTS, ...PAGE_TESTS]);
    await stubCoverageChrome(context, {
      connection: underApp('/app', '/v2'),
      cached: { ...index, pages: index.pages!.map((p) => `/v2${p}`) },
    });
    await openShopUnder(page, '/app', '?nodialog');
    await injectCoverage(page);
    expect(await readCoverage(page)).toMatchObject({
      page: '/v2/shop.html',
      prefixRemoved: '/app',
      prefixAdded: '/v2',
      pageScoped: true,
    });
    expect((await readCoverage(page)).missing).toHaveLength(2);
    await expect(page.locator(`${HOST} .panel .sub`)).toContainText('/v2/shop.html (/app replaced by /v2)');
  });

  test('without the prefix, the page matches none the tests ran on', async ({ page, context }) => {
    await stubCoverageChrome(context, { connection: underApp(), cached: shopIndex([...SHOP_TESTS, ...PAGE_TESTS]) });
    await openShopUnder(page, '/app', '?nodialog');
    await injectCoverage(page);
    const coverage = await readCoverage(page);
    expect(coverage).toMatchObject({
      page: '/app/shop.html',
      prefixRemoved: null,
      prefixAdded: null,
      missing: [],
      several: [],
    });
  });
});

test.describe('coverage overlay in French', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  test('the panel, the cards and the At risk tab read in French', async ({ page, context }) => {
    await stubCoverageChrome(context, {
      language: 'fr',
      cached: shopIndex([...SHOP_TESTS, ...PAGE_TESTS]),
    });
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const panel = page.locator(`${HOST} .panel`);
    await expect(panel).toHaveAttribute('lang', 'fr');
    await expect(page.locator(`${HOST} .layer`)).toHaveAttribute('lang', 'fr');
    await expect(panel.locator('.title')).toHaveText('Éléments testés');
    await expect(panel.locator('.sub')).toContainText('Acme Mugs · /shop.html · Échap pour fermer');
    await expect(panel.getByRole('button', { name: 'Cette page' })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.locator('.meter-label')).toContainText('éléments trouvés, dont');
    await expect(panel.getByRole('button', { name: 'Limiter à un élément' })).toBeVisible();
    expect(await clippedInShadows(page)).toEqual([]);

    await panel.getByRole('button', { name: /^Tests \d+$/ }).click();
    await expect(panel.locator('li.row', { hasText: 'shows prices' })).toContainText('7 éléments');

    await panel.getByRole('button', { name: /^À risque \d+$/ }).click();
    await expect(panel.locator('.section-head')).toHaveText([
      'Introuvables ici · 2',
      'Plusieurs trouvés ici · 1',
      /^Locators fragiles · \d+$/,
    ]);
    const payNow = panel.locator('li.row', { hasText: "getByRole('button', { name: 'Pay now' })" });
    await expect(payNow.locator('.label')).toHaveText('Introuvable au chargement de la page');
    expect(await clippedInShadows(page)).toEqual([]);

    // The card of the Blue mug's button: page texts and locators stay as they are.
    await page.locator(`${HOST} .badge`).filter({ hasText: '2' }).first().click();
    const card = page.locator(`${HOST} .card.pinned`);
    await expect(card).toContainText('button "Add to cart"');
    await expect(card).toContainText('Manipulé par 2 tests');
    await expect(card).toContainText('sur /shop.html, au chargement');
    await expect(card.getByRole('link', { name: /Trouver ces locators dans Piwi/ })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Fermer' })).toBeVisible();
    expect(await clippedInShadows(page)).toEqual([]);

    await panel.getByRole('button', { name: 'Réduire le panneau à un résumé' }).click();
    await expect(page.locator(`${HOST} .pill`)).toContainText(/Piwi · \d+\/\d+ testés · \d+ tests · 1 introuvable ici/);
  });

  test('the states before the page is checked read in French', async ({ page, context }) => {
    await stubCoverageChrome(context, { language: 'fr', connection: null, cached: null });
    await openShop(page, '?nodialog');
    await injectCoverage(page, 'not-connected');
    const panel = page.locator(`${HOST} .panel`);
    await expect(panel).toContainText('Piwi Picker n’est pas encore connecté à votre instance Piwi');
    await expect(panel.getByRole('button', { name: 'Ouvrir les réglages de Piwi Picker' })).toBeVisible();
    expect(await clippedInShadows(page)).toEqual([]);
  });
});

test.describe('coverage overlay in German', () => {
  const catalog = readCatalog('de');
  const escape = (text: string) => text.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  /** A message with a `$count$` placeholder, as a pattern that takes any count. */
  const counted = (key: string) => new RegExp(`^${catalog[key]!.message.split('$count$').map(escape).join('\\d+')}$`);

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  test('the panel, the tabs, a card and the summary lay out without clipping', async ({ page, context }) => {
    await stubCoverageChrome(context, {
      language: 'de',
      cached: shopIndex([...SHOP_TESTS, ...PAGE_TESTS]),
    });
    await openShop(page, '?nodialog');
    await injectCoverage(page);
    const panel = page.locator(`${HOST} .panel`);
    await expect(panel).toHaveAttribute('lang', 'de');
    await expect(page.locator(`${HOST} .layer`)).toHaveAttribute('lang', 'de');
    expect(await clippedInShadows(page)).toEqual([]);

    await panel.getByRole('button', { name: counted('coverage_tabTests') }).click();
    await expect(panel.locator('li.row', { hasText: 'shows prices' })).toBeVisible();
    expect(await clippedInShadows(page)).toEqual([]);

    await panel.getByRole('button', { name: counted('coverage_tabRisk') }).click();
    await expect(panel.locator('.section-head')).toHaveCount(3);
    expect(await clippedInShadows(page)).toEqual([]);

    await page.locator(`${HOST} .badge`).filter({ hasText: '2' }).first().click();
    await expect(page.locator(`${HOST} .card.pinned`)).toContainText('button "Add to cart"');
    expect(await clippedInShadows(page)).toEqual([]);

    await panel.getByRole('button', { name: catalog.coverage_collapse!.message }).click();
    await expect(page.locator(`${HOST} .pill`)).toBeVisible();
    expect(await clippedInShadows(page)).toEqual([]);
  });

  test('the states before the page is checked lay out without clipping', async ({ page, context }) => {
    await stubCoverageChrome(context, { language: 'de', connection: null, cached: null });
    await openShop(page, '?nodialog');
    await injectCoverage(page, 'not-connected');
    await expect(page.locator(`${HOST} .panel`)).toHaveAttribute('lang', 'de');
    expect(await clippedInShadows(page)).toEqual([]);
  });
});
