import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import {
  BRITTLE_TESTS,
  CARD_TEST,
  DEFAULT_CONNECTION,
  DIST,
  INSTANCE_URL,
  PAGE_TESTS,
  SHOP_TESTS,
  injectCoverage,
  openShop,
  readCoverage,
  shopIndex,
  stubCoverageChrome,
} from './coverage-fixtures.js';
import { stubChromeI18n } from './i18n-stub.js';
import { clippedInShadows } from './shadow.js';

/**
 * The pick results panel in connected mode: "Copy all" puts every ranked
 * locator on the clipboard, and a Piwi section lists the project's tests
 * whose locators reach the picked element on this page.
 */

const RESULTS = '#piwi-picker-results-host';

const activeTool = (page: Page) =>
  page.evaluate(() => (globalThis as { __piwiActiveTool?: { id: string } }).__piwiActiveTool?.id ?? null);

/** Pick an element; `up` walks that many steps to its containers before the click commits. */
async function pick(page: Page, selector: string, up = 0): Promise<void> {
  await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
  await expect(page.locator('#__piwi_picker_banner')).toBeVisible();
  await page.hover(selector);
  for (let i = 0; i < up; i++) await page.keyboard.press('ArrowUp');
  await page.click(selector);
  // The anchors step's Skip, in the language the test runs in.
  const skip = page.getByRole('button', { name: /\((Esc|Échap)\)$/ });
  const results = page.locator(`${RESULTS} .panel`);
  await expect(skip.or(results)).toBeVisible();
  if (await skip.isVisible()) await skip.click();
  await expect(results).toBeVisible();
}

test.describe('pick results in connected mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  test('lists the tests reaching the picked element, with links into Piwi', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await pick(page, 'article:has-text("Blue mug") button.primary');

    const section = page.locator(`${RESULTS} .piwi`);
    await expect(section).toContainText('Reached by 2 tests of Acme Mugs');
    await expect(section.getByRole('link', { name: 'catalog › adds a mug to the cart' })).toHaveAttribute(
      'href',
      `${INSTANCE_URL}/test-cases/101`,
    );
    await expect(section).toContainText('catalog › filters in-stock products');
    const find = section.getByRole('link', { name: /Find these locators in Piwi/ });
    expect(await find.getAttribute('href')).toContain(`${INSTANCE_URL}/projects/1/locators?q=`);
    const report = await page.evaluate(
      () => (globalThis as unknown as { __piwiPickCoverage: { status: string; tests: string[] } }).__piwiPickCoverage,
    );
    expect(report).toMatchObject({ status: 'ready', tests: ['adds a mug to the cart', 'filters in-stock products'] });

    await section.getByRole('button', { name: 'Show every tested element' }).click();
    const sent = await page.evaluate(
      () => (globalThis as unknown as { __piwiTestSent: Array<{ type: string }> }).__piwiTestSent,
    );
    expect(sent.map((m) => m.type)).toContain('piwi-open-coverage');
  });

  test('Show every tested element hands over to the overlay, and a pick starts again once it is closed', async ({
    page,
    context,
  }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await pick(page, 'article:has-text("Blue mug") button.primary');
    const section = page.locator(`${RESULTS} .piwi`);
    await expect(section).toContainText('Reached by 2 tests of Acme Mugs');

    await section.getByRole('button', { name: 'Show every tested element' }).click();
    await expect(page.locator(RESULTS)).toHaveCount(0);
    // What the worker does on `piwi-open-coverage`.
    await injectCoverage(page);
    await expect(page.locator('#piwi-coverage-host')).toBeAttached();
    expect(await activeTool(page)).toBe('coverage-overlay');
    await expect(page.locator('#piwi-coverage-host .panel')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('#piwi-coverage-host')).toHaveCount(0);
    await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
    await expect(page.getByText('click any element to generate locators')).toBeVisible();
    expect(await activeTool(page)).toBe('pick');
  });

  test('tells the tests reaching the element from those reaching a container around it', async ({ page, context }) => {
    await stubCoverageChrome(context, { cached: shopIndex([...SHOP_TESTS, CARD_TEST]) });
    await openShop(page, '?nodialog');
    await pick(page, 'article:has-text("Blue mug") button.primary');

    const section = page.locator(`${RESULTS} .piwi`);
    await expect(section).toContainText('Reached by 2 tests of Acme Mugs');
    await expect(section.locator('.group').first()).toHaveText('This element');
    await expect(section.locator('.group').nth(1)).toContainText('Around it · article.card "Blue mug');
    await expect(section.getByRole('link', { name: 'catalog › shows the Blue mug card' })).toBeVisible();
    const report = await page.evaluate(
      () => (globalThis as unknown as { __piwiPickCoverage: Record<string, unknown> }).__piwiPickCoverage,
    );
    expect(report).toMatchObject({
      tests: ['adds a mug to the cart', 'filters in-stock products'],
      inside: [],
      around: ['shows the Blue mug card'],
    });

    // "Show tested elements inside it" hands the element over to the overlay the worker injects.
    await section.getByRole('button', { name: 'Show tested elements inside it' }).click();
    const sent = await page.evaluate(
      () => (globalThis as unknown as { __piwiTestSent: Array<{ type: string }> }).__piwiTestSent,
    );
    expect(sent.map((m) => m.type)).toContain('piwi-open-coverage');
    await injectCoverage(page);
    expect((await readCoverage(page)).scope).toBe('button "Add to cart"');
    await expect(page.locator('#piwi-coverage-host')).toBeAttached();
    await expect(page.locator(RESULTS)).toHaveCount(0);
  });

  test('counts what tests reach inside a picked container', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    // From the Deals link up to the navigation landmark around it.
    await pick(page, 'nav >> text=Deals', 3);
    const section = page.locator(`${RESULTS} .piwi`);
    await expect(section).toContainText('Reached by 1 test of Acme Mugs');
    await expect(section.locator('.group').first()).toHaveText('Inside it · 1 element');
    const report = await page.evaluate(
      () => (globalThis as unknown as { __piwiPickCoverage: Record<string, unknown> }).__piwiPickCoverage,
    );
    expect(report).toMatchObject({ tests: ['visits the deals'], inside: ['visits the deals'], around: [] });
  });

  test('answers for the branch the URL mapping names', async ({ page, context }) => {
    await stubCoverageChrome(context, {
      connection: {
        ...DEFAULT_CONNECTION,
        projectMappings: [{ ...DEFAULT_CONNECTION.projectMappings[0]!, branch: 'develop' }],
      },
      cachedBranches: { develop: shopIndex(SHOP_TESTS, { branch: 'develop' }) },
    });
    await openShop(page, '?nodialog');
    await pick(page, 'article:has-text("Blue mug") button.primary');
    const section = page.locator(`${RESULTS} .piwi`);
    await expect(section).toContainText('Reached by 2 tests of Acme Mugs on develop');
    const find = section.getByRole('link', { name: /Find these locators in Piwi/ });
    expect(await find.getAttribute('href')).toContain('&branch=develop');
  });

  test('names the brittle locators finding the picked element', async ({ page, context }) => {
    await stubCoverageChrome(context, { cached: shopIndex([...SHOP_TESTS, ...BRITTLE_TESTS]) });
    await openShop(page, '?nodialog');
    await pick(page, 'aside.cart > button');

    const section = page.locator(`${RESULTS} .piwi`);
    await expect(section).toContainText('Reached by 2 tests of Acme Mugs');
    await expect(section.locator('.brittle')).toHaveText(
      "Brittle locator: locator('aside.cart > button') · CSS class · CSS structure",
    );
    const report = await page.evaluate(
      () => (globalThis as unknown as { __piwiPickCoverage: { brittle: string[] } }).__piwiPickCoverage,
    );
    expect(report.brittle).toEqual(["locator('aside.cart > button')"]);
  });

  test('counts what tests do on this page, as Tested elements does', async ({ page, context }) => {
    await stubCoverageChrome(context, { cached: shopIndex([...SHOP_TESTS, ...PAGE_TESTS]) });
    await openShop(page, '?nodialog');
    // A test clicks a Subscribe button, but on /newsletter: not this one.
    await pick(page, '.newsletter button');
    const section = page.locator(`${RESULTS} .piwi`);
    await expect(section).toContainText('Not reached by any test of Acme Mugs');
  });

  test('says so when no test reaches the picked element', async ({ page, context }) => {
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await pick(page, 'button[aria-label="Add Red mug to wishlist"]');
    await expect(page.locator(`${RESULTS} .piwi`)).toContainText('Not reached by any test of Acme Mugs');
  });

  test('copies every ranked locator, one per line', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://shop.test' });
    await stubCoverageChrome(context);
    await openShop(page, '?nodialog');
    await pick(page, 'form.newsletter button');
    const copyAll = page.locator(`${RESULTS} .panel`).getByTitle(/Copy every locator, one per line/);
    await expect(copyAll).toHaveText(/^Copy all \d+$/);
    const count = Number((await copyAll.textContent())!.replace(/\D/g, ''));
    await copyAll.click();
    await expect(copyAll).toHaveText('Copied');
    const lines = (await page.evaluate(() => navigator.clipboard.readText())).split('\n');
    expect(lines).toHaveLength(count);
    expect(lines).toContain("getByRole('button', { name: 'Subscribe' })");
  });

  test('Add to session keeps the locator as the Session tab lists it', async ({ page, context }) => {
    await stubCoverageChrome(context, { connection: null, cached: null });
    await openShop(page, '?nodialog');
    await pick(page, 'form.newsletter button');
    const row = page.locator(`${RESULTS} .row`).first();
    const locator = (await row.locator('code').first().textContent())!;
    const stored = () =>
      page.evaluate(async () => {
        const area = (globalThis as unknown as { chrome: typeof chrome }).chrome.storage.session;
        return (await area.get('piwiPickSession')).piwiPickSession ?? null;
      });

    const add = row.getByRole('button', { name: 'Add to session' });
    await add.click();
    const name = row.getByRole('textbox', { name: 'Name for this element' });
    await expect(name).toBeFocused();
    // Escape closes the form alone: the results stay open.
    await page.keyboard.press('Escape');
    await expect(name).toHaveCount(0);
    await expect(add).toBeFocused();
    await expect(page.locator(`${RESULTS} .panel`)).toBeVisible();

    await add.click();
    await name.fill('2fast');
    await name.press('Enter');
    await expect(row.locator('.form-message')).toHaveText(
      'Use only letters without accents, digits, _ or $, and do not start with a digit.',
    );
    await name.fill('subscribeButton');
    await name.press('Enter');
    await expect(row.locator('.confirm')).toHaveText('Added to the session as subscribeButton.');
    expect(await stored()).toEqual([{ name: 'subscribeButton', locator, pageUrl: page.url() }]);

    // A name already in the list is refused.
    await add.click();
    await name.fill('subscribeButton');
    await name.press('Enter');
    await expect(row.locator('.form-message')).toHaveText('"subscribeButton" is already in the list.');
    expect(await stored()).toHaveLength(1);
  });

  test('stays out of the way when the extension is not connected', async ({ page, context }) => {
    await stubCoverageChrome(context, { connection: null, cached: null });
    await openShop(page, '?nodialog');
    await pick(page, 'form.newsletter button');
    await expect(page.locator(`${RESULTS} .piwi`)).toBeHidden();
  });

  test('speaks French in a French browser, and leaves page texts and locators as they are', async ({
    page,
    context,
  }) => {
    await stubCoverageChrome(context, { cached: shopIndex([...SHOP_TESTS, ...BRITTLE_TESTS]) });
    await stubChromeI18n(context, 'fr');
    await openShop(page, '?nodialog');
    await pick(page, 'aside.cart > button');

    const panel = page.locator(`${RESULTS} .panel`);
    await expect(panel).toHaveAttribute('lang', 'fr');
    await expect(panel.locator('.title')).toHaveText(/^\d+ locators$/);
    await expect(panel.locator('.order')).toHaveText(
      'Classés du plus stable au moins stable, ceux qui trouvent cet élément seul en premier',
    );
    await expect(panel.locator('.row .word').first()).toHaveText(
      /^(stable|peut casser|fragile|unique par sa position|\d+ correspondances?|non vérifié)$/,
    );
    await expect(panel.getByRole('button', { name: /^Tout copier \(\d+\)$/ })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Locator', exact: true }).first()).toBeVisible();
    const section = page.locator(`${RESULTS} .piwi`);
    await expect(section).toContainText('Atteint par 2 tests du projet Acme Mugs');
    await expect(section.locator('.brittle')).toHaveText(
      "Locator fragile\u00a0: locator('aside.cart > button') · classe CSS · structure CSS",
    );
    await expect(section.getByRole('link', { name: 'Chercher ces locators dans Piwi ↗' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Voir tous les éléments testés' })).toBeVisible();
  });

  test('lays out in German without clipping', async ({ page, context }) => {
    await stubCoverageChrome(context, { cached: shopIndex([...SHOP_TESTS, ...BRITTLE_TESTS]) });
    await stubChromeI18n(context, 'de');
    await openShop(page, '?nodialog');
    await pick(page, 'aside.cart > button');

    await expect(page.locator(`${RESULTS} .panel`)).toHaveAttribute('lang', 'de');
    await expect(page.locator(`${RESULTS} .piwi .brittle`)).toBeVisible();
    expect(await clippedInShadows(page)).toEqual([]);
  });
});
