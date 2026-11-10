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

/** The window alone, out of a screen capture whose surround is black. */
export async function cutWindow(image) {
  return sharp(image).trim({ background: '#000000', threshold: 8 }).png().toBuffer();
}
