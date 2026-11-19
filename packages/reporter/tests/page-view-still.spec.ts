import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { openPageView, type PageFrame, type PageViewOptions } from '../src/internal/capture/page-view.js';

/**
 * A live view of a still page (`page-view.ts`), its test waiting on a locator, in a real page: the view shows it though
 * its screencast paints no frame as the view opens, or `screen` sent none for the one it painted. An image of the page
 * goes in its place, three at most until a frame goes or the page paints anew, and none for a page whose screencast's
 * frames go; a view of images on a timer tries the next one again though it is the same as the one that did not go.
 */

const STILL = `<!doctype html><meta charset="utf-8"><style>body { margin: 0; padding: 20px; font: 16px sans-serif }</style>
<h1>Checkout</h1><button disabled>Pay</button>`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined | false, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await sleep(20);
  }
}

/** Count the images taken of `page`: the view takes them through `page.screenshot`. */
function countImages(page: Page): () => number {
  const own = page.screenshot.bind(page);
  let count = 0;
  page.screenshot = ((options) => {
    count++;
    return own(options);
  }) as Page['screenshot'];
  return () => count;
}

/** Give `page` a screencast that starts and paints nothing, as one that paints only as the page changes. */
function silentScreencast(page: Page): void {
  Object.defineProperty(page, 'screencast', {
    configurable: true,
    value: { start: async () => ({ dispose: async () => undefined }), stop: async () => undefined },
  });
}

/** Take `page`'s screencast away: the view takes images of it on a timer. */
function noScreencast(page: Page): void {
  Object.defineProperty(page, 'screencast', { configurable: true, value: undefined });
}

/** A view whose `screen` sends a frame as `pass` says, by its number from 0; the frames sent, in order. */
function viewOptions(
  pass: (index: number) => boolean,
  shotMs = 1000,
): { options: PageViewOptions; sent: PageFrame[] } {
  const sent: PageFrame[] = [];
  let screened = 0;
  return {
    sent,
    options: {
      size: () => ({ width: 640, height: 400 }),
      quality: 50,
      fps: 4,
      maxFrameBytes: 192 * 1024,
      lightQuality: 30,
      shotMs,
      busy: () => false,
      live: () => true,
      screen: async (frame) => (pass(screened++) ? frame : null),
      send: (frame) => sent.push(frame),
      refuse: () => undefined,
    },
  };
}

describe('a live view of a still page', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => browser?.close());

  async function stillPage(): Promise<Page> {
    page = await browser.newPage({ viewport: { width: 1000, height: 625 } });
    await page.setContent(STILL);
    return page;
  }

  it('shows a page whose screencast paints no frame as the view opens, with one image of it', async () => {
    const shown = await stillPage();
    silentScreencast(shown);
    const images = countImages(shown);
    const { options, sent } = viewOptions(() => true);
    const view = await openPageView(shown, options);
    try {
      await waitFor(() => sent.length > 0, 2000);
      await sleep(1500);
      expect(images()).toBe(1);
      expect(sent).toHaveLength(1);
    } finally {
      await view?.close();
      await shown.close();
    }
  });

  it('shows a page whose painted frame did not go with an image of it, a second later', async () => {
    const shown = await stillPage();
    const images = countImages(shown);
    const { options, sent } = viewOptions((index) => index > 0);
    const opened = Date.now();
    const view = await openPageView(shown, options);
    try {
      await waitFor(() => sent.length > 0, 3000);
      expect(Date.now() - opened).toBeGreaterThanOrEqual(900);
      await sleep(1500);
      expect(images()).toBe(1);
    } finally {
      await view?.close();
      await shown.close();
    }
  });

  it('tries three images of a page whose frames never go, then none until it paints anew', async () => {
    const shown = await stillPage();
    const images = countImages(shown);
    const { options, sent } = viewOptions(() => false, 300);
    const view = await openPageView(shown, options);
    try {
      await waitFor(() => images() === 3, 5000);
      await sleep(1500);
      expect(images()).toBe(3);
      await shown.setContent(STILL.replace('Checkout', 'Checkout now'));
      await waitFor(() => images() > 3, 5000);
      await sleep(1500);
      expect(images()).toBe(6);
      expect(sent).toEqual([]);
    } finally {
      await view?.close();
      await shown.close();
    }
  });

  it('takes no image of a page whose screencast frame goes', async () => {
    const shown = await stillPage();
    const images = countImages(shown);
    const { options, sent } = viewOptions(() => true);
    const view = await openPageView(shown, options);
    try {
      await waitFor(() => sent.length > 0, 2000);
      await sleep(1500);
      expect(images()).toBe(0);
      expect(sent).toHaveLength(1);
    } finally {
      await view?.close();
      await shown.close();
    }
  });

  it('tries an image on a timer again, the same as the one that did not go', async () => {
    const shown = await stillPage();
    noScreencast(shown);
    const { options, sent } = viewOptions((index) => index > 0, 300);
    const view = await openPageView(shown, options);
    try {
      expect(view?.screencast).toBe(false);
      await waitFor(() => sent.length > 0, 3000);
      await sleep(1000);
      // The page paints no other: its later images, the same, go nowhere.
      expect(sent).toHaveLength(1);
    } finally {
      await view?.close();
      await shown.close();
    }
  });
});
