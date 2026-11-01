import { test, expect } from '@playwright/test';
import { removeStopHighlight, showStopHighlight, type StopHighlightArg } from '../../src/overlay-stop.js';

const PAGE = `<!doctype html><html><body style="margin:0">
<div style="height:300px"></div>
<button id="pay" style="width:120px;height:40px">Pay</button>
<button id="cancel">Cancel</button>
<div style="height:3000px"></div>
</body></html>`;

/** The box drawn over the element at `index` of highlight `id`, as the viewport places it. */
/** The argument of a highlight `id` of `kind`, labelled `label`. */
const arg = (id: string, kind: StopHighlightArg['kind'], label: string): StopHighlightArg => ({ id, kind, label });

const boxOf = (id: string, index = 0) => `#__piwi_stop_highlight_${id} > div:nth-child(${index + 1})`;

test.describe('showStopHighlight', () => {
  test('draws a box over each element and the locator beside the first, kept on them as the page scrolls', async ({
    page,
  }) => {
    await page.setContent(PAGE);
    const drew = await page
      .locator('button')
      .evaluateAll(showStopHighlight, arg('call-1', 'call', "getByRole('button')"));
    expect(drew).toBe(true);
    const pay = (await page.locator('#pay').boundingBox())!;
    const box = (await page.locator(boxOf('call-1')).boundingBox())!;
    expect(Math.round(box.x)).toBe(Math.round(pay.x) - 2);
    expect(Math.round(box.y)).toBe(Math.round(pay.y) - 2);
    expect(Math.round(box.width)).toBe(Math.round(pay.width) + 4);
    await expect(page.locator(boxOf('call-1', 1))).toBeVisible();
    await expect(page.locator('#__piwi_stop_highlight_call-1')).toContainText("getByRole('button')");
    // The page scrolls: the boxes follow their elements.
    await page.evaluate(() => window.scrollTo(0, 200));
    const scrolled = Math.round((await page.locator('#pay').boundingBox())!.y);
    await expect
      .poll(async () => Math.round((await page.locator(boxOf('call-1')).boundingBox())!.y))
      .toBe(scrolled - 2);
  });

  test('takes the highlight down, and a draw that comes after draws nothing', async ({ page }) => {
    await page.setContent(PAGE);
    const pay = page.locator('#pay');
    await pay.evaluateAll(showStopHighlight, arg('count-1', 'count', ''));
    expect(await pay.evaluateAll(removeStopHighlight, 'count-1')).toBe(true);
    await expect(page.locator('[data-piwi-stop-highlight]')).toHaveCount(0);
    expect(await pay.evaluateAll(removeStopHighlight, 'count-1')).toBe(false);
    // A draw that comes after its take-down: a frame that answered late.
    expect(await pay.evaluateAll(removeStopHighlight, 'call-2')).toBe(false);
    expect(await pay.evaluateAll(showStopHighlight, arg('call-2', 'call', 'x'))).toBe(false);
    await expect(page.locator('[data-piwi-stop-highlight]')).toHaveCount(0);
  });

  test('hides the box of an element gone from the page, and leaves Playwright’s own highlight as it is', async ({
    page,
  }) => {
    await page.setContent(PAGE);
    await page.locator('#cancel').highlight();
    await page.locator('#pay').evaluateAll(showStopHighlight, arg('call-3', 'call', 'pay'));
    await page.evaluate(() => document.getElementById('pay')!.remove());
    await expect(page.locator(boxOf('call-3'))).toBeHidden();
    await page.locator('#cancel').evaluateAll(removeStopHighlight, 'call-3');
    await expect(page.locator('x-pw-glass')).toHaveCount(1);
  });
});
