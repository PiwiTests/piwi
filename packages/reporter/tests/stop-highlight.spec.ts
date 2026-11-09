import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as expectPage, type Browser, type Page } from '@playwright/test';
import { highlightAtStop } from '../src/internal/capture/pause-at.js';

/**
 * A stop's highlight in a real page (`highlightAtStop`): drawn in the frame its locator enters, found anew while the
 * stop lasts, so an element the page renders or replaces meanwhile gets its box, and taken down in each frame it was
 * drawn in, whatever its locator matches there by then.
 */

/** The page renders its Pay button anew. */
const RENDER_PAY = 'document.getElementById("app").innerHTML = "<button>Pay</button>"';

describe('a stop’s highlight in a real page', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => browser?.close());

  /** How many boxes of Piwi's show, in every frame of the page. */
  const boxes = async (): Promise<number> => {
    let shown = 0;
    for (const frame of page.frames()) {
      shown += await frame
        .locator('[data-piwi-stop-highlight] > [data-box]')
        .evaluateAll(
          (all) =>
            all.filter((box) => (box as unknown as { style: { display: string } }).style.display !== 'none').length,
        );
    }
    return shown;
  };
  /** How many layers of Piwi's are left, in every frame of the page. */
  const layers = async (): Promise<number> => {
    let left = 0;
    for (const frame of page.frames()) left += await frame.locator('[data-piwi-stop-highlight]').count();
    return left;
  };

  it('is taken down in the frame it was drawn in, whatever its locator matches there by then', async () => {
    page = await browser.newPage();
    try {
      await page.setContent('<iframe id="checkout" srcdoc="<button>Pay</button><p>Total</p>"></iframe>');
      const checkout = page.frameLocator('#checkout');
      await expectPage(checkout.getByRole('button', { name: 'Pay' })).toBeVisible();
      // Its element relabeled while stopped.
      const pay = highlightAtStop(page, checkout.getByRole('button', { name: 'Pay' }), 'call', 'pay');
      expect(await pay.shown).toBe(true);
      await checkout.getByRole('button').evaluate((button) => (button.textContent = 'Processing...'));
      expect(await pay.hide()).toBe(true);
      expect(await layers()).toBe(0);
      // Drawn before its element shows up, and taken down after: the same through `contentFrame`.
      const link = page.locator('#checkout').contentFrame().getByRole('link', { name: 'Receipt' });
      const receipt = highlightAtStop(page, link, 'count', 'receipt');
      expect(await receipt.shown).toBe(false);
      await checkout.locator('p').evaluate((p) => p.insertAdjacentHTML('afterend', '<a href="#">Receipt</a>'));
      await expect.poll(boxes, { timeout: 3000 }).toBe(1);
      expect(await receipt.hide()).toBe(true);
      expect(await layers()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('boxes an element the page renders, or replaces, while it lasts', async () => {
    page = await browser.newPage();
    try {
      await page.setContent('<div id="app"></div>');
      const pay = highlightAtStop(page, page.getByRole('button', { name: 'Pay' }), 'call', 'pay');
      expect(await pay.shown).toBe(false);
      await page.evaluate(RENDER_PAY);
      await expect.poll(boxes, { timeout: 3000 }).toBe(1);
      await page.evaluate(RENDER_PAY);
      await expect.poll(boxes, { timeout: 3000 }).toBe(1);
      expect(await layers()).toBe(1);
      expect(await pay.hide()).toBe(true);
      expect(await layers()).toBe(0);
      // Nothing is drawn after its take-down.
      await page.evaluate(RENDER_PAY);
      await page.waitForTimeout(1200);
      expect(await layers()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
