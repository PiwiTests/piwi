import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { test as base, expect, launchWithExtension } from './fixtures.js';
import type { BrowserContext, Page } from '@playwright/test';
import type { RawCaptureEvent } from '@piwitests/core/recording';
import { showPauseBar } from '@piwitests/picker-dom';
import { DIST, SHOP_ORIGIN, injectCoverage, openShop, stubCoverageChrome } from './coverage-fixtures.js';
import { openDevtoolsPage, selectElement } from './devtools-stub.js';
import { stubChromeI18n } from './i18n-stub.js';
import { stubChromeStorage } from './recording-stub.js';
import { openShadowRoots } from './shadow.js';
import { routeShop, SHOP_ORIGIN as BUG_SHOP_ORIGIN } from './bug-shop.js';
import { stubChrome as stubReplayChrome } from './replay-stub.js';
import type { PiwiSteps } from '@piwitests/core/steps';
import {
  answerNext,
  pairedExtension,
  startEditor,
  startRun,
  RUN_TAKES,
  VIEWPORT as STOP_VIEWPORT,
} from './runs-fixtures.js';

/**
 * The extension's illustrations on the docs site, captured from the same shop
 * page and locator index the overlay specs drive. Skipped unless
 * `PIWI_DOCS_SHOTS=1`; recapture with
 * `PIWI_DOCS_SHOTS=1 npm run extension:test:e2e -- docs-screenshots`.
 *
 * The store images (`picker-pick`, `picker-popup`, `picker-lint`,
 * `picker-record`) are a 1280 × 800 viewport captured at 2× and written at
 * 1280 px wide, the size the stores take; the overlay and the DevTools pane
 * are the docs' alone, at their own sizes. `picker-pause` is the docs' too:
 * the reporter's pause bar, at the stores' size, and so is `picker-runs`, the Runs window beside a test stopped there,
 * against the real editor service's hub. `picker-runs-live` is the Runs window alone, at 2×, watching a headless stop
 * live. The harness in
 * `apps/application/scripts/take-feature-screenshots.mjs` lists them all as
 * external so `--check` leaves them alone.
 *
 * The loops (`public/videos/picker-*.mp4`) are short muted videos of a tool in use: the page recorded by Playwright,
 * a pointer drawn on it (a recorded video leaves the mouse out), the opening trimmed, then encoded with an ffmpeg that
 * has libx264 (`FFMPEG`, else `ffmpeg` on the PATH; Playwright's own has VP8 alone).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.join(here, '..', '..', '..', 'docs', 'public', 'screenshots');
const VIEWPORT = { width: 1280, height: 800 };
/** A one-pixel PNG: the screenshot a stubbed capture answers with. */
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const VIDEOS = path.join(here, '..', '..', '..', 'docs', 'public', 'videos');
/** A loop's page: narrower than a screenshot's, so the tool stays legible in the docs column. */
const LOOP_VIEWPORT = { width: 1024, height: 640 };

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

/**
 * Writes `name`: `panel`, a page rendered at 2× whose CSS size is `box`, framed with its shadow over `backdrop`, at
 * the right, `top` CSS pixels down, as a popup or a window beside the page shows, then the whole at the stores' width.
 */
async function framedOver(
  backdrop: Buffer,
  panel: Buffer,
  box: { width: number; height: number },
  name: string,
  top = 12,
): Promise<void> {
  const { width, height } = { width: Math.round(box.width * 2), height: Math.round(box.height * 2) };
  const { width: canvasWidth = 0, height: canvasHeight = 0 } = await sharp(backdrop).metadata();
  const canvas = { width: canvasWidth, height: canvasHeight };
  const margin = 24;
  const left = canvas.width - width - margin * 2;
  const y = top * 2;
  // The shadow's rectangle composited on a transparent canvas, then blurred in a second pipeline: sharp blurs
  // before it composites in one.
  const rectangle = await sharp({
    create: { width, height, channels: 4, background: { r: 15, g: 23, b: 42, alpha: 0.35 } },
  })
    .png()
    .toBuffer();
  const shadow = await sharp(
    await sharp({ create: { ...canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: rectangle, left, top: y + 8 }])
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
      { input: framed, left: left - 2, top: y - 2 },
    ])
    .png()
    .toBuffer();
  await sharp(composed)
    .resize({ width: VIEWPORT.width })
    .png()
    .toFile(path.join(SCREENSHOTS, `${name}.png`));
}

/**
 * Writes `name`: `panel`, a page rendered at 2× whose CSS size is `box`, framed with its shadow on a plain backdrop
 * just larger than it, at 2×: a window of its own with nothing beside it.
 */
async function framedAlone(panel: Buffer, box: { width: number; height: number }, name: string): Promise<void> {
  const margin = 48;
  const { width, height } = { width: Math.round(box.width * 2), height: Math.round(box.height * 2) };
  const canvas = { width: width + margin * 2, height: height + margin * 2 };
  const backdrop = { r: 226, g: 232, b: 240, alpha: 1 };
  const rectangle = await sharp({
    create: { width, height, channels: 4, background: { r: 15, g: 23, b: 42, alpha: 0.3 } },
  })
    .png()
    .toBuffer();
  const shadow = await sharp(
    await sharp({ create: { ...canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: rectangle, left: margin, top: margin + 8 }])
      .png()
      .toBuffer(),
  )
    .blur(24)
    .png()
    .toBuffer();
  const framed = await sharp(panel)
    .extend({ top: 2, bottom: 2, left: 2, right: 2, background: { r: 203, g: 213, b: 225, alpha: 1 } })
    .png()
    .toBuffer();
  await sharp({ create: { ...canvas, channels: 4, background: backdrop } })
    .composite([
      { input: shadow, left: 0, top: 0 },
      { input: framed, left: margin - 2, top: margin - 2 },
    ])
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
  // The popup as it hangs under the toolbar icon: top right, over the page.
  await framedOver(backdrop, await body.screenshot(), box, 'picker-popup');
});

// The pause bar of a test paused at a breakpoint in a run the editor started: the reporter's, on the shop page, with
// the element of the paused action highlighted as Playwright highlights it, and Record here offered.
test('picker-pause', async ({ context }) => {
  const page = await shopPage(context);
  await page.getByRole('button', { name: 'Checkout' }).highlight();
  await page.evaluate(showPauseBar, {
    place: 'cart.spec.ts:12',
    attempt: null,
    action: 'click',
    locator: "getByRole('button', { name: 'Checkout' })",
    record: true,
  });
  const bar = page.getByRole('toolbar', { name: 'Piwi: test paused' });
  await bar.getByRole('button', { name: 'Record here' }).hover();
  await page.waitForTimeout(500);
  await shoot(page, 'picker-pause');
});

/** What the reporter's image of a stopped page leaves out: its pause bar (`BAR_HIDDEN`, the run channel's). */
const BAR_HIDDEN = '#__piwi-pause-bar { display: none !important; }';

// The Runs window beside the test's browser, the test stopped at a breakpoint before a click on Checkout, with the
// pause bar in its page: the real editor service's hub, a worker the spec plays, whose reporter takes the code from a
// stop, the page's image as the worker sends it, without the bar.
test('picker-runs', async () => {
  const editor = await startEditor();
  const { context, extensionId } = await pairedExtension(editor, { deviceScaleFactor: 2 });
  try {
    const shop = await shopPage(context);
    await shop.getByRole('button', { name: 'Checkout' }).highlight();
    await shop.evaluate(showPauseBar, {
      place: 'cart.spec.ts:12',
      attempt: null,
      action: 'click',
      locator: "getByRole('button', { name: 'Checkout' })",
      record: true,
    });
    await shop.waitForTimeout(300);
    const backdrop = await shop.screenshot();
    const image = (await shop.screenshot({ type: 'jpeg', quality: 70, scale: 'css', style: BAR_HIDDEN })).toString(
      'base64',
    );

    const runs = await context.newPage();
    await runs.setViewportSize({ width: 440, height: 700 });
    await runs.goto(`chrome-extension://${extensionId}/runs.html`);
    const run = await startRun(editor, 'pays with a coupon', [...RUN_TAKES]);
    try {
      await expect(runs.getByText('cart › pays with a coupon')).toBeVisible();
      run.worker.send({
        type: 'stopped',
        stop: 1,
        reason: 'breakpoint',
        title: "Click getByRole('button', { name: 'Checkout' })",
        place: { file: 'tests/cart.spec.ts', line: 12, column: 5 },
        locator: "getByRole('button', { name: 'Checkout' })",
        bar: true,
      });
      const asked = await run.worker.next('request');
      run.worker.send({
        type: 'answer',
        request: asked.request,
        what: 'image',
        value: { mime: 'image/jpeg', data: image },
      });
      await expect(runs.getByRole('img')).toBeVisible();
      // The service under test names itself after its test client: the window shows the editor's name.
      await runs.locator('.client').evaluate((client) => (client.textContent = 'Visual Studio Code'));
      await runs.getByRole('button', { name: 'Resume' }).hover();
      await runs.waitForTimeout(300);
      const body = runs.locator('body');
      // Below the pause bar, whose buttons answer the same stop.
      await framedOver(backdrop, await body.screenshot(), (await body.boundingBox())!, 'picker-runs', 64);
    } finally {
      run.worker.socket.destroy();
    }
  } finally {
    await context.close();
    await editor.close();
  }
});

// The Runs window at a headless stop, watched live: the frames of a page nobody else sees, the picker its Pick started
// there, driven through the view, with the keys and clicks going to the page; the real editor service's hub, a worker
// the spec plays, whose frames are the shop page as the reporter's view paints it.
test('picker-runs-live', async ({ context }) => {
  await stubChromeI18n(context);
  const shop = await shopPage(context);
  const jpeg = async () => (await shop.screenshot({ type: 'jpeg', quality: 60, scale: 'css' })).toString('base64');
  const image = await jpeg();
  await shop.addScriptTag({ path: path.join(DIST, 'pick.js') });
  await expect(shop.getByText('click any element to generate locators')).toBeVisible();
  await shop.getByRole('button', { name: 'Checkout' }).hover();
  await shop.waitForTimeout(800);
  const frame = await jpeg();

  const editor = await startEditor();
  const { context: picker, extensionId } = await pairedExtension(editor, { deviceScaleFactor: 2 });
  try {
    const runs = await picker.newPage();
    await runs.setViewportSize({ width: 440, height: 900 });
    await runs.goto(`chrome-extension://${extensionId}/runs.html`);
    const run = await startRun(editor, 'pays with a coupon', [...RUN_TAKES]);
    try {
      await expect(runs.getByText('cart › pays with a coupon')).toBeVisible();
      run.worker.send({
        type: 'stopped',
        stop: 1,
        reason: 'breakpoint',
        title: "Click getByRole('button', { name: 'Checkout' })",
        place: { file: 'tests/cart.spec.ts', line: 12, column: 5 },
        locator: "getByRole('button', { name: 'Checkout' })",
        bar: false,
      });
      await answerNext(run.worker, 'image', { mime: 'image/jpeg', data: image, ...STOP_VIEWPORT });
      await runs.getByRole('button', { name: 'Watch live' }).click();
      await answerNext(run.worker, 'view', { ok: true, message: 'The live view is on.' });
      run.worker.send({ type: 'frame', stop: 1, ...STOP_VIEWPORT, data: frame });
      await expect(runs.locator('img.live')).toBeVisible();
      await runs.getByRole('button', { name: 'Pick', exact: true }).click();
      await answerNext(run.worker, 'pick', {
        ok: true,
        message: "Pick an element in the test's window: the locator goes to the editor.",
      });
      await expect(runs.locator('.worker .note')).toBeVisible();
      await runs.locator('.client').evaluate((client) => (client.textContent = 'Visual Studio Code'));
      await runs.mouse.move(0, 0);
      await runs.locator('h1').click();
      await runs.waitForTimeout(300);
      const body = runs.locator('body');
      await framedAlone(await body.screenshot(), (await body.boundingBox())!, 'picker-runs-live');
    } finally {
      run.worker.socket.destroy();
    }
  } finally {
    await picker.close();
    await editor.close();
  }
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

/** A page recorded as a video, with the time its recording started. */
interface LoopPage {
  context: BrowserContext;
  page: Page;
  startedAt: number;
  dir: string;
}

/**
 * Opens a page (the shop unless `open` says otherwise) in a context that records its pages, with a pointer drawn
 * where the mouse is; `storage` stubs the extension's storage, `init` prepares the context before the page opens.
 */
async function loopPage(
  options: {
    storage?: Parameters<typeof stubChromeStorage>[1];
    init?: (context: BrowserContext) => Promise<void>;
    open?: (page: Page) => Promise<void>;
  } = {},
): Promise<LoopPage> {
  const dir = mkdtempSync(path.join(tmpdir(), 'piwi-docs-loop-'));
  const context = await launchWithExtension(undefined, { recordVideo: { dir, size: LOOP_VIEWPORT } });
  await stubChromeI18n(context);
  // The script drives the tools' own buttons, behind shadow roots closed by design.
  await openShadowRoots(context);
  if (options.storage) await stubChromeStorage(context, options.storage);
  await options.init?.(context);
  const page = await context.newPage();
  const startedAt = Date.now();
  page.setDefaultTimeout(15_000);
  await page.setViewportSize(LOOP_VIEWPORT);
  // Kept the last element of the document, so it stays above the hosts the tools add at the same z-index.
  await page.addInitScript(() => {
    window.addEventListener(
      'mousemove',
      (event) => {
        let pointer = document.getElementById('piwi-docs-pointer');
        if (!pointer) {
          pointer = document.createElement('div');
          pointer.id = 'piwi-docs-pointer';
          pointer.style.cssText =
            'position:fixed;z-index:2147483647;pointer-events:none;width:16px;height:16px;margin:-8px 0 0 -8px;' +
            'border-radius:50%;background:rgba(124,58,237,0.3);border:2px solid #7c3aed;box-sizing:border-box';
        }
        if (pointer !== document.documentElement.lastElementChild) document.documentElement.append(pointer);
        pointer.style.left = `${event.clientX}px`;
        pointer.style.top = `${event.clientY}px`;
      },
      true,
    );
  });
  await (options.open ?? ((shop: Page) => openShop(shop, '?nodialog')))(page);
  return { context, page, startedAt, dir };
}

/** The bug shop is bare HTML: a light stylesheet on each of its pages, for the camera alone. */
async function styleBugShop(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent =
        'body{font:15px/1.5 system-ui,sans-serif;color:#1f2937;margin:0;padding:24px 40px;background:#f8fafc}' +
        'main{max-width:520px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:8px 24px 20px}' +
        'h1{font-size:24px;margin:12px 0}input{padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;margin:0 8px}' +
        'button{padding:6px 14px;border:0;border-radius:6px;background:#4f46e5;color:#fff;font-weight:600}' +
        '#total{font-size:18px;font-weight:600}a{color:#4f46e5}';
      document.head.append(style);
    });
  });
}

/** Moves the mouse to `target`'s center in steps, as a hand does, then rests on it. */
async function glide(page: Page, target: ReturnType<Page['locator']>, restMs = 700): Promise<void> {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
  await page.waitForTimeout(restMs);
}

/** Closes the loop's context and writes its video from `fromMs` after the page opened, muted and H.264. */
async function writeLoop(loop: LoopPage, fromMs: number, name: string): Promise<void> {
  const video = loop.page.video()!;
  await loop.context.close();
  const recorded = await video.path();
  mkdirSync(VIDEOS, { recursive: true });
  execFileSync(process.env.FFMPEG || 'ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-ss',
    (fromMs / 1000).toFixed(2),
    '-i',
    recorded,
    '-vf',
    `fps=25,scale=${LOOP_VIEWPORT.width}:${LOOP_VIEWPORT.height}`,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    path.join(VIDEOS, `${name}.mp4`),
  ]);
  rmSync(loop.dir, { recursive: true, force: true });
}

test('picker-pick-loop', async () => {
  test.setTimeout(180_000);
  const loop = await loopPage();
  const { page } = loop;
  await page.addScriptTag({ path: path.join(DIST, 'pick.js') });
  await expect(page.getByText('click any element to generate locators')).toBeVisible();
  await page.mouse.move(LOOP_VIEWPORT.width / 2, 60);
  const from = Date.now() - loop.startedAt;
  await page.waitForTimeout(600);

  // Hover snaps the outline to each element; the arrows walk up to its parents and back.
  const card = page.getByTestId('product-card').first();
  await glide(page, card.getByRole('heading').first(), 900);
  await glide(page, card.getByRole('button', { name: 'Add to cart' }), 900);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(800);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(800);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(500);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(600);

  // A click picks it: the ranked locators open, the unique one first.
  const checkout = page.getByRole('button', { name: 'Checkout' });
  await glide(page, checkout, 700);
  await page.mouse.down();
  await page.mouse.up();
  const skip = page.getByRole('button', { name: 'Skip (Esc)' });
  const results = () => page.evaluate(() => !!document.getElementById('piwi-picker-results-host'));
  await expect.poll(async () => (await results()) || (await skip.isVisible())).toBe(true);
  if (await skip.isVisible()) {
    await page.waitForTimeout(1200);
    await glide(page, skip, 400);
    await skip.click();
  }
  await expect.poll(results).toBe(true);
  await page.waitForTimeout(3500);
  await writeLoop(loop, from, 'picker-pick-loop');
});

test('picker-record-loop', async () => {
  test.setTimeout(180_000);
  const loop = await loopPage({
    storage: {
      session: {
        piwiRecording: { active: true, events: [], startedAt: Date.now(), grantedOriginPattern: `${SHOP_ORIGIN}/*` },
      },
    },
  });
  const { page } = loop;
  await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
  await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);
  await page.mouse.move(LOOP_VIEWPORT.width / 2, 300);
  const from = Date.now() - loop.startedAt;
  await page.waitForTimeout(600);

  // Each action becomes a step on the bar as it is made.
  const search = page.getByRole('searchbox', { name: 'Search products' });
  await glide(page, search, 300);
  await search.click();
  await page.keyboard.type('mug', { delay: 140 });
  await page.waitForTimeout(500);
  const addBlueMug = page.getByTestId('product-card').first().getByRole('button', { name: 'Add to cart' });
  await glide(page, addBlueMug, 300);
  await addBlueMug.click();
  await page.waitForTimeout(700);
  const coupon = page.getByRole('textbox', { name: 'Coupon code' });
  await glide(page, coupon, 300);
  await coupon.click();
  await page.keyboard.type('MORNING10', { delay: 110 });
  const apply = page.getByRole('button', { name: 'Apply' });
  await glide(page, apply, 300);
  await apply.click();
  await page.waitForTimeout(1200);

  // Stopping opens the review: the steps, ready to export as a test.
  const stop = page.locator('#piwi-record-hud-host').getByRole('button', { name: 'Stop' });
  await glide(page, stop, 500);
  await stop.click();
  await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-review-host'))).toBe(true);
  await page.waitForTimeout(3500);
  await writeLoop(loop, from, 'picker-record-loop');
});

test('picker-report-loop', async () => {
  test.setTimeout(180_000);
  const loop = await loopPage({
    storage: {
      session: {
        piwiRecording: {
          active: true,
          events: [],
          startedAt: Date.now(),
          grantedOriginPattern: `${BUG_SHOP_ORIGIN}/*`,
          mode: 'bug',
          bugToken: 'a'.repeat(32),
        },
      },
      responses: { 'piwi-bug-screenshot': { ok: true, dataUrl: ONE_PIXEL_PNG } },
    },
    init: async (context) => {
      await routeShop(context, { fixed: false });
      await styleBugShop(context);
      await context.addInitScript({ path: path.join(DIST, 'bug-evidence-main.js') });
    },
    open: async (page) => {
      await page.goto(`${BUG_SHOP_ORIGIN}/cart`);
    },
  });
  const { page } = loop;
  await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
  await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);
  await page.mouse.move(LOOP_VIEWPORT.width / 2, 300);
  const from = Date.now() - loop.startedAt;
  await page.waitForTimeout(600);

  // The flow that shows the bug: the coupon is applied, the total stays.
  const coupon = page.getByRole('textbox', { name: 'Coupon' });
  await glide(page, coupon, 300);
  await coupon.click();
  await page.keyboard.type('SPRING10', { delay: 110 });
  const apply = page.getByRole('button', { name: 'Apply' });
  await glide(page, apply, 300);
  await apply.click();
  await page.waitForTimeout(1000);

  // Mark what's wrong: pick the total, say what it should read.
  const hud = page.locator('#piwi-record-hud-host').getByRole('button');
  await glide(page, hud.nth(0), 500);
  await hud.nth(0).click();
  await expect(page.getByText('click any element to generate locators')).toBeVisible();
  const total = page.getByTestId('cart-total');
  await glide(page, total, 700);
  await total.click();
  await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-bug-dialog-host'))).toBe(true);
  await page.waitForTimeout(500);
  await page.keyboard.type('Total: 45', { delay: 90 });
  await page.keyboard.press('Tab');
  await page.keyboard.type('The coupon is ignored', { delay: 60 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-bug-dialog-host'))).toBe(false);
  await page.waitForTimeout(1000);

  // Finish: the report, with the steps, the evidence and a failing test to copy.
  await glide(page, hud.nth(3), 500);
  await hud.nth(3).click();
  await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-review-host'))).toBe(true);
  await page.waitForTimeout(4000);
  await writeLoop(loop, from, 'picker-report-loop');
});

/** The coupon report the report loop records, as Replay reads it from its `.piwibug`. */
const COUPON_REPORT: PiwiSteps = {
  v: 1,
  title: 'Coupon not applied to the total',
  origin: 'https://staging.acme.test',
  recordedAt: 0,
  note: null,
  steps: [
    { action: 'goto', target: null, value: '/cart', redacted: false, pageUrl: '/cart', timestamp: 0 },
    {
      action: 'fill',
      target: {
        tagName: 'input',
        role: 'textbox',
        accessibleName: 'Coupon',
        testId: null,
        text: null,
        alternatives: [{ locator: "getByRole('textbox', { name: 'Coupon' })", method: 'getByRole', score: 96 }],
      },
      value: 'SPRING10',
      redacted: false,
      pageUrl: '/cart',
      timestamp: 1,
    },
    {
      action: 'click',
      target: {
        tagName: 'button',
        role: 'button',
        accessibleName: 'Apply',
        testId: null,
        text: 'Apply',
        alternatives: [{ locator: "getByRole('button', { name: 'Apply' })", method: 'getByRole', score: 96 }],
      },
      value: null,
      redacted: false,
      pageUrl: '/cart',
      timestamp: 2,
    },
    {
      action: 'assert',
      target: {
        tagName: 'p',
        role: null,
        accessibleName: null,
        testId: 'cart-total',
        text: 'Total: 50',
        alternatives: [{ locator: "getByTestId('cart-total')", method: 'getByTestId', score: 100 }],
      },
      value: null,
      redacted: false,
      pageUrl: '/cart',
      timestamp: 3,
      assertion: { matcher: 'toHaveText', expected: 'Total: 45', actual: 'Total: 50', negated: false, note: null },
    },
  ],
};

test('picker-replay-loop', async () => {
  test.setTimeout(180_000);
  const loop = await loopPage({
    init: async (context) => {
      await routeShop(context, { fixed: false });
      await styleBugShop(context);
      await stubReplayChrome(context, {
        piwiReplay: {
          id: 'docs-loop',
          steps: COUPON_REPORT,
          origin: BUG_SHOP_ORIGIN,
          position: 0,
          results: [],
          status: 'running',
          stepMode: false,
          cursor: null,
          startedAt: 0,
          startPage: null,
        },
      });
    },
    open: async (page) => {
      await page.goto(`${BUG_SHOP_ORIGIN}/cart`);
    },
  });
  const { page } = loop;
  // The replay plays from the report's first page: the loop starts as that page loads.
  await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-replay-hud-host'))).toBe(true);
  const from = Date.now() - loop.startedAt;
  // It moves its own cursor to each step, plays it, then says whether the bug still shows.
  await expect
    .poll(() => page.evaluate(() => JSON.parse(window.name).session.piwiReplay.status), { timeout: 60_000 })
    .toBe('done');
  await page.waitForTimeout(4000);
  await writeLoop(loop, from, 'picker-replay-loop');
});
