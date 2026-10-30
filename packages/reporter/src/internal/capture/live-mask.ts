import { createRequire } from 'node:module';
import type { Frame, Locator, Page } from '@playwright/test';
import { SECRET_FIELD_SELECTOR } from '@piwitests/core/mask';
import { locatorOn } from './chain-locator.js';
import type { PageFrame } from './page-view.js';
import { internalCall, resolvePlaywrightPackageJson } from './quiet-capture.js';

/**
 * The live view's images with the page's secret fields painted over, in the worker, before an image leaves it: the
 * fields of `SECRET_FIELD_SELECTOR` (a password field, and a one-time code or a card's number or security code by its
 * `autocomplete`) and the project's own locators (`masks`), in every frame of the page. Each image the view would send
 * comes here first (`page-view.ts`'s `screen`). The boxes of those elements are read through `internalCall` just after
 * it, and compared with a read made just before the page showed it: a frame whose two reads find no element goes as it
 * is; one whose two reads find the same boxes goes with them painted over, two a second at most (`MASKED_SPACING_MS`); any other
 * is replaced by a screenshot taken between two reads, which goes painted over when those agree, and no image goes when
 * they do not (the page moved). Each image keeps the size of the frame it stands for. The paint is `jpeg-js` as
 * Playwright bundles it: an image is decoded, its boxes filled, scaled down to that size and encoded again; with no
 * `jpeg-js` to paint with, an image that shows a masked element never goes, and the viewers hear why, as they do while
 * a project's locator is one this Playwright cannot build. An element the page shows only between two reads, less than a frame's
 * interval, is not seen.
 */

/** A box of the page's viewport, in CSS pixels. */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A read of the masked elements' boxes, and when it began and ended. */
interface Read {
  began: number;
  ended: number;
  boxes: Box[];
}

/** The least time between two images that show a masked element. */
const MASKED_SPACING_MS = 500;
/** How old a read made before an image may be for that image to go on it, in milliseconds. */
const FRESH_MS = 1000;
/** How many reads are kept to find the one made just before an image. */
const READS_KEPT = 4;
/** The most frames of a page whose elements are read: a page with more shows no image. */
const MAX_FRAMES = 32;
/** How far a mask reaches past its element's box, in CSS pixels. */
const PAD = 2;
/** Two reads of a box agree within this many CSS pixels. */
const SAME_WITHIN = 1;
/** The mask's color, in RGB. */
const MASK_RGB = [96, 96, 96] as const;

const TOO_MANY_FRAMES = `This page has more than ${MAX_FRAMES} frames: the live view cannot check them all for secret fields, so no image of it goes.`;
const NO_CODEC =
  'A secret field shows on this page, and this Playwright gives the reporter nothing to mask it with: no image goes while it shows.';

type Image = { width: number; height: number; data: Uint8Array };
type JpegJs = {
  decode(data: Buffer, options: { useTArray: true; formatAsRGBA: true }): Image;
  encode(image: Image, quality: number): { data: Buffer };
};

/** `jpeg-js` as Playwright bundles it, found on first use; null when this Playwright offers none. */
let codec: JpegJs | null | undefined;

/** `jpeg-js` as Playwright bundles it; null when this Playwright offers none. */
export function jpegCodec(): JpegJs | null {
  if (codec !== undefined) return codec;
  codec = null;
  try {
    const playwright = resolvePlaywrightPackageJson();
    const bundle = playwright
      ? (createRequire(playwright)('playwright-core/lib/utilsBundle') as { jpegjs?: Partial<JpegJs> })
      : null;
    const found = bundle?.jpegjs;
    if (typeof found?.decode === 'function' && typeof found.encode === 'function') codec = found as JpegJs;
  } catch {
    // A Playwright layout without it: an image that shows a masked element does not go.
  }
  return codec;
}

/** The masked elements of `frame`: its secret fields and the project's locators, as one locator. */
function maskedIn(frame: Frame, masks: readonly string[]): Locator {
  let locator = frame.locator(SECRET_FIELD_SELECTOR);
  for (const source of masks) {
    const own = locatorOn(frame, source);
    if (!own) throw new Error(`The locator ${source} cannot be built.`);
    locator = locator.or(own);
  }
  return locator;
}

/** Why no image goes: a locator of the project's this Playwright cannot build. */
const unbuilt = (source: string): string =>
  `The project masks ${source}, which this Playwright cannot find elements by: no image of the page goes.`;

/** The boxes of the masked elements `frame` shows, in the page's viewport; null when they cannot be read. */
async function readFrame(page: Page, frame: Frame, masks: readonly string[]): Promise<Box[] | null> {
  try {
    const rects = await internalCall(page, () =>
      maskedIn(frame, masks).evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height] as const;
        }),
      ),
    );
    const shown = rects.filter(([, , width, height]) => width > 0 && height > 0);
    if (!shown.length) return [];
    let x = 0;
    let y = 0;
    if (frame !== page.mainFrame()) {
      // A child frame's boxes are in its own viewport: its element's box in the page's places them.
      const outer = await internalCall(page, async () => {
        const element = await frame.frameElement();
        try {
          return await element.boundingBox();
        } finally {
          await element.dispose();
        }
      });
      if (!outer) return [];
      x = outer.x;
      y = outer.y;
    }
    return shown.map(([left, top, width, height]) => ({ x: x + left, y: y + top, width, height }));
  } catch {
    return frame.isDetached() ? [] : null;
  }
}

/** The boxes of the masked elements the page shows, in every frame; why none can be read, or null when a read failed. */
async function readBoxes(page: Page, masks: readonly string[]): Promise<Box[] | string | null> {
  const frames = page.frames();
  if (frames.length > MAX_FRAMES) return TOO_MANY_FRAMES;
  for (const source of masks) if (!locatorOn(page.mainFrame(), source)) return unbuilt(source);
  const read = await Promise.all(frames.map((frame) => readFrame(page, frame, masks)));
  if (read.some((boxes) => boxes === null)) return null;
  return (read as Box[][]).flat();
}

/** Whether two reads found the same boxes, in the same order, within `SAME_WITHIN`. */
function sameBoxes(a: Box[], b: Box[]): boolean {
  return (
    a.length === b.length &&
    a.every((box, i) => {
      const other = b[i]!;
      return (
        Math.abs(box.x - other.x) <= SAME_WITHIN &&
        Math.abs(box.y - other.y) <= SAME_WITHIN &&
        Math.abs(box.width - other.width) <= SAME_WITHIN &&
        Math.abs(box.height - other.height) <= SAME_WITHIN
      );
    })
  );
}

/** A JPEG's size in pixels, from its frame header; null when it has none. */
function jpegSize(data: Buffer): { width: number; height: number } | null {
  for (let i = 2; i + 9 < data.length;) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3) return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
    i += 2 + data.readUInt16BE(i + 2);
  }
  return null;
}

/** `image` scaled down to `width` by `height`, each pixel the mean of those it covers. */
function shrink(image: Image, width: number, height: number): Image {
  const data = new Uint8Array(width * height * 4);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * image.width + xx) * 4;
          r += image.data[i]!;
          g += image.data[i + 1]!;
          b += image.data[i + 2]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      data[o] = r / n;
      data[o + 1] = g / n;
      data[o + 2] = b / n;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

/** `frame` with `boxes` painted over, at most `size` and at `quality`. */
function paintBoxes(
  jpeg: JpegJs,
  frame: PageFrame,
  boxes: Box[],
  size: { width: number; height: number },
  quality: number,
): Buffer {
  const image = jpeg.decode(frame.data, { useTArray: true, formatAsRGBA: true });
  const sx = image.width / frame.width;
  const sy = image.height / frame.height;
  for (const box of boxes) {
    const x0 = Math.max(0, Math.floor((box.x - PAD) * sx));
    const y0 = Math.max(0, Math.floor((box.y - PAD) * sy));
    const x1 = Math.min(image.width, Math.ceil((box.x + box.width + PAD) * sx));
    const y1 = Math.min(image.height, Math.ceil((box.y + box.height + PAD) * sy));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * image.width + x) * 4;
        image.data[i] = MASK_RGB[0];
        image.data[i + 1] = MASK_RGB[1];
        image.data[i + 2] = MASK_RGB[2];
        image.data[i + 3] = 255;
      }
    }
  }
  const fits = image.width <= size.width && image.height <= size.height;
  return jpeg.encode(fits ? image : shrink(image, size.width, size.height), quality).data;
}

export interface SecretFieldMaskOptions {
  /** The project's own locators to mask, beside the secret fields. */
  masks(): readonly string[];
  /** The JPEG quality of an image painted over, or taken in a frame's place. */
  quality: number;
  /** The longest image that goes, in bytes of JPEG. */
  maxBytes: number;
}

export interface SecretFieldMask {
  /** Whether an image painted over went less than `MASKED_SPACING_MS` ago: the next one waits. */
  readonly resting: boolean;
  /** The image that may go for `frame`: itself, painted over, a screenshot in its place, none, or why none goes. */
  screen(frame: PageFrame): Promise<PageFrame | string | null>;
}

/** Mask the secret fields and the project's locators in each image of `page` the view would send. */
export function maskSecretFields(page: Page, options: SecretFieldMaskOptions): SecretFieldMask {
  const reads: Read[] = [];
  /** When the latest image painted over was given to send. */
  let maskedAt = -Infinity;

  const read = async (): Promise<Read | string | null> => {
    const began = Date.now();
    const boxes = await readBoxes(page, options.masks());
    if (typeof boxes === 'string' || !boxes) return boxes;
    const done: Read = { began, ended: Date.now(), boxes };
    reads.push(done);
    if (reads.length > READS_KEPT) reads.shift();
    return done;
  };

  /**
   * The image to send for a frame its reads agree on, at `size` at most (the size of the frame it stands for): as it
   * is, or painted over.
   */
  const shown = (
    frame: PageFrame,
    boxes: Box[],
    size: { width: number; height: number },
  ): PageFrame | string | null => {
    const own = jpegSize(frame.data);
    const fits = own === null || (own.width <= size.width && own.height <= size.height);
    const jpeg = jpegCodec();
    if (!boxes.length && (fits || !jpeg)) return frame.data.length <= options.maxBytes ? frame : null;
    if (!jpeg) return NO_CODEC;
    let data: Buffer;
    try {
      data = paintBoxes(jpeg, frame, boxes, size, options.quality);
    } catch {
      return null;
    }
    if (!boxes.length) return data.length <= options.maxBytes ? { ...frame, data } : null;
    if (data.length > options.maxBytes) return null;
    maskedAt = Date.now();
    return { ...frame, data };
  };

  return {
    get resting() {
      return Date.now() - maskedAt < MASKED_SPACING_MS;
    },
    async screen(frame) {
      const before = [...reads].reverse().find((r) => r.ended <= frame.at && r.ended >= frame.at - FRESH_MS) ?? null;
      const after = await read();
      if (typeof after === 'string' || !after) return after;
      const size = jpegSize(frame.data) ?? frame;
      if (before && sameBoxes(before.boxes, after.boxes)) return shown(frame, after.boxes, size);
      // No read brackets the frame: a screenshot taken between two reads goes in its place.
      if (page.isClosed()) return null;
      const at = Date.now();
      const shot = await internalCall(page, () =>
        page.screenshot({ type: 'jpeg', quality: options.quality, scale: 'css', caret: 'initial', timeout: 5000 }),
      ).catch(() => null);
      if (!shot) return null;
      const again = await read();
      if (typeof again === 'string' || !again) return again;
      if (!sameBoxes(after.boxes, again.boxes)) return null;
      return shown({ data: shot, width: frame.width, height: frame.height, at }, again.boxes, size);
    },
  };
}
