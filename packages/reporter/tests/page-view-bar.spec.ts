import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { showPauseBar, takePauseState } from '@piwitests/picker-dom';
import { jpegCodec, maskSecretFields } from '../src/internal/capture/live-mask.js';
import {
  openPageView,
  pauseBarShows,
  type FrameBox,
  type PageFrame,
  type PageViewOptions,
} from '../src/internal/capture/page-view.js';
import { jpegBand } from './_helpers.js';

/**
 * The pause bar painted over in a live view's frames, in a real page (`page-view.ts`): its band read again as the
 * viewport changes, the bar wrapping on a narrower one, for the paint and for the band a viewer's presses keep from,
 * whether the view watched it change or opened after; a frame held back until the bar came down painted from the read
 * made as it was drawn; the band painted in the same pass as the secret fields' masks, and at the lighter quality
 * when the frame is too long at the view's. Each frame is decoded and its pixels checked.
 */

/** A page of noise below where the bar shows, which no JPEG makes small. */
const NOISY = `<!doctype html><style>body { margin: 0; background: white }</style><canvas id="c" width="1000" height="560" style="position:absolute;top:80px"></canvas>
<script>
const context = document.getElementById('c').getContext('2d');
const noise = context.createImageData(1000, 560);
for (let i = 0; i < noise.data.length; i++) noise.data[i] = i % 4 === 3 ? 255 : Math.random() * 255;
context.putImageData(noise, 0, 0);
</script>`;

/** A white page, its content and a password field below where the bar shows. */
const PAGE = `<!doctype html><meta charset="utf-8"><style>body { margin: 0; padding: 200px 20px 20px; background: white }
input { position: absolute; left: 40px; top: 300px; width: 300px; height: 60px; border: 0; background: rgb(0, 200, 0) }</style>
<h1>Shop</h1><input type="password" value="hunter2">`;

const gray = (mean: number[]) => mean.every((channel) => Math.abs(channel - 96) < 16);
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

describe('the pause bar in a live view of its page', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => browser?.close());

  /** Draw the pause bar as a headed stop does, all its buttons shown; returns what takes it down. */
  const drawBar = async (): Promise<() => Promise<void>> => {
    const drawn = page.evaluate(showPauseBar, {
      place: 'shop.spec.ts:12',
      attempt: null,
      action: 'click',
      locator: null,
      record: true,
      end: true,
    });
    const gone = pauseBarShows(page, drawn);
    await drawn;
    return async () => {
      await page.evaluate(takePauseState);
      gone();
    };
  };

  /** The bar's bottom edge as the page lays it out now, in CSS pixels. */
  const barBottom = () => page.locator('#__piwi-pause-bar').evaluate((bar) => bar.getBoundingClientRect().bottom);

  /** A view of the page, the frames it sends kept. */
  const watch = async (screen?: PageViewOptions['screen']) => {
    const sent: PageFrame[] = [];
    const view = await openPageView(page, {
      size: (viewport) => viewport,
      quality: 60,
      fps: 10,
      maxFrameBytes: 384 * 1024,
      lightQuality: 30,
      shotMs: 500,
      busy: () => false,
      live: () => true,
      ...(screen ? { screen } : {}),
      send: (frame) => void sent.push(frame),
      refuse: () => undefined,
    });
    return { view: view!, sent };
  };

  it('reads the bar again as the viewport changes, for its paint and the band presses keep from', async () => {
    page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    await page.setContent(PAGE);
    const takeDown = await drawBar();
    const wide = await barBottom();
    const { view, sent } = await watch();
    try {
      const first = await waitFor(() => sent.find((frame) => frame.width === 1000));
      expect(gray(jpegBand(first.data, first.height, 2, wide - 2).mean)).toBe(true);
      expect(await view.barBand()).toBeCloseTo(wide, 0);

      // Narrower, the bar wraps onto a second row: that row is painted over too, and the band grows with it.
      await page.setViewportSize({ width: 600, height: 640 });
      const narrow = await barBottom();
      expect(narrow).toBeGreaterThan(wide + 20);
      const after = await waitFor(() => sent.find((frame) => frame.width === 600));
      const band = jpegBand(after.data, after.height, 2, narrow - 2);
      expect(band.violet).toBe(0);
      expect(gray(band.mean), `the band of the bar: ${band.mean.join(', ')}`).toBe(true);
      expect(await view.barBand()).toBeCloseTo(narrow, 0);
      // The bar down, presses keep from no band.
      await takeDown();
      expect(await view.barBand()).toBeNull();
    } finally {
      await view.close();
      await takeDown();
      await page.close();
    }
  });

  it('reads the bar again for a view opened after the viewport changed, narrower or wider', async () => {
    for (const [drawnAt, viewedAt] of [
      [1000, 600],
      [600, 1000],
    ] as const) {
      page = await browser.newPage({ viewport: { width: drawnAt, height: 640 } });
      await page.setContent(PAGE);
      const takeDown = await drawBar();
      await page.setViewportSize({ width: viewedAt, height: 640 });
      const bottom = await barBottom();
      const { view, sent } = await watch();
      try {
        const [first] = await waitFor(() => sent.length > 0 && sent);
        expect(first!.width).toBe(viewedAt);
        const band = jpegBand(first!.data, first!.height, 2, bottom - 2);
        expect(band.violet).toBe(0);
        expect(gray(band.mean), `drawn at ${drawnAt}, viewed at ${viewedAt}: ${band.mean.join(', ')}`).toBe(true);
        // The page below the bar is left as it is.
        expect(jpegBand(first!.data, first!.height, bottom + 30, bottom + 60).mean.every((c) => c > 235)).toBe(true);
        expect(await view.barBand()).toBeCloseTo(bottom, 0);
      } finally {
        await view.close();
        await takeDown();
        await page.close();
      }
    }
  });

  it('paints a frame held back until the bar came down from the read made as it was drawn', async () => {
    page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    await page.setContent(PAGE);
    const takeDown = await drawBar();
    const bottom = await barBottom();
    let reached!: () => void;
    const held = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const boxes: FrameBox[][] = [];
    // A frame held back, as the masks' reads or a post in flight hold one: the bar comes down meanwhile.
    const { view } = await watch(async (frame, also) => {
      reached();
      await gate;
      boxes.push(await also(frame));
      return frame;
    });
    try {
      await held;
      await takeDown();
      release();
      const [box] = await waitFor(() => boxes[0]);
      expect(box?.height).toBeCloseTo(bottom, 0);
    } finally {
      release();
      await view.close();
      await page.close();
    }
  });

  it('paints the bar’s band in the same pass as the secret fields’ masks', async () => {
    page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    await page.setContent(PAGE);
    const takeDown = await drawBar();
    const bottom = await barBottom();
    const jpeg = jpegCodec()!;
    const encode = jpeg.encode;
    let encoded = 0;
    jpeg.encode = (image, quality) => {
      encoded++;
      return encode.call(jpeg, image, quality);
    };
    const mask = maskSecretFields(page, { masks: () => [], quality: 50, lightQuality: 30, maxBytes: 192 * 1024 });
    const { view, sent } = await watch((frame, also) => mask.screen(frame, also));
    try {
      const [frame] = await waitFor(() => sent.length > 0 && sent);
      expect(encoded).toBe(1);
      expect(gray(jpegBand(frame!.data, frame!.height, 2, bottom - 2).mean)).toBe(true);
      // The password field, inside its box: the mask's gray, never its green.
      expect(gray(jpegBand(frame!.data, frame!.height, 310, 350, 50, 330).mean)).toBe(true);
    } finally {
      jpeg.encode = encode;
      await view.close();
      await takeDown();
      await page.close();
    }
  });

  it('encodes a frame with the bar alone at the lighter quality when it is too long at the view’s', async () => {
    page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    await page.setContent(NOISY);
    const takeDown = await drawBar();
    // Between the page's image at the view's quality and at the lighter one, the bar painted over in both.
    const jpeg = jpegCodec()!;
    const image = jpeg.decode(await page.screenshot({ type: 'jpeg', quality: 90 }), {
      useTArray: true,
      formatAsRGBA: true,
    });
    const maxBytes = (jpeg.encode(image, 95).data.length + jpeg.encode(image, 10).data.length) / 2;
    const mask = maskSecretFields(page, { masks: () => [], quality: 95, lightQuality: 10, maxBytes });
    const { view, sent } = await watch((frame, also) => mask.screen(frame, also));
    try {
      const [frame] = await waitFor(() => sent.length > 0 && sent);
      expect(frame!.data.length).toBeLessThanOrEqual(maxBytes);
      expect(jpegBand(frame!.data, frame!.height, 2, 40).violet).toBe(0);
    } finally {
      await view.close();
      await takeDown();
      await page.close();
    }
  });
});
