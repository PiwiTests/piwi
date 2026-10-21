// The image writing the editor screenshot scripts share: a capture, rendered at 2×, written at the width the page
// shows it, and the window cut out of a screen capture.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

/** Writes `image` (a PNG buffer or a file path) to `file`, resized to `width` pixels wide. */
export async function writeAtWidth(image, width, file) {
  await sharp(image).resize({ width }).png().toFile(file);
}

/** The window alone, out of a screen capture whose surround is black. */
export async function cutWindow(image) {
  return sharp(image).trim({ background: '#000000', threshold: 8 }).png().toBuffer();
}
