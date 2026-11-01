import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as expectPage, type Browser, type Page } from '@playwright/test';
import { MAX_ELEMENT_TEXT } from '@piwitests/core/run-channel';
import { probeElementAttrs, showPauseBar } from '@piwitests/picker-dom';
import { CAPTURED_ATTRS_ARG } from '../src/internal/capture/capture-fixtures.js';
import { actOnRef, readSnapshot, refLocators, withoutFieldSecrets } from '../src/internal/capture/agent-page.js';
import { maskedImage } from '../src/internal/capture/live-mask.js';

/**
 * What an agent reads of a stopped page holding secrets: the value of a password field, a card's number or security
 * code and a one-time code, short or long, plain or quoted in the snapshot, in the main frame or an iframe, is hidden in
 * the snapshot, painted over in the image, the test's own highlight left in the page, and left out of the element's
 * answer, a frame that does not answer painted over whole. And an element's text, read whole up to its
 * limit, as Playwright's text assertions compare it. And an action on an element under the pause bar, which the
 * agent's image leaves out.
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

/** The style the agent's image is taken with: Piwi's pause bar hidden. */
const BAR_HIDDEN_HERE = '#__piwi-pause-bar { display: none !important; }';

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
      await viewer.waitForFunction('document.getElementById("shot").complete');
      // The color of the image's pixel at the field, read on a canvas.
      const x = Math.round(field.x + 20);
      const y = Math.round(field.y + field.height / 2);
      const [r, g, b] = await viewer.evaluate<number[]>(`(() => {
        const img = document.getElementById('shot');
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(img, 0, 0);
        return Array.from(context.getImageData(${x}, ${y}, 1, 1).data);
      })()`);
      // Gray painted over the field, where its digits would be.
      for (const channel of [r, g, b]) expect(Math.abs(channel! - 96)).toBeLessThan(24);
    } finally {
      await viewer.close();
    }
  });

  it('leaves the test’s own highlight in the page as the image is taken', async () => {
    await page.getByText('Coupon').highlight();
    const glass = () => page.evaluate<number>('document.querySelectorAll("x-pw-glass").length');
    expect(await glass()).toBe(1);
    const read = await readSnapshot(page, null, true);
    expect(read.image).toMatchObject({ mime: 'image/jpeg' });
    expect(await glass()).toBe(1);
    await page.evaluate('new Promise(requestAnimationFrame)');
    expect(await glass()).toBe(1);
  });

  /** The red, green and blue of `image`'s pixel at `x`, `y`, read on a canvas of another page. */
  async function pixel(image: Buffer, x: number, y: number): Promise<number[]> {
    const viewer = await browser.newPage();
    try {
      await viewer.setContent(`<img id="shot" src="data:image/jpeg;base64,${image.toString('base64')}">`);
      await viewer.waitForFunction('document.getElementById("shot").complete');
      const rgba = await viewer.evaluate<number[]>(`(() => {
        const img = document.getElementById('shot');
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(img, 0, 0);
        return Array.from(context.getImageData(${x}, ${y}, 1, 1).data);
      })()`);
      return rgba.slice(0, 3);
    } finally {
      await viewer.close();
    }
  }
  /** Whether a pixel is the gray painted over a masked element. */
  const painted = (rgb: number[]) => rgb.every((channel) => Math.abs(channel - 96) < 24);

  it('takes the image of a page with a lazy frame, which never answers, its secret fields painted over', async () => {
    const other = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await other.route('https://piwi.test/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: route.request().url().endsWith('/lazy')
            ? 'lazy'
            : `<!doctype html><body style="margin:0;background:#fff"><input type="password" value="hunter2"
style="width:200px;height:30px"><div style="height:12000px"></div><iframe loading="lazy" src="/lazy"></iframe>`,
        }),
      );
      await other.goto('https://piwi.test/');
      const started = Date.now();
      const image = await maskedImage(other, { quality: 90, style: BAR_HIDDEN_HERE, timeout: 5000 });
      expect(Date.now() - started).toBeLessThan(4000);
      expect(image).not.toBeNull();
      expect(painted(await pixel(image!, 100, 15))).toBe(true);
      expect(painted(await pixel(image!, 500, 300))).toBe(false);
    } finally {
      await other.close();
    }
  }, 20_000);

  it('gives no image of a page whose frame in view does not answer, unless that frame is painted over whole', async () => {
    const other = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await other.route('https://piwi.test/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><body style="margin:0;background:#fff"><iframe src="https://other.test/busy"
style="display:block;width:300px;height:100px;border:0"></iframe>`,
        }),
      );
      // A frame of another site, in a process of its own, busy for six seconds once told.
      await other.route('https://other.test/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<input type="password" value="hunter2"><script>addEventListener('message', () => {
const t = Date.now(); while (Date.now() - t < 6000); });</script>`,
        }),
      );
      await other.goto('https://piwi.test/');
      await other.evaluate('document.querySelector("iframe").contentWindow.postMessage("busy", "*")');
      const image = await maskedImage(other, { quality: 90, style: BAR_HIDDEN_HERE, timeout: 3000 });
      if (image) {
        for (const [x, y] of [
          [20, 10],
          [150, 50],
          [290, 90],
        ] as const) {
          expect(painted(await pixel(image, x, y))).toBe(true);
        }
      }
    } finally {
      await other.close();
    }
  }, 20_000);

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

describe('an element’s text, for an assertion', () => {
  let browser: Browser;
  const PROBE = { fn: probeElementAttrs, arg: { ...CAPTURED_ATTRS_ARG, testIdAttribute: null } };

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => browser?.close());

  it('is read whole, as toHaveText compares it, and cut past its limit, saying so', async () => {
    const page = await browser.newPage();
    try {
      const text =
        'Your order of three ceramic mugs, two saucers and one teapot has shipped and will arrive within five working days at the address you gave.';
      const long = 'many words '.repeat(120);
      await page.setContent(`<p role="status">  ${text.replace(/ /g, '\n  ')}  </p><p role="note">${long}</p>`);
      const read = await readSnapshot(page, null, false);
      const refOf = (role: string) => new RegExp(`${role} \\[ref=(e\\d+)\\]`).exec(read.snapshot!)![1]!;
      const status = (await refLocators(page, PROBE, refOf('status'), null)).element!;
      expect(status).toMatchObject({ text, textCut: false });
      await expectPage(page.getByRole('status')).toHaveText(status.text!, { timeout: 1000 });
      const note = (await refLocators(page, PROBE, refOf('note'), null)).element!;
      expect(note.textCut).toBe(true);
      expect(note.text).toHaveLength(MAX_ELEMENT_TEXT);
      await expectPage(page.getByRole('note')).toContainText(note.text!.trim(), { timeout: 1000 });
    } finally {
      await page.close();
    }
  });
});

describe('an action under the pause bar', () => {
  let browser: Browser;
  const PROBE = { fn: probeElementAttrs, arg: { ...CAPTURED_ATTRS_ARG, testIdAttribute: null } };

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => browser?.close());

  it('lands on the element the bar covers, and leaves the bar as it was', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent(
        `<nav style="padding:8px"><a href="#orders" onclick="document.title = 'Orders'">Orders</a></nav><main>Shop</main>`,
      );
      await page.evaluate(showPauseBar, {
        place: 'shop.spec.ts:44',
        attempt: null,
        action: 'Expect "toHaveText"',
        locator: null,
        end: true,
      });
      const bar = page.locator('#__piwi-pause-bar');
      const link = await page.getByRole('link', { name: 'Orders' }).boundingBox();
      const covered = await bar.boundingBox();
      expect(link!.y + link!.height).toBeLessThan(covered!.y + covered!.height);
      const read = await readSnapshot(page, null, false);
      const ref = /link "Orders" \[ref=(e\d+)\]/.exec(read.snapshot!)![1]!;
      const acted = await actOnRef(page, PROBE, { ref, action: 'click', value: null }, null);
      expect(acted, acted.message).toMatchObject({ ok: true });
      expect(await page.title()).toBe('Orders');
      await expectPage(bar).toBeVisible();
      await expectPage(bar).toHaveCSS('pointer-events', 'auto');
    } finally {
      await page.close();
    }
  }, 15_000);
});
