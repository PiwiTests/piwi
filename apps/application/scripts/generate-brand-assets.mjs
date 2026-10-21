#!/usr/bin/env node
// Writes every logo, favicon and app icon in the repository from the drawing in this file: the dashboard's and the
// docs site's SVG logos, favicons and touch icon, the browser extension's icons, the VS Code extension's icons, the
// JetBrains plugin's icons, and `shared/brand-mark.json`, the small mark the exported documents and emails carry. PNG and ICO files are rendered with Playwright's Chromium. The desktop app's bundle icons
// are generated from `public/logo.svg` by `tauri icon` (see apps/desktop/AGENTS.md).
//
//   npm run app:generate:brand

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Brand colors: navy ink, the extension's violet, the mint of the check; lighter shades on dark grounds.
const NAVY = '#0d1d47';
const VIOLET = '#7c3aed';
const VIOLET_ON_DARK = '#a78bfa';
const MINT = '#23c9a0';
const MINT_ON_DARK = '#2fd9ae';
const INK_ON_DARK = '#f1efff';

// The drawing, in the coordinates of the 762 × 300 lockup: the bird's outline, the lens and the eye (holes), the check,
// the perch, the wordmark "piwi" and the hairline "tests".
const OUTLINE =
  'M27.11 225.74 L27.11 113.13 C27.387 70.881 52.369 32.669 91.958 13.939 C134.443 -6.161 190.2 -2.218 234.141 42.928 L256.46 65.86 C257.993 67.44 257.83 68.817 255.97 69.99 L231.52 85.4 C246.493 125.196 232.85 170.793 198.262 196.55 C163.675 222.307 116.776 221.794 83.94 195.3 L31.96 228.4 C28.727 230.46 27.11 229.573 27.11 225.74 Z';
const LENS =
  'M162.57 165.22 C190.8 149.461 198.999 116.772 184.523 90.842 C170.048 64.912 138.38 55.561 110.15 71.32 C81.92 87.079 75.566 119.03 90.042 144.96 C104.517 170.89 134.34 180.979 162.57 165.22 Z';
const EYE =
  'M193.59 52.7 C193.59 59.344 198.976 64.73 205.62 64.73 C212.264 64.73 217.65 59.344 217.65 52.7 C217.65 46.056 212.264 40.67 205.62 40.67 C198.976 40.67 193.59 46.056 193.59 52.7 Z';
const EYE_SMALL = 'M189.62 52.7 A16 16 0 1 0 221.62 52.7 A16 16 0 1 0 189.62 52.7 Z';
const CHECK = 'M101.78 123.89 L126.25 148.22 L170.85 98.47 L165.31 93.49 L125.94 137.4 L107.04 118.6 Z';
const PIWI =
  'M315.41 79.74 C315.41 78.812 316.162 78.06 317.09 78.06 L349.81 78.06 C350.738 78.06 351.49 78.812 351.49 79.74 L351.49 90.92 C376.894 66.547 415.721 68.092 439.371 94.417 C463.021 120.743 463.021 162.417 439.371 188.743 C415.721 215.068 376.894 216.613 351.49 192.24 L351.49 251.47 C351.49 252.398 350.738 253.15 349.81 253.15 L317.09 253.15 C316.162 253.15 315.41 252.398 315.41 251.47 Z M350.47 141.5 C350.47 160.642 365.988 176.16 385.13 176.16 C404.272 176.16 419.79 160.642 419.79 141.5 C419.79 122.358 404.272 106.84 385.13 106.84 C365.988 106.84 350.47 122.358 350.47 141.5 Z M469.09 80.25 C469.09 79.145 469.985 78.25 471.09 78.25 L503.49 78.25 C504.595 78.25 505.49 79.145 505.49 80.25 L505.49 204.33 C505.49 205.435 504.595 206.33 503.49 206.33 L471.09 206.33 C469.985 206.33 469.09 205.435 469.09 204.33 Z M720.29 80.25 C720.29 79.145 721.185 78.25 722.29 78.25 L754.69 78.25 C755.795 78.25 756.69 79.145 756.69 80.25 L756.69 204.33 C756.69 205.435 755.795 206.33 754.69 206.33 L722.29 206.33 C721.185 206.33 720.29 205.435 720.29 204.33 Z M465.97 42.1 C465.97 54.112 475.708 63.85 487.72 63.85 C499.732 63.85 509.47 54.112 509.47 42.1 C509.47 30.088 499.732 20.35 487.72 20.35 C475.708 20.35 465.97 30.088 465.97 42.1 Z M716.83 42.1 C716.83 54.112 726.568 63.85 738.58 63.85 C750.592 63.85 760.33 54.112 760.33 42.1 C760.33 30.088 750.592 20.35 738.58 20.35 C726.568 20.35 716.83 30.088 716.83 42.1 Z M514 78.22 L551.67 78.22 L574.09 160.25 L598.04 78.22 L628.19 78.22 L652.14 160.25 L674.57 78.22 L712.23 78.22 L670.55 206.31 L636.58 206.31 L613.12 129.4 L589.66 206.31 L555.69 206.31 Z';
const TESTS = [
  [
    8.9,
    'M481.84 222.972 L481.84 274.142 C481.84 278.284 485.198 281.642 489.34 281.642 L500.49 281.642 M673.24 222.972 L673.24 274.142 C673.24 278.284 676.598 281.642 680.74 281.642 L691.89 281.642',
  ],
  [8, 'M469.09 240.082 L500.49 240.082 M660.49 240.082 L691.89 240.082'],
  [
    8.3,
    'M569.52 261.042 C569.397 249.944 561.566 240.679 551.25 239.425 C540.933 238.171 531.356 245.319 528.904 256.104 C526.452 266.888 531.892 277.938 541.596 281.885 C551.3 285.831 562.235 281.441 567.11 271.642',
  ],
  [7.1, 'M528.32 261.042 L573.66 261.042'],
  [
    8.4,
    'M633.79 246.792 C632.19 241.892 626.79 239.492 618.39 239.492 C609.79 239.492 603.59 243.492 603.59 249.492 C603.59 256.092 609.69 257.892 618.19 259.892 C627.69 262.092 633.79 264.292 633.79 271.492 C633.79 278.492 626.99 283.092 618.19 283.092 C609.69 283.092 603.39 279.792 602.39 272.892 M753.59 246.792 C751.99 241.892 746.59 239.492 738.19 239.492 C729.59 239.492 723.39 243.492 723.39 249.492 C723.39 256.092 729.49 257.892 737.99 259.892 C747.49 262.092 753.59 264.292 753.59 271.492 C753.59 278.492 746.79 283.092 737.99 283.092 C729.49 283.092 723.19 279.792 722.19 272.892',
  ],
];

// The view boxes that frame each part of the drawing.
const VIEW = {
  lockup: { x: 0, y: 0, w: 762, h: 300 },
  nav: { x: -6, y: -4, w: 772, h: 316 },
  mark: { x: 0, y: -4, w: 262, h: 304 },
  markSmall: { x: -6, y: -4, w: 266, h: 316 },
};
// Centers of the two marks, for placing them on an icon tile.
const MARK_CENTER = { x: 130, y: 148 };
const MARK_SMALL_CENTER = { x: 127, y: 154 };

/**
 * The full mark, from 48 px up: a two-color perch, the passed node in mint and the next one in `node`. `lens` fills the
 * lens hole when the ground behind it would hide the check.
 */
function mark({ ink, check, node, lens }) {
  return [
    lens ? `<circle cx="137.3" cy="118" r="57" fill="${lens}"/>` : '',
    `<path d="${OUTLINE} ${LENS} ${EYE}" fill="${ink}" fill-rule="evenodd"/>`,
    `<path d="${CHECK}" fill="${check}" stroke="${check}" stroke-width="13" stroke-linejoin="round"/>`,
    `<path d="M28.2 270.73 L83.43 235.904 L154.16 270.68" fill="none" stroke="${ink}" stroke-width="18" stroke-linejoin="round"/>`,
    `<circle cx="28.2" cy="270.73" r="26.11" fill="${check}"/>`,
    `<circle cx="154.16" cy="270.68" r="26.28" fill="${node}"/>`,
  ].join('');
}

/**
 * The small mark, 48 px and below: a one-color perch drawn heavier and set lower so it stays clear of the tail, a
 * thicker check and a larger eye.
 */
function markSmall({ ink, check, perch, lens }) {
  return [
    lens ? `<circle cx="137.3" cy="118" r="57" fill="${lens}"/>` : '',
    `<path d="${OUTLINE} ${LENS} ${EYE_SMALL}" fill="${ink}" fill-rule="evenodd"/>`,
    `<path d="${CHECK}" fill="${check}" stroke="${check}" stroke-width="22" stroke-linejoin="round"/>`,
    `<path d="M28.2 276.73 L83.43 241.904 L154.16 276.68" fill="none" stroke="${perch}" stroke-width="28" stroke-linejoin="round"/>`,
    `<circle cx="28.2" cy="276.73" r="32" fill="${perch}"/>`,
    `<circle cx="154.16" cy="276.68" r="32" fill="${perch}"/>`,
  ].join('');
}

/** "piwi", and the hairline "tests" under it unless `tests` is omitted. */
function wordmark({ word, tests }) {
  const piwi = `<path d="${PIWI}" fill="${word}" fill-rule="evenodd"/>`;
  if (!tests) return piwi;
  return `${piwi}<g fill="none" stroke="${tests}">${TESTS.map(([width, d]) => `<path d="${d}" stroke-width="${width}"/>`).join('')}</g>`;
}

function svg({ x, y, w, h }, body, { width = w, height = h, title = 'Piwi' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${w} ${h}"><title>${title}</title>${body}</svg>\n`;
}

/**
 * An app icon: the mark on a violet tile with rounded corners (`radius` as a share of the side, 0 for a full-bleed
 * square that the platform masks itself), the full mark or the small one, filling `scale` of the tile's height, with
 * `inset` units of transparent margin on a 512-unit side. `size` is the SVG's display size.
 */
function appIcon({ small, radius = 0.23, scale = 0.72, inset = 0, size: display = 512 }) {
  const size = 512;
  const tile = size - inset * 2;
  const view = small ? VIEW.markSmall : VIEW.mark;
  const center = small ? MARK_SMALL_CENTER : MARK_CENTER;
  const k = (tile * scale) / view.h;
  const body = small
    ? markSmall({ ink: '#ffffff', check: MINT_ON_DARK, perch: '#ffffff', lens: NAVY })
    : mark({ ink: '#ffffff', check: MINT_ON_DARK, node: NAVY, lens: NAVY });
  return svg(
    { x: 0, y: 0, w: size, h: size },
    `<rect x="${inset}" y="${inset}" width="${tile}" height="${tile}" rx="${Math.round(tile * radius)}" fill="${VIOLET}"/>` +
      `<g transform="translate(${size / 2} ${size / 2}) scale(${k.toFixed(4)}) translate(${-center.x} ${-center.y})">${body}</g>`,
    { width: display, height: display },
  );
}

/** One-color small mark, for IDE tool windows, gutters and activity bars. */
function monoMark(color, size) {
  const c = color;
  return svg(VIEW.markSmall, markSmall({ ink: c, check: c, perch: c }), { width: size, height: size });
}

const LIGHT = { ink: NAVY, word: NAVY, check: MINT, node: VIOLET, tests: VIOLET };
const DARK = { ink: INK_ON_DARK, word: INK_ON_DARK, check: MINT_ON_DARK, node: VIOLET_ON_DARK, tests: VIOLET_ON_DARK };

const lockup = (colors) => svg(VIEW.lockup, mark(colors) + wordmark(colors), { title: 'Piwi tests' });
/** The sidebar lockup: the mark and "piwi" without the hairline "tests", which is unreadable at nav heights. */
const navLockup = (colors) => svg(VIEW.nav, mark(colors) + wordmark({ word: colors.word }));
/** The square logo: the small mark on its violet tile, also the favicon, the notification icon and the desktop icon. */
const squareLogo = appIcon({ small: true, size: 64 });

/** The social card: the reversed wordmark, the positioning line and the full mark on the night ground. */
function socialCard() {
  const words = svg({ x: 305, y: 10, w: 465, h: 285 }, wordmark(DARK), { width: 233, height: 143 });
  const big = svg(VIEW.mark, mark({ ink: '#ffffff', check: MINT_ON_DARK, node: VIOLET_ON_DARK }), {
    width: 393,
    height: 456,
  });
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;700&display=swap">
<style>
  html, body { margin: 0; width: 1200px; height: 630px; background: #0e1030; overflow: hidden; }
  body { display: grid; grid-template-columns: 1fr 393px; gap: 64px; align-items: center; padding: 0 96px; box-sizing: border-box;
    font-family: Outfit, 'Segoe UI', system-ui, sans-serif; color: ${INK_ON_DARK}; }
  .text { display: grid; gap: 28px; }
  h1 { margin: 0; font-size: 60px; line-height: 1.05; font-weight: 700; letter-spacing: -0.02em; }
  h1 span { color: ${VIOLET_ON_DARK}; }
  p { margin: 0; font-size: 24px; line-height: 1.4; color: #a09fc6; max-width: 560px; }
  .foot { font-size: 20px; color: #a09fc6; }
  .foot b { color: ${MINT_ON_DARK}; font-weight: 400; }
</style></head><body>
<div class="text">${words}
  <h1>Your Playwright results, <span>kept and explained.</span></h1>
  <p>CI throws away every report it makes. Piwi keeps them, then groups the failures by root cause, scores the flaky tests and finds the locator you should have used.</p>
  <div class="foot"><b>Self-hosted, zero telemetry</b> · piwitests.dev</div>
</div>${big}</body></html>`;
}

/** An ICO file holding the given PNG images (Windows reads PNG-compressed entries since Vista). */
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const entry = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

function write(path, content) {
  const file = resolve(ROOT, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`-> ${path}`);
}

const SVG_FILES = {
  'apps/application/public/logo.svg': squareLogo,
  'apps/docs/public/logo.svg': squareLogo,
  'apps/application/public/logo-wide.svg': lockup(LIGHT),
  'apps/docs/public/logo-wide.svg': lockup(LIGHT),
  'apps/application/public/logo-wide-dark.svg': lockup(DARK),
  'apps/docs/public/logo-wide-dark.svg': lockup(DARK),
  'apps/application/public/logo-nav.svg': navLockup(LIGHT),
  'apps/application/public/logo-nav-dark.svg': navLockup(DARK),
  // The collapsed sidebar rail: the small mark in one color.
  'apps/application/public/logo-mark.svg': monoMark(VIOLET, 24),
  'apps/application/public/logo-mark-dark.svg': monoMark(VIOLET_ON_DARK, 24),
  // A 40 × 40 plugin icon with the 2 px margin JetBrains asks for.
  'apps/jetbrains/src/main/resources/META-INF/pluginIcon.svg': appIcon({ small: true, inset: 26, size: 40 }),
  // Tool window and status widget icons, in the IntelliJ New UI icon greys.
  'apps/jetbrains/src/main/resources/icons/piwi.svg': monoMark('#6C707E', 13),
  'apps/jetbrains/src/main/resources/icons/piwi_dark.svg': monoMark('#CED0D6', 13),
  // VS Code tints a view container icon with the theme's foreground.
  'apps/vscode/media/piwi.svg': monoMark('currentColor', 24),
};

// PNG files: [path, size in px, the SVG drawn at that size].
const tile = appIcon({ small: true });
const storeIcon = appIcon({ small: false, inset: 16 });
const PNG_FILES = [
  ['apps/extension/public/icons/icon-16.png', 16, tile],
  ['apps/extension/public/icons/icon-32.png', 32, tile],
  ['apps/extension/public/icons/icon-48.png', 48, tile],
  ['apps/extension/public/icons/icon-128.png', 128, storeIcon],
  ['apps/vscode/icon.png', 128, storeIcon],
  // iOS rounds the corners itself, so the touch icon is a full square.
  ['apps/docs/public/apple-touch-icon.png', 180, appIcon({ small: false, radius: 0, scale: 0.66 })],
];
const ICO_FILES = ['apps/application/public/favicon.ico', 'apps/docs/public/favicon.ico'];

for (const [path, content] of Object.entries(SVG_FILES)) write(path, content);

/**
 * The small mark as data, for the documents Piwi writes outside the dashboard (`shared/brand.ts` draws it): the outline
 * with the lens and the eye as holes, the check and the perch as strokes, the two dots, and a PNG of it in violet for
 * emails, which strip inline SVG.
 */
function markData(png) {
  return {
    viewBox: [VIEW.markSmall.x, VIEW.markSmall.y, VIEW.markSmall.w, VIEW.markSmall.h],
    outline: OUTLINE,
    lens: LENS,
    eye: EYE_SMALL,
    check: { d: CHECK, strokeWidth: 22 },
    perch: { d: 'M28.2 276.73 L83.43 241.904 L154.16 276.68', strokeWidth: 28 },
    dots: [
      { cx: 28.2, cy: 276.73, r: 32 },
      { cx: 154.16, cy: 276.68, r: 32 },
    ],
    color: VIOLET,
    png: png.toString('base64'),
  };
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const render = async (markup, size) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${markup.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`,
    );
    return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };
  for (const [path, size, markup] of PNG_FILES) write(path, await render(markup, size));
  const images = [];
  for (const size of [16, 32, 48]) images.push({ size, png: await render(tile, size) });
  const favicon = ico(images);
  for (const path of ICO_FILES) write(path, favicon);
  // Shown at 16 px in emails, rendered at twice that for sharp screens.
  const markPng = await render(monoMark(VIOLET, 32), 32);
  write('apps/application/shared/brand-mark.json', `${JSON.stringify(markData(markPng), null, 2)}\n`);

  // Outfit comes from Google Fonts; offline, the card falls back to the system sans-serif.
  const card = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
  await card.setContent(socialCard(), { waitUntil: 'load', timeout: 30_000 });
  await card.evaluate(() => document.fonts.ready);
  write('apps/docs/public/og-image.png', await card.screenshot());
} finally {
  await browser.close();
}
