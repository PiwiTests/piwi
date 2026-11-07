import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { maskSecretFields, maskedImage } from '../src/internal/capture/live-mask.js';

/**
 * An image taken in a frame's place shows the viewport its two reads measured, or does not go: the masks are painted
 * where those reads put the secret fields. A page resized under the view can hand back a screenshot of its new
 * viewport while both reads still name the old one; here the page's screenshot is one of the same page at another
 * size, and no image goes. Without it, the image goes.
 */

const PAGE = `<!doctype html><style>body { margin: 0; background: rgb(255, 0, 0) }</style>
<input type="password" value="hunter2" style="position: absolute; left: 40px; top: 40px; width: 360px; height: 80px; border: 0; background: rgb(0, 255, 0)">`;

let browser: Browser;
let page: Page;
let resized: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent(PAGE);
  resized = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await resized.setContent(PAGE);
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/** The page's screenshot, of the page at another viewport, while `run` runs. */
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
async function undatedFrame() {
  return { data: await page.screenshot({ type: 'jpeg', scale: 'css' }), width: 1280, height: 720, at: -Infinity };
}

describe('an image taken in a frame’s place', () => {
  it('goes, painted over, when it shows the viewport its reads measured', async () => {
    const mask = maskSecretFields(page, { masks: () => [], quality: 60, maxBytes: 384 * 1024 });
    const sent = await mask.screen(await undatedFrame());
    expect(sent).toMatchObject({ width: 1280, height: 720 });
  });

  it('does not go when it shows another viewport than its reads measured', async () => {
    const mask = maskSecretFields(page, { masks: () => [], quality: 60, maxBytes: 384 * 1024 });
    const frame = await undatedFrame();
    expect(await withResizedShots(() => mask.screen(frame))).toBeNull();
  });
});

describe('the image of a stopped page', () => {
  it('goes, painted over, when it shows the viewport its reads measured', async () => {
    expect(await maskedImage(page, { quality: 60, timeout: 5000 })).toBeInstanceOf(Buffer);
  });

  it('does not go when it shows another viewport than its reads measured', async () => {
    expect(await withResizedShots(() => maskedImage(page, { quality: 60, timeout: 5000 }))).toBeNull();
  });
});
