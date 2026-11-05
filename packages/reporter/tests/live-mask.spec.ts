import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import { jpegCodec, maskedImage } from '../src/internal/capture/live-mask.js';

/**
 * Where the live view's masks go for a child frame, on a page of two frames that answers as told: a password field in
 * the child is painted over where its iframe is drawn, the iframe painted over whole when the child does not answer,
 * and no image goes when the iframe has no box to place them by.
 */

const WIDTH = 800;
const HEIGHT = 600;
/** Where the child frame's iframe is drawn in the page's viewport, in CSS pixels. */
const IFRAME = { x: 400, y: 300, width: 300, height: 150 };
/** The password field in the child frame's viewport: x, y, width and height. */
const FIELD = [10, 20, 100, 50] as const;

/** A page whose child frame's iframe has `iframeBox` (null: no box), its child frame answering or not. */
function twoFramePage(iframeBox: typeof IFRAME | null, childAnswers: boolean) {
  const jpeg = jpegCodec()!;
  const white = new Uint8Array(WIDTH * HEIGHT * 4).fill(255);
  const shot = jpeg.encode({ width: WIDTH, height: HEIGHT, data: white }, 90).data;
  const never = new Promise<never>(() => {});
  const frame = (read: () => Promise<unknown>, fields: () => Promise<unknown[]>, iframe?: unknown) => ({
    locator: () => ({ evaluateAll: read, elementHandles: fields }),
    frameElement: async () => iframe,
    isDetached: () => false,
  });
  const main = frame(
    async () => ({ rects: [], width: WIDTH, height: HEIGHT, zoomed: false }),
    async () => [],
  );
  const child = frame(
    () => (childAnswers ? Promise.resolve({ rects: [FIELD], width: IFRAME.width, height: IFRAME.height }) : never),
    () => (childAnswers ? Promise.resolve([]) : never),
    {
      boundingBox: async () => iframeBox,
      evaluate: async () => ({
        left: 0,
        top: 0,
        width: IFRAME.width,
        height: IFRAME.height,
        offsetWidth: IFRAME.width,
        offsetHeight: IFRAME.height,
      }),
      dispose: async () => {},
    },
  );
  const screenshot = vi.fn(async () => shot);
  return { page: { frames: () => [main, child], mainFrame: () => main, screenshot } as unknown as Page, screenshot };
}

/** The image's color at (`x`, `y`), in CSS pixels, which are its pixels here. */
function colorAt(image: Buffer, x: number, y: number): number[] {
  const decoded = jpegCodec()!.decode(image, { useTArray: true, formatAsRGBA: true });
  const i = (y * decoded.width + x) * 4;
  return [decoded.data[i]!, decoded.data[i + 1]!, decoded.data[i + 2]!];
}

const painted = (rgb: number[]) => rgb.every((channel) => Math.abs(channel - 96) < 24);

describe('a child frame’s masks', () => {
  it('are painted where its iframe is drawn', async () => {
    const { page } = twoFramePage(IFRAME, true);
    const image = await maskedImage(page, { quality: 90, timeout: 1000 });
    expect(image).not.toBeNull();
    const [left, top, width, height] = FIELD;
    expect(painted(colorAt(image!, IFRAME.x + left + width / 2, IFRAME.y + top + height / 2))).toBe(true);
    expect(painted(colorAt(image!, IFRAME.x + left + width + 40, IFRAME.y + top + height / 2))).toBe(false);
  });

  it('give no image while its iframe has no box to place them by', async () => {
    const { page, screenshot } = twoFramePage(null, true);
    expect(await maskedImage(page, { quality: 90, timeout: 1000 })).toBeNull();
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('cover its whole iframe when it does not answer', async () => {
    const { page } = twoFramePage(IFRAME, false);
    const image = await maskedImage(page, { quality: 90, timeout: 1000 });
    expect(image).not.toBeNull();
    for (const [x, y] of [
      [IFRAME.x + 5, IFRAME.y + 5],
      [IFRAME.x + IFRAME.width - 5, IFRAME.y + IFRAME.height - 5],
    ] as const) {
      expect(painted(colorAt(image!, x, y))).toBe(true);
    }
    expect(painted(colorAt(image!, IFRAME.x - 40, IFRAME.y + 5))).toBe(false);
  }, 10_000);

  it('give no image when it does not answer and its iframe has no box', async () => {
    const { page, screenshot } = twoFramePage(null, false);
    expect(await maskedImage(page, { quality: 90, timeout: 1000 })).toBeNull();
    expect(screenshot).not.toHaveBeenCalled();
  }, 10_000);
});
