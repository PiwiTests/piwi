// The image writing the editor screenshot scripts share: a capture, rendered at 2×, written at the width the page
// shows it, and the window cut out of a screen capture.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

/** Writes `image` (a PNG buffer or a file path) to `file`, resized to `width` pixels wide. */
export async function writeAtWidth(image, width, file) {
  await sharp(image).resize({ width }).png().toFile(file);
}

/** The width and height of `image`, in its pixels. */
export async function imageSize(image) {
  const { width, height } = await sharp(image).metadata();
  return { width, height };
}

/** How many pixels of `image` within `region` (`{ left, top, width, height }`) `match(r, g, b)` takes. */
export async function countPixels(image, region, match) {
  const { data, info } = await sharp(image).extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let i = 0; i < data.length; i += info.channels) if (match(data[i], data[i + 1], data[i + 2])) count += 1;
  return count;
}

/**
 * Whether `region` of `image` holds a `size` × `size` square whose every pixel `match(r, g, b)` takes: a filled shape,
 * such as an icon's disc, apart from a text's strokes of the same color, which are thinner.
 */
export async function hasSolidSquare(image, region, size, match) {
  const { data, info } = await sharp(image).extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  // Summed-area table of the matching pixels, one row and column of zeros before the image.
  const sums = new Int32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const hit = match(data[i], data[i + 1], data[i + 2]) ? 1 : 0;
      sums[(y + 1) * (width + 1) + x + 1] = hit + sums[y * (width + 1) + x + 1] + sums[(y + 1) * (width + 1) + x] - sums[y * (width + 1) + x];
    }
  }
  const at = (x, y) => sums[y * (width + 1) + x];
  for (let y = size; y <= height; y += 1) {
    for (let x = size; x <= width; x += 1) {
      if (at(x, y) - at(x - size, y) - at(x, y - size) + at(x - size, y - size) === size * size) return true;
    }
  }
  return false;
}

/** The window alone, out of a screen capture whose surround is black. */
export async function cutWindow(image) {
  return sharp(image).trim({ background: '#000000', threshold: 8 }).png().toBuffer();
}
