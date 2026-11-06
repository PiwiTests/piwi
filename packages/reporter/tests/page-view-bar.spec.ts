import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { showPauseBar, takePauseState } from '@piwitests/picker-dom';
import {
  laneBarBand,
  lanePage,
  laneTestBegan,
  laneTestEnded,
  subscribeLane,
} from '../src/internal/capture/lane-feed.js';
import { jpegCodec, maskSecretFields, withoutPauseBar } from '../src/internal/capture/live-mask.js';
import {
  openPageView,
  pauseBarShows,
  type FrameBox,
  type PageFrame,
  type PageViewOptions,
} from '../src/internal/capture/page-view.js';
import { keyMayPlay, type BarHold } from '../src/internal/capture/run-channel.js';
import { jpegBand } from './_helpers.js';

/**
 * The pause bar painted over in a live view's frames, in a real page (`page-view.ts`), each frame screened by the
 * secret fields' mask as the lane's are: its band read again as the viewport changes, the bar wrapping on a narrower
 * one, for the paint and for the band a viewer's presses keep from, whether the view watched it change or opened
 * after; a frame from before an image of the page taken without the bar, its bar read while that image is taken,
 * painted once it is; a bar laid out nowhere in the viewport painted nowhere, at one read a frame; a frame held back
 * until the bar came down painted from the read made as it was drawn; the band painted in the same pass as the secret
 * fields' masks, at the lighter quality when the frame is too long at the view's, and the next frame held back for
 * that paint alone; the lane's frames painted for every sink, its band following the bar drawn again. Each frame is
 * decoded and its pixels checked. A viewer's key press waits for the bar to be held inert, plays once no bar shows,
 * and holds nothing once its stop ended; a key's release always plays (`keyMayPlay`).
 */

/** A page of noise below where the bar shows, which no JPEG makes small. */
const NOISY = `<!doctype html><style>body { margin: 0; background: white }</style><canvas id="c" width="1000" height="560" style="position:absolute;top:80px"></canvas>
<script>
const context = document.getElementById('c').getContext('2d');
const noise = context.createImageData(1000, 560);
for (let i = 0; i < noise.data.length; i++) noise.data[i] = i % 4 === 3 ? 255 : Math.random() * 255;
context.putImageData(noise, 0, 0);
</script>`;

/** A page that paints all the time, below where the bar shows. */
const ANIMATED = `<!doctype html><style>body { margin: 0; padding: 200px 20px 20px; background: white }
#spin { width: 80px; height: 80px; background: linear-gradient(red, blue); animation: s 1s linear infinite } @keyframes s { to { transform: rotate(360deg) } }</style>
<div id="spin"></div>`;

/** A page whose `body` has a transform, which the fixed pause bar is laid out in: scrolled down, the bar is too. */
const TRANSFORMED = `<!doctype html><style>body { margin: 0; height: 4000px; background: white; transform: translateZ(0) }</style>
<h1>Shop</h1>`;

/** A white page, its content and a password field below where the bar shows. */
const PAGE = `<!doctype html><meta charset="utf-8"><style>body { margin: 0; padding: 200px 20px 20px; background: white }
input { position: absolute; left: 40px; top: 300px; width: 300px; height: 60px; border: 0; background: rgb(0, 200, 0) }</style>
<h1>Shop</h1><input type="password" value="hunter2">`;

const gray = (mean: number[]) => mean.every((channel) => Math.abs(channel - 96) < 16);
const white = (mean: number[]) => mean.every((channel) => channel > 235);
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

  /** A view of the page, the frames it sends kept, each screened by the secret fields' mask unless `screen` says. */
  const watch = async (screen?: PageViewOptions['screen']) => {
    const sent: PageFrame[] = [];
    const mask = maskSecretFields(page, { masks: () => [], quality: 60, lightQuality: 30, maxBytes: 384 * 1024 });
    const view = await openPageView(page, {
      size: (viewport) => viewport,
      quality: 60,
      fps: 10,
      maxFrameBytes: 384 * 1024,
      lightQuality: 30,
      shotMs: 500,
      busy: () => false,
      live: () => true,
      screen: screen ?? ((frame, also) => mask.screen(frame, also)),
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

  it('paints a frame from before an image of the page taken without the bar, its bar read once that image is taken', async () => {
    page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    await page.setContent(PAGE);
    const takeDown = await drawBar();
    const bottom = await barBottom();
    let reached!: () => void;
    const held = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const boxes: FrameBox[][] = [];
    // The view's first frame, which reads the bar again, held back as the masks' reads hold one.
    const { view } = await watch(async (frame, also) => {
      reached();
      await gate;
      boxes.push(await also(frame));
      return frame;
    });
    try {
      await held;
      // An image of the page taken without the bar, which hides it longer than a read waits: the frame's read is made
      // while it is taken, and waits for it.
      const taken = withoutPauseBar(page, async (style) => {
        const hidden = await page.addStyleTag({ content: style });
        await sleep(1500);
        await hidden.evaluate((tag) => (tag as unknown as { remove(): void }).remove());
      });
      await sleep(100);
      release();
      const [box] = await waitFor(() => boxes[0]);
      expect(box?.height).toBeCloseTo(bottom, 0);
      await taken;
    } finally {
      release();
      await view.close();
      await takeDown();
      await page.close();
    }
  }, 30_000);

  it('paints no band and keeps presses from none for a bar laid out nowhere in the viewport, at one read a frame', async () => {
    page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    await page.setContent(TRANSFORMED);
    // Drawn, then scrolled out of the viewport with the body it is laid out in: the read made as it was drawn is stale.
    const takeDown = await drawBar();
    expect(await barBottom()).toBeGreaterThan(0);
    await page.evaluate(() => (globalThis as unknown as { scrollTo(x: number, y: number): void }).scrollTo(0, 2000));
    expect(await barBottom()).toBeLessThanOrEqual(0);
    const { view, sent } = await watch();
    try {
      const [frame] = await waitFor(() => sent.length > 0 && sent);
      expect(white(jpegBand(frame!.data, frame!.height, 2, 40).mean)).toBe(true);
      for (let i = 0; i < 3; i++) {
        const asked = Date.now();
        expect(await view.barBand()).toBeNull();
        expect(Date.now() - asked).toBeLessThan(300);
      }
    } finally {
      await view.close();
      await takeDown();
      await page.close();
    }
  }, 30_000);

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

  it('holds the next frame back as long again as the bar’s paint took, not the reads before it', async () => {
    page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    await page.setContent(ANIMATED);
    const takeDown = await drawBar();
    const screened: Array<{ began: number; ended: number }> = [];
    // A screen whose reads take a while before it asks for the bar's boxes, then paints at once.
    const { view } = await watch(async (frame, also) => {
      const began = Date.now();
      await sleep(400);
      await also(frame);
      screened.push({ began, ended: Date.now() });
      return frame;
    });
    try {
      await waitFor(() => screened.length >= 6 || undefined, 20_000);
      const gaps = screened
        .slice(1)
        .map((next, i) => next.began - screened[i]!.ended)
        .sort((a, b) => a - b);
      expect(gaps[Math.floor(gaps.length / 2)]!).toBeLessThan(250);
    } finally {
      await view.close();
      await takeDown();
      await page.close();
    }
  }, 30_000);

  it('paints the bar over in the lane’s frames, its band following the bar drawn again', async () => {
    page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    await page.setContent(PAGE);
    laneTestBegan('lane-test');
    lanePage(page);
    const takeDown = await drawBar();
    const bottom = await barBottom();
    const sent: PageFrame[] = [];
    const lane = subscribeLane({
      maxWidth: 1280,
      maxHeight: 800,
      quality: 60,
      fps: 10,
      maxFrameBytes: 384 * 1024,
      lightQuality: 30,
      shotMs: 500,
      busy: () => false,
      send: (frame) => void sent.push(frame),
      refuse: () => undefined,
    });
    try {
      const frame = await waitFor(() => sent[0]);
      const band = jpegBand(frame.data, frame.height, 2, bottom - 2);
      expect(band.violet).toBe(0);
      expect(gray(band.mean), `the band of the bar: ${band.mean.join(', ')}`).toBe(true);
      expect(await laneBarBand(page)).toBeCloseTo(bottom, 0);
      // Presses keep from no band while the bar is down, and from the band of the bar drawn again.
      await takeDown();
      expect(await laneBarBand(page)).toBeNull();
      const again = await drawBar();
      expect(await laneBarBand(page)).toBeCloseTo(bottom, 0);
      await again();
    } finally {
      await lane.close();
      await laneTestEnded();
      await takeDown();
      await page.close();
    }
  });

  const PRESS = { action: 'press' } as const;
  /** A message's hold on the bar, before it met any. */
  const freshHold = (token: number): BarHold => ({ token, drawn: null, held: false, sent: false });
  const never = new Promise<void>(() => undefined);

  it('plays a viewer’s key once the bar is held inert for its message, and once no bar shows', async () => {
    page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    await page.setContent(PAGE);
    const takeDown = await drawBar();
    try {
      const hold = freshHold(1);
      expect(await keyMayPlay(page, PRESS, hold, never, () => true)).toBe(true);
      expect(hold).toMatchObject({ held: true, sent: true });
      expect(await page.locator('#__piwi-pause-bar').evaluate((bar) => (bar as unknown as { inert: boolean }).inert)).toBe(true);
      // A draw the hold is not answered for, as one a navigation takes away, takes none of the message's keys.
      const failed = pauseBarShows(page, Promise.reject(new Error('Execution context was destroyed')));
      expect(await keyMayPlay(page, PRESS, hold, never, () => true)).toBe(false);
      expect(await keyMayPlay(page, PRESS, hold, never, () => true)).toBe(false);
      // A key's release plays all the same: the bar listens to presses alone.
      expect(await keyMayPlay(page, { action: 'up' }, hold, never, () => true)).toBe(true);
      expect(await keyMayPlay(page, { action: 'down' }, hold, never, () => true)).toBe(false);
      // Once that bar is down, with none drawn again, the message's next keys play.
      failed();
      expect(await keyMayPlay(page, PRESS, hold, never, () => true)).toBe(true);
    } finally {
      await takeDown();
      await page.close();
    }
  });

  it('holds no bar for a key whose stop ended while the bar was drawn', async () => {
    page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    await page.setContent(PAGE);
    const takeDown = await drawBar();
    // A draw the page has not answered yet.
    const gone = pauseBarShows(page, never);
    let end = (): void => undefined;
    const over = new Promise<void>((resolve) => (end = resolve));
    let going = true;
    const hold = freshHold(2);
    try {
      const asked = keyMayPlay(page, PRESS, hold, over, () => going);
      await sleep(200);
      going = false;
      end();
      const ended = Date.now();
      expect(await asked).toBe(false);
      expect(Date.now() - ended).toBeLessThan(1000);
      expect(hold.sent).toBe(false);
      await sleep(300);
      expect(await page.locator('#__piwi-pause-bar').evaluate((bar) => (bar as unknown as { inert: boolean }).inert)).toBe(false);
    } finally {
      gone();
      await takeDown();
      await page.close();
    }
  });
});
