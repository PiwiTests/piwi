import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { probeElementAttrs } from '@piwitests/picker-dom';
import { CAPTURED_ATTRS_ARG } from '../src/internal/capture/capture-fixtures.js';
import { readSnapshot, refLocators, withoutFieldSecrets } from '../src/internal/capture/agent-page.js';

/**
 * What an agent reads of a stopped page holding secrets: the value of a password field, a card's number or security
 * code and a one-time code, short or long, plain or quoted in the snapshot, in the main frame or an iframe, is hidden in
 * the snapshot, masked in the image and left out of the element's answer.
 */

describe('a snapshot without the secret fields’ values', () => {
  it('hides a value on its node’s line, plain or quoted, and a long one anywhere, as written or escaped', () => {
    const snapshot = [
      '- textbox "PIN" [ref=e3]: "123456"',
      '- textbox "Short" [ref=e5]: hunt3r',
      '- textbox "Colon" [active] [ref=e9]: "a: b"',
      '- spinbutton "CVC" [ref=e10]: "737"',
      '- textbox "Long" [ref=e11]: "\\"quoted\\\\pass"',
      '- textbox "Control" [ref=e12]: "a\\x01b"',
      '- text: "echo \\"quoted\\\\pass and hunt3r"',
      '- textbox "Coupon" [ref=e13]: WELCOME10',
    ].join('\n');
    const hidden = withoutFieldSecrets(snapshot, ['123456', 'hunt3r', 'a: b', '737', '"quoted\\pass', 'a\u0001b']);
    expect(hidden.split('\n')).toEqual([
      '- textbox "PIN" [ref=e3]: <hidden>',
      '- textbox "Short" [ref=e5]: <hidden>',
      '- textbox "Colon" [active] [ref=e9]: <hidden>',
      '- spinbutton "CVC" [ref=e10]: <hidden>',
      '- textbox "Long" [ref=e11]: <hidden>',
      '- textbox "Control" [ref=e12]: <hidden>',
      // A long value shown elsewhere goes, a short one stays: it may be any word of the page.
      '- text: "echo <hidden> and hunt3r"',
      '- textbox "Coupon" [ref=e13]: WELCOME10',
    ]);
    expect(withoutFieldSecrets(snapshot, [])).toBe(snapshot);
  });
});

describe('a stopped page with secrets, for an agent', () => {
  let browser: Browser;
  let page: Page;
  const PROBE = { fn: probeElementAttrs, arg: { ...CAPTURED_ATTRS_ARG, testIdAttribute: null } };
  const SECRETS = ['123456', 'hunt3r', 'a: b', '0042', '4111 1111 1111 1111', '737', '981234', '5555555555554444'];

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`<!doctype html><meta charset="utf-8">
<label>PIN <input type="password" value="123456"></label>
<label>Short <input type="PASSWORD" value="hunt3r"></label>
<label>Colon <input type="password" value="a: b"></label>
<label>Typed <input type="password" id="typed"></label>
<label>Card number <input autocomplete="cc-number" value="4111 1111 1111 1111"></label>
<label>CVC <input autocomplete="section-pay CC-CSC" value="737"></label>
<label>Code <input autocomplete="one-time-code" value="981234"></label>
<label>Coupon <input value="WELCOME10"></label>
<iframe srcdoc='<label>Card in frame <input autocomplete="cc-number" value="5555555555554444" style="width:300px;height:60px"></label>'
  style="position:absolute;left:400px;top:300px;width:380px;height:120px;border:0"></iframe>`);
    await page.locator('#typed').fill('0042');
    await page.frames()[1]!.locator('input').waitFor();
  });
  afterAll(async () => browser?.close());

  it('hides every value in the snapshot, the iframe’s too', async () => {
    const read = await readSnapshot(page, null, false);
    expect(read.ok).toBe(true);
    const snapshot = read.snapshot!;
    for (const secret of SECRETS) {
      for (const line of snapshot.split('\n')) expect(line, snapshot).not.toMatch(new RegExp(`: "?${secret}"?$`));
      if (secret.length >= 8) expect(snapshot).not.toContain(secret);
    }
    expect(snapshot).toContain('textbox "Coupon"');
    expect(snapshot).toContain('WELCOME10');
  });

  it('masks a secret field in an iframe in the image', async () => {
    const read = await readSnapshot(page, null, true);
    expect(read.image).toMatchObject({ mime: 'image/jpeg' });
    const field = (await page.frames()[1]!.locator('input').boundingBox())!;
    const viewer = await browser.newPage();
    try {
      await viewer.setContent(`<img id="shot" src="data:image/jpeg;base64,${read.image!.data}">`);
      await viewer.waitForFunction(() => (document.getElementById('shot') as HTMLImageElement).complete);
      const [r, g, b] = await viewer.evaluate(
        ({ x, y }) => {
          const img = document.getElementById('shot') as HTMLImageElement;
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const context = canvas.getContext('2d')!;
          context.drawImage(img, 0, 0);
          return Array.from(context.getImageData(x, y, 1, 1).data);
        },
        { x: Math.round(field.x + 20), y: Math.round(field.y + field.height / 2) },
      );
      // Playwright's mask: magenta over the field, where its digits would be.
      expect(r).toBeGreaterThan(200);
      expect(g).toBeLessThan(60);
      expect(b).toBeGreaterThan(200);
    } finally {
      await viewer.close();
    }
  });

  it('answers a card’s number, its security code and a one-time code as secrets, without their values', async () => {
    const read = await readSnapshot(page, null, false);
    for (const name of ['Card number', 'CVC', 'Code', 'PIN']) {
      const ref = new RegExp(`textbox "${name}" \\[ref=(e\\d+)\\]`).exec(read.snapshot!)?.[1];
      expect(ref, read.snapshot!).toBeTruthy();
      const found = await refLocators(page, PROBE, ref!, null);
      expect(found.element, name).toMatchObject({ secret: true, value: null });
      for (const secret of SECRETS) expect(JSON.stringify(found)).not.toContain(secret);
    }
    const coupon = /textbox "Coupon" \[ref=(e\d+)\]/.exec(read.snapshot!)![1]!;
    expect((await refLocators(page, PROBE, coupon, null)).element).toMatchObject({ secret: false, value: 'WELCOME10' });
  });
});
