import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { jpegCodec, maskSecretFields, maskedImage } from '../src/internal/capture/live-mask.js';

/**
 * An image taken in a frame's place shows the viewport its two reads measured, at the visual viewport's scale, or does
 * not go: the masks are painted where those reads put the secret fields. A page resized under the view can hand back a
 * screenshot of its new viewport while both reads still name the old one; here the page's screenshot is one of the same
 * page at another size, and no image goes. A mobile page shown zoomed out to fit its layout viewport goes, its field
 * painted over. Each image is decoded and its field's pixels counted.
 */

/** Where the password field sits, in CSS pixels: green, on a red page. */
const FIELD = { x: 40, y: 40, width: 360, height: 80 };
const PAGE = `<!doctype html><style>body { margin: 0; background: rgb(255, 0, 0) }</style>
<input type="password" value="hunter2" style="position: absolute; left: ${FIELD.x}px; top: ${FIELD.y}px; width: ${FIELD.width}px; height: ${FIELD.height}px; border: 0; background: rgb(0, 255, 0)">`;

let browser: Browser;
let page: Page;
let resized: Page;
let mobile: BrowserContext;
let zoomedOut: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent(PAGE);
  resized = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await resized.setContent(PAGE);
  // No meta viewport: the page is laid out 980 pixels wide and shown at the device's width.
  mobile = await browser.newContext({ ...devices['Pixel 5'] });
  zoomedOut = await mobile.newPage();
  await zoomedOut.setContent(PAGE);
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/** `page`'s screenshot, of the page at another viewport, while `run` runs. */
async function withResizedShots<T>(run: () => Promise<T>): Promise<T> {
  const own = page.screenshot;
  page.screenshot = ((options) => resized.screenshot(options)) as Page['screenshot'];
  try {
    return await run();
  } finally {
    page.screenshot = own;
  }
}

/** A screencast frame that names no time, as before Playwright 1.61: an image is taken in its place. */
async function undatedFrame(of: Page) {
  const data = await of.screenshot({ type: 'jpeg', scale: 'css' });
  const { width, height } = await of.evaluate(() => {
    const view = globalThis as unknown as { innerWidth: number; innerHeight: number };
    return { width: view.innerWidth, height: view.innerHeight };
  });
  return { data, width, height, at: -Infinity };
}

/** How many pixels of the field's box, `scale` image pixels a CSS pixel, are its green. */
function fieldPixels(data: Buffer, scale: number): number {
  const image = jpegCodec()!.decode(data, { useTArray: true, formatAsRGBA: true });
  let green = 0;
  for (let y = Math.ceil(FIELD.y * scale); y < Math.floor((FIELD.y + FIELD.height) * scale); y++) {
    for (let x = Math.ceil(FIELD.x * scale); x < Math.floor((FIELD.x + FIELD.width) * scale); x++) {
      const i = (y * image.width + x) * 4;
      if (image.data[i + 1]! > 160 && image.data[i]! < 100 && image.data[i + 2]! < 100) green++;
    }
  }
  return green;
}

const OPTIONS = { masks: () => [], quality: 60, maxBytes: 384 * 1024 };

describe('an image taken in a frame’s place', () => {
  it('goes with the field painted over when it shows the viewport its reads measured', async () => {
    const sent = await maskSecretFields(page, OPTIONS).screen(await undatedFrame(page));
    expect(sent).toMatchObject({ width: 1280, height: 720 });
    expect(fieldPixels((sent as { data: Buffer }).data, 1)).toBe(0);
  });

  it('does not go when it shows another viewport than its reads measured', async () => {
    const frame = await undatedFrame(page);
    expect(await withResizedShots(() => maskSecretFields(page, OPTIONS).screen(frame))).toBeNull();
  });

  it('goes with the field painted over on a mobile page shown zoomed out', async () => {
    const frame = await undatedFrame(zoomedOut);
    expect(frame.width).toBeGreaterThan(zoomedOut.viewportSize()!.width);
    const sent = await maskSecretFields(zoomedOut, OPTIONS).screen(frame);
    expect(sent).toMatchObject({ width: frame.width, height: frame.height });
    const { data } = sent as { data: Buffer };
    expect(
      fieldPixels(data, jpegCodec()!.decode(data, { useTArray: true, formatAsRGBA: true }).width / frame.width),
    ).toBe(0);
  });
});

describe('the image of a stopped page', () => {
  it('goes with the field painted over when it shows the viewport its reads measured', async () => {
    const image = await maskedImage(page, { quality: 60, timeout: 5000 });
    expect(image).toBeInstanceOf(Buffer);
    expect(fieldPixels(image!, 1)).toBe(0);
  });

  it('does not go when it shows another viewport than its reads measured', async () => {
    expect(await withResizedShots(() => maskedImage(page, { quality: 60, timeout: 5000 }))).toBeNull();
  });

  it('goes with the field painted over on a mobile page shown zoomed out', async () => {
    const image = await maskedImage(zoomedOut, { quality: 60, timeout: 5000 });
    expect(image).toBeInstanceOf(Buffer);
    const { width } = await zoomedOut.evaluate(() => ({
      width: (globalThis as unknown as { innerWidth: number }).innerWidth,
    }));
    expect(fieldPixels(image!, zoomedOut.viewportSize()!.width / width)).toBe(0);
  });
});
