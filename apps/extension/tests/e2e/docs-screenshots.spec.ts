import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { test as base, expect, launchWithExtension } from './fixtures.js';
import type { BrowserContext, Page } from '@playwright/test';
import type { RawCaptureEvent } from '@piwitests/core/recording';
import { DIST, SHOP_ORIGIN, injectCoverage, openShop, stubCoverageChrome } from './coverage-fixtures.js';
import { openDevtoolsPage, selectElement } from './devtools-stub.js';
import { stubChromeI18n } from './i18n-stub.js';
import { stubChromeStorage } from './recording-stub.js';

/**
 * The extension's illustrations on the docs site, captured from the same shop
 * page and locator index the overlay specs drive. Skipped unless
 * `PIWI_DOCS_SHOTS=1`; recapture with
 * `PIWI_DOCS_SHOTS=1 npm run extension:test:e2e -- docs-screenshots`.
 *
 * The store images (`picker-pick`, `picker-popup`, `picker-lint`,
 * `picker-record`) are a 1280 × 800 viewport captured at 2× and written at
 * 1280 px wide, the size the stores take; the overlay and the DevTools pane
 * are the docs' alone, at their own sizes. The harness in
 * `apps/application/scripts/take-feature-screenshots.mjs` lists them all as
 * external so `--check` leaves them alone.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.join(here, '..', '..', '..', 'docs', 'public', 'screenshots');
const VIEWPORT = { width: 1280, height: 800 };

/** The browser renders at 2×, so the text stays crisp once an image is shown at its CSS width. */
const test = base.extend<{ context: BrowserContext }>({
  context: async ({ browserLanguage }, use) => {
    const context = await launchWithExtension(undefined, { language: browserLanguage, deviceScaleFactor: 2 });
    await use(context);
    await context.close();
  },
});

test.skip(!process.env.PIWI_DOCS_SHOTS, 'captures docs illustrations only when PIWI_DOCS_SHOTS=1');

/** Captures the viewport and writes it at `width`, its CSS width unless the image is meant to be shown larger. */
async function shoot(page: Page, name: string, width = VIEWPORT.width): Promise<void> {
  await sharp(await page.screenshot())
    .resize({ width })
    .png()
    .toFile(path.join(SCREENSHOTS, `${name}.png`));
}

async function shopPage(context: BrowserContext, query = '?nodialog'): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(VIEWPORT);
  await openShop(page, query);
  return page;
}

test('tested-elements-overlay', async ({ page, context }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await stubCoverageChrome(context);
  await openShop(page, '?nodialog');
  await injectCoverage(page);
  await page.waitForTimeout(500);
  await shoot(page, 'tested-elements-overlay', 1400);
});

test('picker-pick', async ({ context }) => {
  await stubChromeI18n(context);
  const page = await shopPage(context);
  await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
  await expect(page.getByText('click any element to generate locators')).toBeVisible();

  const checkout = page.getByRole('button', { name: 'Checkout' });
  await checkout.hover();
  await checkout.click();
  // When a stable parent is offered, the anchors step opens first: the ranked locators follow.
  const results = () => page.evaluate(() => !!document.getElementById('piwi-picker-results-host'));
  const skip = page.getByRole('button', { name: 'Skip (Esc)' });
  await expect.poll(async () => (await results()) || (await skip.isVisible())).toBe(true);
  if (await skip.isVisible()) await skip.click();
  await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-picker-results-host'))).toBe(true);
  await page.waitForTimeout(500);
  await shoot(page, 'picker-pick');
});

test('picker-popup', async ({ context, extensionId }) => {
  const shop = await shopPage(context);
  const backdrop = await shop.screenshot();

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 480, height: 640 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#pick-shortcut')).not.toBeEmpty();
  await popup.waitForTimeout(300);
  const body = popup.locator('body');
  const box = (await body.boundingBox())!;
  const panel = await body.screenshot();
  const { width, height } = { width: Math.round(box.width * 2), height: Math.round(box.height * 2) };

  // The popup as it hangs under the toolbar icon: top right, over the page, with its shadow.
  const { width: canvasWidth = 0, height: canvasHeight = 0 } = await sharp(backdrop).metadata();
  const canvas = { width: canvasWidth, height: canvasHeight };
  const margin = 24;
  const left = canvas.width - width - margin * 2;
  const top = margin;
  // The shadow's rectangle composited on a transparent canvas, then blurred in a second pipeline: sharp blurs
  // before it composites in one.
  const rectangle = await sharp({
    create: { width, height, channels: 4, background: { r: 15, g: 23, b: 42, alpha: 0.35 } },
  })
    .png()
    .toBuffer();
  const shadow = await sharp(
    await sharp({ create: { ...canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: rectangle, left, top: top + 8 }])
      .png()
      .toBuffer(),
  )
    .blur(28)
    .png()
    .toBuffer();
  const framed = await sharp(panel)
    .extend({ top: 2, bottom: 2, left: 2, right: 2, background: { r: 203, g: 213, b: 225, alpha: 1 } })
    .png()
    .toBuffer();
  // Composited at 2×, then resized: sharp resizes before it composites in one pipeline.
  const composed = await sharp(backdrop)
    .composite([
      { input: shadow, left: 0, top: 0 },
      { input: framed, left: left - 2, top: top - 2 },
    ])
    .png()
    .toBuffer();
  await sharp(composed).resize({ width: VIEWPORT.width }).png().toFile(path.join(SCREENSHOTS, 'picker-popup.png'));
});

test('picker-record', async ({ context }) => {
  const at = (ms: number) => 1_700_000_000_000 + ms;
  const target = (
    tagName: string,
    role: string | null,
    accessibleName: string | null,
    alternatives: Array<[string, string, number]>,
    extra: Partial<RawCaptureEvent['target'] & object> = {},
  ) => ({
    tagName,
    role,
    accessibleName,
    testId: null,
    text: accessibleName,
    alternatives: alternatives.map(([locator, method, score]) => ({ locator, method, score })),
    ...extra,
  });
  const event = (
    kind: RawCaptureEvent['kind'],
    t: RawCaptureEvent['target'],
    ms: number,
    value: string | null = null,
  ) =>
    ({
      kind,
      target: t,
      value,
      checked: null,
      inputType: null,
      isPasswordField: false,
      pageUrl: `${SHOP_ORIGIN}/shop.html`,
      timestamp: at(ms),
    }) satisfies RawCaptureEvent;
  const events: RawCaptureEvent[] = [
    { ...event('viewport', null, 0), viewport: VIEWPORT },
    event(
      'input',
      target('input', 'searchbox', 'Search products', [
        ["getByPlaceholder('Search products')", 'getByPlaceholder', 92],
      ]),
      800,
      'mug',
    ),
    event(
      'click',
      target('button', 'button', 'Search', [["getByRole('button', { name: 'Search' })", 'getByRole', 96]]),
      1_400,
    ),
    event(
      'click',
      target('button', 'button', 'Add to cart', [
        [
          "getByTestId('product-card').filter({ hasText: 'Blue mug' }).getByRole('button', { name: 'Add to cart' })",
          'getByRole',
          88,
        ],
        ["getByRole('button', { name: 'Add to cart' }).first()", 'getByRole', 40],
      ]),
      3_100,
    ),
    event(
      'click',
      target(
        'button',
        'button',
        'Cart, 3 items',
        [["getByRole('button', { name: /Cart, \\d+ items?/ })", 'getByRole', 90]],
        { testId: 'cart-button' },
      ),
      4_600,
    ),
    event(
      'input',
      target('input', 'textbox', 'Coupon code', [["getByLabel('Coupon code')", 'getByLabel', 94]]),
      6_200,
      'MORNING10',
    ),
    event(
      'click',
      target('button', 'button', 'Apply', [["getByRole('button', { name: 'Apply' })", 'getByRole', 96]]),
      6_900,
    ),
    event(
      'click',
      target('button', 'button', 'Checkout', [["getByRole('button', { name: 'Checkout' })", 'getByRole', 96]]),
      8_300,
    ),
  ];
  await stubChromeStorage(context, {
    session: { piwiRecording: { active: false, events, startedAt: at(0), grantedOriginPattern: `${SHOP_ORIGIN}/*` } },
  });
  const page = await shopPage(context);
  await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
  await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-review-host'))).toBe(true);
  await page.waitForTimeout(500);
  await shoot(page, 'picker-record');
});

test('picker-lint', async ({ context }) => {
  await stubChromeI18n(context);
  const page = await shopPage(context);
  // Wishlist buttons drawn as an unnamed icon: the case the lint overlay exists for.
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('button[aria-label$="to wishlist"]')) {
      button.removeAttribute('aria-label');
      button.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9z"/></svg>';
    }
  });
  await page.addScriptTag({ path: path.join(DIST, 'lint-overlay.js') });
  await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-lint-overlay-host'))).toBe(true);
  await page.waitForTimeout(500);
  await shoot(page, 'picker-lint');
});

test('picker-devtools', async ({ context, extensionId }) => {
  const shop = await shopPage(context);
  await shop.addScriptTag({ path: path.join(DIST, 'devtools-rank.js') });
  const sidebar = await openDevtoolsPage(context, extensionId, 'devtools-sidebar.html', shop);
  await sidebar.setViewportSize({ width: 440, height: 360 });
  await expect(sidebar.getByText('Select an element in the Elements panel')).toBeVisible();
  await selectElement(sidebar, shop, '[data-testid="cart-button"]');
  await expect(sidebar.getByRole('heading', { name: 'button · Cart, 2 items' })).toBeVisible();
  await sidebar.waitForTimeout(500);
  await shoot(sidebar, 'picker-devtools', 880);
});
