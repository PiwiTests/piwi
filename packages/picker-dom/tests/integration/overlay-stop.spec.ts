import { test, expect } from '@playwright/test';
import { removeStopHighlight, showStopHighlight, type StopHighlightArg } from '../../src/overlay-stop.js';

const PAGE = `<!doctype html><html><body style="margin:0">
<div style="height:300px"></div>
<button id="pay" style="width:120px;height:40px">Pay</button>
<button id="cancel">Cancel</button>
<div style="height:3000px"></div>
</body></html>`;

/** The argument of a highlight `id` of `kind`, labelled `label`. */
const arg = (id: string, kind: StopHighlightArg['kind'], label: string): StopHighlightArg => ({ id, kind, label });

/** The box drawn over the element at `index` of highlight `id`, as the viewport places it. */
const boxOf = (id: string, index = 0) => `#__piwi_stop_highlight_${id} > div:nth-child(${index + 1})`;

test.describe('showStopHighlight', () => {
  test('draws a box over each element and the locator beside the first, kept on them as the page scrolls', async ({
    page,
  }) => {
    await page.setContent(PAGE);
    const drew = await page
      .locator('button')
      .evaluateAll(showStopHighlight, arg('call-1', 'call', "getByRole('button')"));
    expect(drew).toBe(2);
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
    expect(await page.evaluate(removeStopHighlight, 'count-1')).toBe(true);
    await expect(page.locator('[data-piwi-stop-highlight]')).toHaveCount(0);
    expect(await page.evaluate(removeStopHighlight, 'count-1')).toBe(false);
    // A draw that comes after its take-down: a frame that answered late.
    expect(await page.evaluate(removeStopHighlight, 'call-2')).toBe(false);
    expect(await pay.evaluateAll(showStopHighlight, arg('call-2', 'call', 'x'))).toBe(0);
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
    await page.evaluate(removeStopHighlight, 'call-3');
    await expect(page.locator('x-pw-glass')).toHaveCount(1);
  });

  test('draws none for no element or one nothing shows, and a draw again boxes one rendered or replaced since', async ({
    page,
  }) => {
    await page.setContent('<div id="app"></div><input type="hidden" value="x"><p id="gone" style="display:none">x</p>');
    const button = page.getByRole('button', { name: 'Pay' });
    const draw = () => button.evaluateAll(showStopHighlight, arg('call-5', 'call', 'pay'));
    expect(await draw()).toBe(0);
    await expect(page.locator('[data-piwi-stop-highlight]')).toHaveCount(0);
    for (const hidden of ['input[type=hidden]', '#gone']) {
      expect(await page.locator(hidden).evaluateAll(showStopHighlight, arg('count-5', 'count', ''))).toBe(0);
    }
    await page.evaluate(removeStopHighlight, 'count-5');
    // The page renders the element during the stop.
    await page.evaluate(() => (document.getElementById('app')!.innerHTML = '<button>Pay</button>'));
    expect(await draw()).toBe(1);
    await expect(page.locator(boxOf('call-5'))).toBeVisible();
    // The same element again: the layer stays as it is.
    const layer = await page.locator('#__piwi_stop_highlight_call-5').elementHandle();
    expect(await draw()).toBe(1);
    expect(await layer!.evaluate((node) => node.isConnected)).toBe(true);
    // The page replaces the element: its box goes, and a draw again boxes the new one.
    await page.evaluate(() => (document.getElementById('app')!.innerHTML = '<button>Pay</button>'));
    await expect(page.locator(boxOf('call-5'))).toBeHidden();
    expect(await draw()).toBe(1);
    await expect(page.locator(boxOf('call-5'))).toBeVisible();
    await expect(page.locator('[data-piwi-stop-highlight]')).toHaveCount(1);
    // The element goes: a draw on none takes the layer away.
    await page.evaluate(() => (document.getElementById('app')!.innerHTML = ''));
    expect(await draw()).toBe(0);
    await expect(page.locator('[data-piwi-stop-highlight]')).toHaveCount(0);
  });

  for (const [where, content] of [
    [
      'in a modal dialog',
      '<dialog id="d" style="margin:0;top:100px;left:100px"><button id="pay" style="width:120px;height:40px">Pay</button></dialog><script>d.showModal()</script>',
    ],
    [
      'in a popover',
      '<div popover="manual" id="p" style="margin:0;top:100px;left:100px"><button id="pay" style="width:120px;height:40px">Pay</button></div><script>p.showPopover()</script>',
    ],
    [
      'under a transformed <html>, scrolled',
      '<html style="transform:translateZ(0)"><body style="margin:0"><div style="height:500px"></div><button id="pay" style="width:120px;height:40px">Pay</button><div style="height:2000px"></div><script>scrollTo(0, 400)</script>',
    ],
  ] as const) {
    test(`shows over an element ${where}`, async ({ page }) => {
      await page.setContent(content);
      const pay = page.locator('#pay');
      const box = (await pay.boundingBox())!;
      const clip = { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 };
      const plain = await page.screenshot({ clip });
      expect(await pay.evaluateAll(showStopHighlight, arg('call-4', 'call', ''))).toBe(1);
      await expect.poll(async () => (await page.screenshot({ clip })).equals(plain)).toBe(false);
    });
  }

  test('shows over a modal dialog the page opens after it, once drawn again', async ({ page }) => {
    await page.setContent(
      '<button id="pay" style="width:120px;height:40px;margin:100px">Pay</button><dialog id="d" style="width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:#fff"></dialog>',
    );
    const pay = page.locator('#pay');
    const box = (await pay.boundingBox())!;
    const clip = { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 };
    expect(await pay.evaluateAll(showStopHighlight, arg('call-6', 'call', ''))).toBe(1);
    await page.evaluate(() => (document.getElementById('d') as HTMLDialogElement).showModal());
    const covered = await page.screenshot({ clip });
    expect(await pay.evaluateAll(showStopHighlight, arg('call-6', 'call', ''))).toBe(1);
    await expect.poll(async () => (await page.screenshot({ clip })).equals(covered)).toBe(false);
  });
});
