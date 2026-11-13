import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';
import { dataUrlBytes, decodeImage, likeness } from '../lib/likeness.mjs';

const require = createRequire(import.meta.url);
const { PNG, jpegjs } = createRequire(require.resolve('playwright'))('playwright-core/lib/utilsBundle');

/** A page-like image at `width` by `height`: a dark header, a column of fields and a button on white. */
function pageImage(width, height) {
  const data = new Uint8Array(width * height * 4).fill(255);
  const fill = (x0, y0, x1, y1, value) => {
    for (let y = Math.floor(y0 * height); y < Math.floor(y1 * height); y++) {
      for (let x = Math.floor(x0 * width); x < Math.floor(x1 * width); x++) {
        data.set([value, value, value, 255], (y * width + x) * 4);
      }
    }
  };
  fill(0, 0, 1, 0.12, 40);
  for (let i = 0; i < 4; i++) fill(0.08, 0.2 + i * 0.15, 0.55, 0.28 + i * 0.15, 200);
  fill(0.08, 0.82, 0.3, 0.92, 20);
  fill(0.7, 0.3, 0.92, 0.7, 120);
  return { width, height, data };
}

/** `image` drawn at half its size four times, as a stop image tiled 2 by 2 shows it. */
function tiled({ width, height, data }) {
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (((y * 2) % height) * width + ((x * 2) % width)) * 4;
      out.set(data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data: out };
}

const jpeg = (image, quality = 60) => Buffer.from(jpegjs.encode(image, quality).data);
const png = (image) => {
  const made = new PNG({ width: image.width, height: image.height });
  made.data = Buffer.from(image.data);
  return PNG.sync.write(made);
};

describe('the likeness of an image of a page and a screenshot of it', () => {
  const page = decodeImage(png(pageImage(800, 460)));

  test('reads the same page at another size and in JPEG as the same', () => {
    const shown = decodeImage(jpeg(pageImage(1600, 920)));
    const result = likeness(shown, page);
    assert.equal(result.same, true, JSON.stringify(result));
    assert.ok(result.correlation > 0.99, JSON.stringify(result));
  });

  test('reads the page tiled 2 by 2 as another', () => {
    const result = likeness(decodeImage(jpeg(tiled(pageImage(800, 460)))), page);
    assert.equal(result.same, false, JSON.stringify(result));
  });

  test('reads a blank image, and one of another shape, as another', () => {
    const blank = { width: 800, height: 460, data: new Uint8Array(800 * 460 * 4).fill(255) };
    assert.equal(likeness(decodeImage(jpeg(blank)), page).same, false);
    const squeezed = likeness(decodeImage(jpeg(pageImage(800, 600))), page);
    assert.equal(squeezed.same, false, JSON.stringify(squeezed));
    assert.ok(squeezed.correlation > 0.95, 'alike but for its shape');
  });

  test('reads a page with only its fields emptied as another', () => {
    // The page's four fields each hold a line of text, which the image shown does not.
    const filled = pageImage(800, 460);
    for (let i = 0; i < 4; i++) {
      const y0 = Math.floor((0.22 + i * 0.15) * 460);
      for (let y = y0; y < y0 + 14; y++) {
        for (let x = 80; x < 240; x += 3) filled.data.set([60, 60, 60, 255], (y * 800 + x) * 4);
      }
    }
    const result = likeness(decodeImage(jpeg(pageImage(800, 460))), decodeImage(png(filled)));
    assert.equal(result.same, false, JSON.stringify(result));
  });

  test('reads the bytes of a base64 data URL', () => {
    const bytes = jpeg(pageImage(80, 46));
    assert.deepEqual(dataUrlBytes(`data:image/jpeg;base64,${bytes.toString('base64')}`), bytes);
    assert.throws(() => dataUrlBytes('blob:http://x/1'), /not a base64 data URL/);
  });
});

/** An image of the showcase's stop, or of the sample app, kept beside the tests. */
const fixture = (name) => decodeImage(fs.readFileSync(new URL(`fixtures/${name}`, import.meta.url)));

/** `image` with each pixel `paint(x, y, pixel)` returns in place of its own, and the others as they are. */
function painted(image, paint) {
  const data = new Uint8Array(image.data);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const pixel = paint(x, y, image.data.subarray(i, i + 4));
      if (pixel) data.set(pixel, i);
    }
  }
  return { width: image.width, height: image.height, data };
}

describe("the likeness of the showcase's stop image and its page", () => {
  // The sample app's checkout, paused at the showcase's stop: its navigation ends 78 pixels down, and its three
  // fields hold a name, an address and a city.
  const page = fixture('stop-page.png');
  const background = [244, 247, 250, 255];

  test('reads the Runs window image of the stop as its page', () => {
    const result = likeness(fixture('stop-image.jpg'), page);
    assert.equal(result.same, true, JSON.stringify(result));
  });

  test('reads the page through a coarse JPEG as the page', () => {
    const result = likeness(decodeImage(jpeg(page, 20)), page);
    assert.equal(result.same, true, JSON.stringify(result));
  });

  test('reads the page blank below its header as another', () => {
    const result = likeness(
      painted(page, (x, y) => y >= 78 && background),
      page,
    );
    assert.equal(result.same, false, JSON.stringify(result));
  });

  test('reads the page cut off halfway down as another', () => {
    const result = likeness(
      painted(page, (x, y) => y >= page.height / 2 && background),
      page,
    );
    assert.equal(result.same, false, JSON.stringify(result));
  });

  test('reads the form with its fields emptied as another', () => {
    const field = (y) => (y > 253 && y < 293) || (y > 338 && y < 378) || y > 423;
    const result = likeness(
      painted(page, (x, y) => x > 45 && x < 500 && field(y) && [255, 255, 255, 255]),
      page,
    );
    assert.equal(result.same, false, JSON.stringify(result));
  });

  test('reads another page of the sample app as another', () => {
    const result = likeness(fixture('cart.jpg'), fixture('checkout.jpg'));
    assert.equal(result.same, false, JSON.stringify(result));
  });
});
