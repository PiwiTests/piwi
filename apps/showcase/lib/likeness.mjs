// How alike two images of one page are: an image a tool shows of the test's page, and a screenshot of the page itself.
// Each is decoded (PNG or JPEG, with the codecs Playwright bundles), reduced to the mean luminance of each cell of a
// grid laid over it whatever its size, and the two grids are correlated: the same page at another size or quality
// correlates near 1, the page tiled, shifted or blank far below.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG, jpegjs } = createRequire(require.resolve('playwright-core/package.json'))(
  'playwright-core/lib/utilsBundle',
);

/** The grid two images are compared on, in cells across and down. */
export const GRID = { cols: 40, rows: 25 };
/** The least correlation of two images of the same page, and the most their shapes' ratios may differ by. */
export const MIN_CORRELATION = 0.95;
export const MAX_SHAPE_DIFFERENCE = 0.02;

/** A PNG or JPEG image's pixels, as `{ width, height, data }` with four bytes (RGBA) a pixel. */
export function decodeImage(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return PNG.sync.read(bytes);
  return jpegjs.decode(bytes, { useTArray: true, formatAsRGBA: true });
}

/** The bytes of a `data:` URL's base64 image. */
export function dataUrlBytes(url) {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma < 0 || !url.slice(0, comma).endsWith(';base64')) {
    throw new Error(`not a base64 data URL: ${url.slice(0, 40)}`);
  }
  return Buffer.from(url.slice(comma + 1), 'base64');
}

/** The mean luminance (0 to 255) of each cell of `cols` by `rows` laid over `image`, row by row. */
export function lumaGrid({ width, height, data }, { cols, rows } = GRID) {
  const sums = new Float64Array(cols * rows);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const row = Math.min(rows - 1, Math.floor((y * rows) / height));
    for (let x = 0; x < width; x++) {
      const cell = row * cols + Math.min(cols - 1, Math.floor((x * cols) / width));
      const i = (y * width + x) * 4;
      sums[cell] += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      counts[cell]++;
    }
  }
  return Array.from(sums, (sum, cell) => (counts[cell] ? sum / counts[cell] : 0));
}

/** Pearson's correlation of two series of one length; 0 when either does not vary (a blank image). */
export function correlation(a, b) {
  const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
  const ma = mean(a);
  const mb = mean(b);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += (a[i] - ma) * (b[i] - mb);
    aa += (a[i] - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * How alike `shown` (an image a tool shows of the page) and `page` (a screenshot of the page) are, both decoded: the
 * width-to-height ratio of each, how much they differ by (a fraction of the page's), the correlation of their grids,
 * and whether they read as the same page.
 */
export function likeness(shown, page) {
  const shownRatio = shown.width / shown.height;
  const pageRatio = page.width / page.height;
  const shapeDifference = Math.abs(shownRatio - pageRatio) / pageRatio;
  const r = correlation(lumaGrid(shown), lumaGrid(page));
  return {
    shown: `${shown.width}x${shown.height}`,
    page: `${page.width}x${page.height}`,
    shapeDifference: Number(shapeDifference.toFixed(4)),
    correlation: Number(r.toFixed(4)),
    same: shapeDifference <= MAX_SHAPE_DIFFERENCE && r >= MIN_CORRELATION,
  };
}
