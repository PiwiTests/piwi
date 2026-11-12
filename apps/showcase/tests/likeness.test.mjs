import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';
import { dataUrlBytes, decodeImage, likeness } from '../lib/likeness.mjs';

const require = createRequire(import.meta.url);
const { PNG, jpegjs } = createRequire(require.resolve('playwright-core/package.json'))(
  'playwright-core/lib/utilsBundle',
);

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

  test('reads the bytes of a base64 data URL', () => {
    const bytes = jpeg(pageImage(80, 46));
    assert.deepEqual(dataUrlBytes(`data:image/jpeg;base64,${bytes.toString('base64')}`), bytes);
    assert.throws(() => dataUrlBytes('blob:http://x/1'), /not a base64 data URL/);
  });
});
