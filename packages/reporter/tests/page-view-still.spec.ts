import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, devices, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { jpegSize } from '../src/internal/capture/live-mask.js';
import { openPageView, type PageFrame, type PageViewOptions } from '../src/internal/capture/page-view.js';

/**
 * A live view of a still page (`page-view.ts`), its test waiting on a locator, in real Chromium. The view shows the
 * page though its screencast gives no first frame (a stand-in screencast that paints nothing, as one that sends a frame
 * only as the page changes) or `screen` sent none for the frame the page painted: an image of the page goes in its
 * place, and goes no later than a frame the page painted anew meanwhile. Three images at most are tried until a frame
 * the page painted goes, a test's video recording included, and none for a page whose frame goes; a still page is tried
 * again after the viewers heard why no frame went. A view of images on a timer tries the next one again though it is
 * the same as the one that did not go, three times at most. Every image a view takes goes at the size it asks: a still
 * page's and a timed one name it for `screen` to scale them down to, and a lighter one is scaled down with `jpeg-js`,
 * which then goes where the whole page's would be too long, the view saying once why none goes where it is too long
 * as well; and taking them leaves the page as the test set it (its device scale factor, viewport and screen).
 */

const STILL = `<!doctype html><meta charset="utf-8"><style>body { margin: 0; padding: 20px; font: 16px sans-serif }</style>
<h1>Checkout</h1><button disabled>Pay</button>`;
const PAID = STILL.replace('Checkout', 'Paid');
/**
 * A page of noise, which no JPEG makes small: 236 KB whole at quality 50, 112 KB at the asked size, 69 KB at 30, and
 * 160 KB whole at 30.
 */
const NOISY = `<!doctype html><style>body { margin: 0 }</style><canvas id="c" width="1000" height="625"></canvas>
<script>
const context = document.getElementById('c').getContext('2d');
const noise = context.createImageData(1000, 625);
for (let i = 0; i < noise.data.length; i++) noise.data[i] = i % 4 === 3 ? 255 : Math.random() * 255;
context.putImageData(noise, 0, 0);
</script>`;
const VIEWPORT = { width: 1000, height: 625 };
/** The size each view asks of the page's screencast, and of the images it takes in its place. */
const ASKED = { width: 640, height: 400 };
const TIMEOUT = 30_000;

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

/** The size a frame goes at once `screen` took it: the size it names (`fit`), else its own. */
function goesAt(frame: PageFrame): { width: number; height: number } | null {
  return frame.fit ?? jpegSize(frame.data);
}

/** Wait until the page painted what it holds: its screencast's first frame then shows it whole. */
async function presented(page: Page): Promise<void> {
  type Window = { requestAnimationFrame(callback: () => void): void };
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const view = globalThis as unknown as Window;
        view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve()));
      }),
  );
}

/** The images the view takes of a page: how many it asked for, how many came back, and what lets the held ones go. */
interface Images {
  asked(): number;
  taken(): number;
  letGo(): void;
}

/** Follow the images taken of `page`; with `hold`, each comes back to the view once the test lets it (`letGo`). */
function followImages(page: Page, hold = false): Images {
  let asked = 0;
  let taken = 0;
  let letGo = (): void => undefined;
  const held = hold ? new Promise<void>((resolve) => (letGo = resolve)) : Promise.resolve();
  const screenshot = page.screenshot.bind(page);
  page.screenshot = (async (options) => {
    asked++;
    const image = await screenshot(options);
    taken++;
    await held;
    return image;
  }) as Page['screenshot'];
  return { asked: () => asked, taken: () => taken, letGo: () => letGo() };
}

/** Give `page` a screencast that starts and paints nothing, as one that sends a frame only as the page changes. */
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

/** What a view hands its viewers, and how many frames went to its `screen`. */
interface Seen {
  sent: PageFrame[];
  refused: Array<string | undefined>;
  screened: () => number;
}

/**
 * A view whose `screen` answers each frame, by its number from 0, as `answer` says: the frame, none, or why none goes.
 */
function viewOptions(
  answer: (index: number) => 'send' | 'drop' | string,
  shotMs = 1000,
  more: Partial<PageViewOptions> = {},
): { options: PageViewOptions; seen: Seen } {
  const seen: Seen = { sent: [], refused: [], screened: () => screened };
  let screened = 0;
  return {
    seen,
    options: {
      size: () => ASKED,
      quality: 50,
      fps: 4,
      maxFrameBytes: 192 * 1024,
      lightQuality: 30,
      shotMs,
      busy: () => false,
      live: () => true,
      screen: async (frame) => {
        const said = answer(screened++);
        return said === 'send' ? frame : said === 'drop' ? null : said;
      },
      send: (frame) => seen.sent.push(frame),
      refuse: (why) => seen.refused.push(why),
      ...more,
    },
  };
}

describe('a live view of a still page', () => {
  let browser: Browser;
  const videos = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-page-view-still-'));

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
    fs.rmSync(videos, { recursive: true, force: true });
  });

  /**
   * Run `test` on a new still page (`html`), presented, in a context of its own, which closes after it whatever
   * happens.
   */
  async function onStillPage(
    test: (page: Page) => Promise<void>,
    context: BrowserContextOptions = {},
    html = STILL,
  ): Promise<void> {
    const own = await browser.newContext({ viewport: VIEWPORT, ...context });
    try {
      const page = await own.newPage();
      await page.setContent(html);
      await presented(page);
      await test(page);
    } finally {
      await own.close();
    }
  }

  it(
    'shows a page whose screencast gives no first frame with one image of it, at the size the view asks',
    () =>
      onStillPage(async (page) => {
        silentScreencast(page);
        const images = followImages(page).asked;
        const { options, seen } = viewOptions(() => 'send');
        const view = await openPageView(page, options);
        try {
          await waitFor(() => seen.sent.length > 0, 3000);
          await sleep(1500);
          expect(images()).toBe(1);
          expect(seen.sent).toHaveLength(1);
          const [image] = seen.sent;
          expect(goesAt(image!)).toEqual(ASKED);
          expect({ width: image!.width, height: image!.height }).toEqual(VIEWPORT);
        } finally {
          await view?.close();
        }
      }),
    TIMEOUT,
  );

  it(
    'shows a page whose painted frame did not go with one image of it, a second later',
    () =>
      onStillPage(async (page) => {
        const images = followImages(page).asked;
        // The frames the page paints before the view takes an image of it do not go.
        const { options, seen } = viewOptions(() => (images() > 0 ? 'send' : 'drop'));
        const opened = Date.now();
        const view = await openPageView(page, options);
        try {
          await waitFor(() => seen.sent.length > 0, 5000);
          expect(Date.now() - opened).toBeGreaterThanOrEqual(900);
          await sleep(1500);
          expect(images()).toBe(1);
          // The frame the screencast paints again as the image is taken does not go too.
          expect(seen.sent).toHaveLength(1);
          expect(goesAt(seen.sent[0]!)).toEqual(ASKED);
        } finally {
          await view?.close();
        }
      }),
    TIMEOUT,
  );

  it(
    'takes no image of a page whose screencast frame goes',
    () =>
      onStillPage(async (page) => {
        const images = followImages(page).asked;
        const { options, seen } = viewOptions(() => 'send');
        const view = await openPageView(page, options);
        try {
          await waitFor(() => seen.sent.length > 0, 3000);
          await sleep(1500);
          expect(images()).toBe(0);
        } finally {
          await view?.close();
        }
      }),
    TIMEOUT,
  );

  it(
    'tries three images of a page whose frames never go, then none until a frame the page painted goes',
    () =>
      onStillPage(async (page) => {
        const images = followImages(page).asked;
        let pass = false;
        const { options, seen } = viewOptions(() => (pass ? 'send' : 'drop'), 300);
        const view = await openPageView(page, options);
        try {
          await waitFor(() => images() === 3, 5000);
          await sleep(1500);
          expect(images()).toBe(3);
          // The page paints anew, and that frame does not go either: no image is tried.
          await page.setContent(PAID);
          await sleep(1500);
          expect(images()).toBe(3);
          // A frame the page painted goes: a page that shows nothing later is tried again.
          pass = true;
          await page.setContent(STILL);
          await waitFor(() => seen.sent.length > 0, 3000);
          pass = false;
          await page.setContent(PAID);
          await waitFor(() => images() > 3, 3000);
          await sleep(1500);
          expect(images()).toBeLessThanOrEqual(6);
        } finally {
          await view?.close();
        }
      }),
    TIMEOUT,
  );

  it(
    'tries three images of a page whose frames never go while its test records a video',
    () =>
      onStillPage(
        async (page) => {
          const images = followImages(page).asked;
          const { options } = viewOptions(() => 'drop', 300);
          const view = await openPageView(page, options);
          try {
            await waitFor(() => images() === 3, 5000);
            await sleep(1500);
            expect(images()).toBe(3);
          } finally {
            await view?.close();
          }
        },
        { recordVideo: { dir: videos, size: ASKED } },
      ),
    TIMEOUT,
  );

  it(
    'never sends an image of the page after a frame the page painted anew while it was taken',
    () =>
      onStillPage(async (page) => {
        // The first image of the page is taken at once, and comes back once the test lets it.
        const images = followImages(page, true);
        const { options, seen } = viewOptions((index) => (index === 0 ? 'drop' : 'send'));
        const view = await openPageView(page, options);
        try {
          await waitFor(() => images.taken() > 0, 5000);
          await page.setContent(PAID);
          await presented(page);
          await waitFor(() => seen.sent.length > 0, 3000);
          await sleep(500);
          const before = seen.sent.length;
          images.letGo();
          await sleep(1000);
          // The image taken before the page painted anew goes nowhere: the newer frame stays the latest shown.
          expect(seen.sent).toHaveLength(before);
        } finally {
          images.letGo();
          await view?.close();
        }
      }),
    TIMEOUT,
  );

  it(
    'tries a still page again after its viewers heard why no frame went',
    () =>
      onStillPage(async (page) => {
        const { options, seen } = viewOptions((index) => (index === 0 ? 'The page cannot be read now.' : 'send'));
        const view = await openPageView(page, options);
        try {
          await waitFor(() => seen.sent.length > 0, 5000);
          expect(seen.refused).toEqual(['The page cannot be read now.']);
        } finally {
          await view?.close();
        }
      }),
    TIMEOUT,
  );

  it(
    'tries an image on a timer again, the same as the one that did not go',
    () =>
      onStillPage(async (page) => {
        noScreencast(page);
        const { options, seen } = viewOptions((index) => (index > 0 ? 'send' : 'drop'), 300);
        const view = await openPageView(page, options);
        try {
          expect(view?.screencast).toBe(false);
          await waitFor(() => seen.sent.length > 0, 3000);
          await sleep(1000);
          // The page paints no other: its later images, the same, go nowhere.
          expect(seen.sent).toHaveLength(1);
        } finally {
          await view?.close();
        }
      }),
    TIMEOUT,
  );

  it(
    'tries an image on a timer that never goes three times at most',
    () =>
      onStillPage(async (page) => {
        noScreencast(page);
        const { options, seen } = viewOptions(() => 'drop', 300);
        const view = await openPageView(page, options);
        try {
          // The first image and three tries of the same one.
          await waitFor(() => seen.screened() === 4, 5000);
          await sleep(1500);
          expect(seen.screened()).toBe(4);
        } finally {
          await view?.close();
        }
      }),
    TIMEOUT,
  );

  it(
    'takes its timed images at the size it asks',
    () =>
      onStillPage(async (page) => {
        noScreencast(page);
        const { options, seen } = viewOptions(() => 'send', 300);
        const view = await openPageView(page, options);
        try {
          await waitFor(() => seen.sent.length > 0, 3000);
          const [image] = seen.sent;
          expect(goesAt(image!)).toEqual(ASKED);
          expect({ width: image!.width, height: image!.height }).toEqual(VIEWPORT);
        } finally {
          await view?.close();
        }
      }),
    TIMEOUT,
  );

  it(
    "sends a lighter image at the size it asks, where the whole page's would be too long",
    () =>
      onStillPage(
        async (page) => {
          noScreencast(page);
          const { options, seen } = viewOptions(() => 'send', 300, { maxFrameBytes: 90 * 1024 });
          const view = await openPageView(page, options);
          try {
            await waitFor(() => seen.sent.length > 0 || seen.refused.length > 0, 5000);
            expect(seen.refused).toEqual([]);
            const [image] = seen.sent;
            expect(jpegSize(image!.data)).toEqual(ASKED);
            expect(image!.data.length).toBeLessThanOrEqual(90 * 1024);
          } finally {
            await view?.close();
          }
        },
        {},
        NOISY,
      ),
    TIMEOUT,
  );

  it(
    "sends an image that fits at the size it asks as it is, once, though the whole page's would be too long",
    () =>
      onStillPage(
        async (page) => {
          noScreencast(page);
          const { options, seen } = viewOptions(() => 'send', 300, { maxFrameBytes: 180 * 1024 });
          const view = await openPageView(page, options);
          try {
            await waitFor(() => seen.sent.length > 0, 3000);
            await sleep(1500);
            // Not a lighter image in its place, and not again while the page paints no other.
            expect(seen.sent).toHaveLength(1);
            expect(seen.sent[0]!.fit).toEqual(ASKED);
            expect(seen.refused).toEqual([]);
          } finally {
            await view?.close();
          }
        },
        {},
        NOISY,
      ),
    TIMEOUT,
  );

  it(
    'says once why no image goes when the lighter one is too long as well',
    () =>
      onStillPage(async (page) => {
        noScreencast(page);
        const { options, seen } = viewOptions(() => 'send', 300, { maxFrameBytes: 1024 });
        const view = await openPageView(page, options);
        try {
          await waitFor(() => seen.refused.length > 0, 5000);
          await sleep(1500);
          expect(seen.refused).toEqual([undefined]);
          expect(seen.sent).toEqual([]);
        } finally {
          await view?.close();
        }
      }),
    TIMEOUT,
  );

  for (const [name, context] of [
    ['a device scale factor of 2', { deviceScaleFactor: 2 }],
    ['a phone', { ...devices['Pixel 5'], viewport: devices['Pixel 5']!.viewport }],
  ] as const) {
    it(
      `takes its images of a page on ${name} without changing what the page sees`,
      () =>
        onStillPage(async (page) => {
          type Window = {
            devicePixelRatio: number;
            innerWidth: number;
            screen: { width: number; height: number };
            resizes?: number;
            addEventListener(type: string, listener: () => void): void;
          };
          const read = () =>
            page.evaluate(() => {
              const view = globalThis as unknown as Window;
              return {
                ratio: view.devicePixelRatio,
                width: view.innerWidth,
                screen: { width: view.screen.width, height: view.screen.height },
                resizes: view.resizes ?? 0,
              };
            });
          await page.evaluate(() => {
            const view = globalThis as unknown as Window;
            view.resizes = 0;
            view.addEventListener('resize', () => (view.resizes = (view.resizes ?? 0) + 1));
          });
          const before = await read();
          noScreencast(page);
          const { options, seen } = viewOptions(() => 'send', 300);
          const view = await openPageView(page, options);
          try {
            // An image goes, and more are taken, one every 300 ms.
            await waitFor(() => seen.sent.length > 0, 5000);
            await sleep(1500);
            expect(await read()).toEqual(before);
          } finally {
            await view?.close();
          }
        }, context),
      TIMEOUT,
    );
  }
});
