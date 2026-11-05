import { createRequire } from 'node:module';
import type { Frame, Locator, Page } from '@playwright/test';
import { SECRET_FIELD_SELECTOR } from '@piwitests/core/mask';
import { fitViewSize } from '@piwitests/core/run-view';
import { locatorOn } from './chain-locator.js';
import type { PageFrame } from './page-view.js';
import { internalCall, resolvePlaywrightPackageJson } from './quiet-capture.js';

/**
 * The live view's images with the page's secret fields painted over, in the worker, before an image leaves it: the
 * fields of `SECRET_FIELD_SELECTOR` (a password field, and a one-time code or a card's number or security code by its
 * `autocomplete`) and the project's own locators (`masks`), in every frame of the page. Each image the view would send
 * comes here first (`page-view.ts`'s `screen`). The boxes of those elements, and the viewport's size, are read through
 * `internalCall` just after it, and compared with a read made just before the page showed it: a frame whose two reads
 * find no element, and the viewport the frame names, goes as it is; one whose two reads find the same boxes goes with
 * them painted over, two a second at most (`MASKED_SPACING_MS`); any other is replaced by a screenshot taken between two
 * reads, which goes, painted over, when those agree, and no image goes when they do not (the page moved). A child
 * frame's boxes are placed from its iframe's content box; an iframe drawn at another size than its own (a transform),
 * or whose frame does not answer within `FRAME_READ_MS` (a lazy frame, a busy one), is painted over whole. Each image
 * keeps the size of the frame it stands for. The paint is `jpeg-js` as Playwright
 * bundles it: an image is decoded, its boxes filled, scaled down to that size and encoded again. No image goes, and the
 * viewers hear why, while an image shows a masked element and there is no `jpeg-js` to paint with, while the page is
 * zoomed in (its visual viewport smaller than its layout viewport, which an image shows and the boxes are read in),
 * while a locator of the project's is one this Playwright cannot build or this reporter cannot read, and once the
 * boxes could not be read
 * `MAX_FAILED_READS` times in a row. An element the page shows only between two reads, less than a frame's interval,
 * is not seen. The agent's image of a stopped page is painted over the same way, and over the boxes Playwright
 * measures itself too (`maskedImage`).
 */

/** A box of the page's viewport, in CSS pixels. */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A read of the masked elements' boxes and of the viewport's size, in CSS pixels, and when it began and ended. */
interface Read {
  began: number;
  ended: number;
  boxes: Box[];
  viewport: { width: number; height: number };
}

/** What a frame of the page shows: the boxes of its masked elements, and its own viewport's size. */
interface FrameRead {
  rects: Array<readonly [number, number, number, number]>;
  width: number;
  height: number;
  /** The frame's visual viewport is not its layout viewport: the page is zoomed in, an image shows it larger. */
  zoomed?: boolean;
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
/** Two reads of a box, or of a size, agree within this many CSS pixels. */
const SAME_WITHIN = 1;
/**
 * How long a frame's masked elements may take to be read: a child frame that has not answered by then (a lazy frame, an
 * awaited response) is painted over whole, from its iframe's box.
 */
const FRAME_READ_MS = 1000;
/** How many reads may fail in a row before the viewers hear that no image goes. */
const MAX_FAILED_READS = 3;
/** The mask's color, in RGB. */
const MASK_RGB = [96, 96, 96] as const;

const TOO_MANY_FRAMES = `This page has more than ${MAX_FRAMES} frames: the live view cannot check them all for secret fields, so no image of it goes.`;
const NO_CODEC =
  'A secret field shows on this page, and this Playwright gives the reporter nothing to mask it with: no image goes while it shows.';
const UNREAD =
  'The live view cannot read where the secret fields of this page are, so no image of it goes until it can.';
const ZOOMED = 'This page is zoomed in: no image of it goes until it is not, its secret fields shown larger than read.';
const UNREADABLE_MASKS =
  'The project masks elements this reporter cannot read: no image goes. Update @piwitests/reporter.';

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

/** Whether two lengths agree within `SAME_WITHIN`. */
const near = (a: number, b: number): boolean => Math.abs(a - b) <= SAME_WITHIN;

/** The boxes of the masked elements `frame` shows, in its own viewport, and that viewport's size. */
function readFrameRects(page: Page, frame: Frame, masks: readonly string[]): Promise<FrameRead> {
  return internalCall(page, () =>
    maskedIn(frame, masks).evaluateAll((elements) => {
      const view = globalThis as unknown as {
        innerWidth: number;
        innerHeight: number;
        visualViewport?: { offsetLeft: number; offsetTop: number; width: number; height: number; scale: number };
        document: { scrollingElement: { clientWidth: number; clientHeight: number } | null };
      };
      const visual = view.visualViewport;
      // The layout viewport without its scroll bars, in standards and quirks mode alike.
      const layout = view.document.scrollingElement;
      const zoomed =
        !!visual &&
        (Math.abs(visual.offsetLeft) > 0.5 ||
          Math.abs(visual.offsetTop) > 0.5 ||
          (layout
            ? visual.width < layout.clientWidth - 1 || visual.height < layout.clientHeight - 1
            : visual.scale > 1.001));
      return {
        rects: elements
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height] as const;
          })
          .filter(([, , width, height]) => width > 0 && height > 0),
        width: view.innerWidth,
        height: view.innerHeight,
        zoomed,
      };
    }),
  );
}

/**
 * Where a child frame's viewport is in the page's, from its iframe: the iframe's box in the page's viewport (which
 * Playwright measures through every frame and transform) less its border and padding; the iframe's whole box instead
 * when it is drawn at another size than its own, or its content is not the child's viewport.
 */
async function childOrigin(
  page: Page,
  frame: Frame,
  inner: { width: number; height: number },
): Promise<{ x: number; y: number } | { whole: Box } | null> {
  return internalCall(page, async () => {
    const element = await frame.frameElement();
    try {
      const outer = await element.boundingBox();
      if (!outer) return null;
      const own = await element.evaluate((iframe) => {
        const el = iframe as unknown as {
          clientLeft: number;
          clientTop: number;
          clientWidth: number;
          clientHeight: number;
          offsetWidth: number;
          offsetHeight: number;
        };
        const style = (
          globalThis as unknown as {
            getComputedStyle(
              e: unknown,
            ): Record<'paddingLeft' | 'paddingTop' | 'paddingRight' | 'paddingBottom', string>;
          }
        ).getComputedStyle(iframe);
        const pad = (side: string): number => parseFloat(side) || 0;
        return {
          left: el.clientLeft + pad(style.paddingLeft),
          top: el.clientTop + pad(style.paddingTop),
          width: el.clientWidth - pad(style.paddingLeft) - pad(style.paddingRight),
          height: el.clientHeight - pad(style.paddingTop) - pad(style.paddingBottom),
          offsetWidth: el.offsetWidth,
          offsetHeight: el.offsetHeight,
        };
      });
      const drawnAsLaidOut = near(outer.width, own.offsetWidth) && near(outer.height, own.offsetHeight);
      const contentIsViewport = near(own.width, inner.width) && near(own.height, inner.height);
      if (!drawnAsLaidOut || !contentIsViewport) return { whole: outer };
      return { x: outer.x + own.left, y: outer.y + own.top };
    } finally {
      await element.dispose();
    }
  });
}

/** `run`'s answer, or undefined once `ms` passed, `run` left to settle on its own. */
async function within<T>(run: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A child frame that did not answer, painted over whole: its iframe's box in the page's viewport, none for an iframe
 * the page does not draw; null when its parent does not say where it is either.
 */
async function wholeFrame(page: Page, frame: Frame): Promise<FrameRead | null> {
  const box = await within(
    internalCall(page, async () => {
      const element = await frame.frameElement();
      try {
        return await element.boundingBox();
      } finally {
        await element.dispose();
      }
    }),
    FRAME_READ_MS,
  ).catch(() => undefined);
  if (box === undefined) return null;
  return { rects: box ? [[box.x, box.y, box.width, box.height]] : [], width: 0, height: 0 };
}

/**
 * The boxes of the masked elements `frame` shows, in the page's viewport; null when they cannot be read. A child frame
 * that does not answer within `FRAME_READ_MS` is painted over whole (`wholeFrame`).
 */
async function readFrame(page: Page, frame: Frame, masks: readonly string[]): Promise<FrameRead | null> {
  try {
    const read = await within(readFrameRects(page, frame, masks), FRAME_READ_MS);
    if (!read) return frame === page.mainFrame() ? null : await wholeFrame(page, frame);
    if (!read.rects.length || frame === page.mainFrame()) return read;
    const origin = await childOrigin(page, frame, read);
    if (!origin) return { ...read, rects: [] };
    if ('whole' in origin) {
      const { x, y, width, height } = origin.whole;
      return { ...read, rects: [[x, y, width, height]] };
    }
    return {
      ...read,
      rects: read.rects.map(([left, top, width, height]) => [origin.x + left, origin.y + top, width, height] as const),
    };
  } catch {
    return frame.isDetached() ? { rects: [], width: 0, height: 0 } : null;
  }
}

/**
 * The boxes of the masked elements the page shows, in every frame, and the page's viewport; why none can be read, or
 * null when a read failed.
 */
async function readBoxes(
  page: Page,
  masks: readonly string[] | null,
): Promise<Omit<Read, 'began' | 'ended'> | string | null> {
  if (!masks) return UNREADABLE_MASKS;
  const frames = page.frames();
  if (frames.length > MAX_FRAMES) return TOO_MANY_FRAMES;
  for (const source of masks) if (!locatorOn(page.mainFrame(), source)) return unbuilt(source);
  const main = page.mainFrame();
  const read = await Promise.all(frames.map((frame) => readFrame(page, frame, masks)));
  if (read.some((frame) => frame === null)) return null;
  const top = read[frames.indexOf(main)];
  if (!top) return null;
  if (top.zoomed) return ZOOMED;
  return {
    boxes: (read as FrameRead[]).flatMap((frame) =>
      frame.rects.map(([x, y, width, height]) => ({ x, y, width, height })),
    ),
    viewport: { width: top.width, height: top.height },
  };
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

/**
 * The boxes of `frame`'s secret fields as Playwright measures them, through the browser's protocol (`boundingBox`),
 * which no script of the page can change, in the page's viewport: its whole iframe's box for a child frame that does
 * not answer within `FRAME_READ_MS` (`wholeFrame`); null when they cannot be read.
 */
async function measureFrame(page: Page, frame: Frame): Promise<Box[] | null> {
  try {
    const measured = await within(
      internalCall(page, async () => {
        const fields = await frame.locator(SECRET_FIELD_SELECTOR).elementHandles();
        try {
          return await Promise.all(fields.map((field) => field.boundingBox()));
        } finally {
          await Promise.all(fields.map((field) => field.dispose().catch(() => undefined)));
        }
      }),
      FRAME_READ_MS,
    );
    if (measured) return measured.filter((box): box is Box => !!box && box.width > 0 && box.height > 0);
    const whole = frame === page.mainFrame() ? null : await wholeFrame(page, frame);
    return whole && whole.rects.map(([x, y, width, height]) => ({ x, y, width, height }));
  } catch {
    return frame.isDetached() ? [] : null;
  }
}

/**
 * The boxes of the page's secret fields, read in the page (`readBoxes`) and measured by Playwright (`measureFrame`),
 * both painted: a script of the page can change the first, and an iframe's own border shifts the second. Null when
 * either cannot be read, or the page is zoomed in.
 */
async function secretBoxes(page: Page): Promise<Omit<Read, 'began' | 'ended'> | null> {
  const [read, measured] = await Promise.all([
    readBoxes(page, []),
    Promise.all(
      page
        .frames()
        .slice(0, MAX_FRAMES)
        .map((frame) => measureFrame(page, frame)),
    ),
  ]);
  if (!read || typeof read === 'string' || measured.some((boxes) => !boxes)) return null;
  return { ...read, boxes: [...read.boxes, ...(measured as Box[][]).flat()] };
}

/**
 * An image of `page`'s viewport with its secret fields (`SECRET_FIELD_SELECTOR`, in every frame) painted over in the
 * image itself, never in the page, so the test's own highlights stay as they are: taken between two reads of their
 * boxes (`secretBoxes`), through `internalCall`, which must agree. Null when they do not, when the page cannot be read
 * or is zoomed in, and when a field shows and there is no `jpeg-js` to paint with. `style` applies while the image is
 * taken.
 */
export async function maskedImage(
  page: Page,
  options: { quality: number; style?: string; timeout: number },
): Promise<Buffer | null> {
  const before = await secretBoxes(page);
  if (!before) return null;
  const shot = await internalCall(page, () =>
    page.screenshot({
      type: 'jpeg',
      quality: options.quality,
      timeout: options.timeout,
      ...(options.style ? { style: options.style } : {}),
    }),
  ).catch(() => null);
  if (!shot) return null;
  const after = await secretBoxes(page);
  if (!after || !sameBoxes(before.boxes, after.boxes)) return null;
  const { width, height } = after.viewport;
  if (!near(width, before.viewport.width) || !near(height, before.viewport.height)) return null;
  if (!after.boxes.length) return shot;
  const jpeg = jpegCodec();
  const size = jpegSize(shot);
  if (!jpeg || !size) return null;
  try {
    return paintBoxes(jpeg, { data: shot, width, height, at: Date.now() }, after.boxes, size, options.quality);
  } catch {
    return null;
  }
}

export interface SecretFieldMaskOptions {
  /** The project's own locators to mask, beside the secret fields; null when the instance named some this reporter cannot read. */
  masks(): readonly string[] | null;
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
  /** How many reads failed in a row. */
  let failed = 0;

  const read = async (): Promise<Read | string | null> => {
    const began = Date.now();
    const found = await readBoxes(page, options.masks());
    if (typeof found === 'string') return found;
    if (!found) return ++failed >= MAX_FAILED_READS ? UNREAD : null;
    failed = 0;
    const done: Read = { began, ended: Date.now(), ...found };
    reads.push(done);
    if (reads.length > READS_KEPT) reads.shift();
    return done;
  };

  /** Whether `frame` shows the viewport `read` measured. */
  const showsViewportOf = (frame: PageFrame, read: Read): boolean =>
    near(frame.width, read.viewport.width) && near(frame.height, read.viewport.height);

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
      if (
        before &&
        sameBoxes(before.boxes, after.boxes) &&
        showsViewportOf(frame, before) &&
        showsViewportOf(frame, after)
      ) {
        return shown(frame, after.boxes, size);
      }
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
      const { width, height } = again.viewport;
      if (!near(width, after.viewport.width) || !near(height, after.viewport.height)) return null;
      // The screenshot shows the viewport the reads measured, whatever size the frame it stands for named.
      return shown(
        { data: shot, width, height, at },
        again.boxes,
        fitViewSize({ width, height }, size.width, size.height),
      );
    },
  };
}
