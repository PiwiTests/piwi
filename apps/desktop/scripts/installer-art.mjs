// Renders the Windows installers' artwork from the Piwi logos into src-tauri/windows/:
//
//   installer-sidebar.bmp  164 x 314  NSIS welcome and finish pages (bundle > windows > nsis > sidebarImage)
//   installer-header.bmp   150 x  57  NSIS page header, right side (headerImage, uninstallerHeaderImage)
//   msi-dialog.bmp         493 x 312  WiX welcome and exit dialogs (bundle > windows > wix > dialogImagePath)
//   msi-banner.bmp         493 x  58  WiX dialog banner (bannerPath)
//
// NSIS and WiX read only uncompressed bitmaps at these sizes, so the script writes 24-bit BMPs. They are committed:
// run it again after a logo changes, from apps/desktop/, once `npm ci` has run at the repository root (it renders with
// the root's sharp):
//
//   npm run installer-art

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const publicDir = new URL('../../application/public/', import.meta.url);
const outDir = new URL('../src-tauri/windows/', import.meta.url);

const NAVY = '#0d1d47';
const PURPLE = '#7c3aed';
const TEAL = '#2fd9ae';
const AMBER = '#fbbf24';
const ROSE = '#fb7185';

/** A logo file's markup as a nested `<svg>` placed at x, y with the given size; `viewBox` crops it. */
function logo(file, { x, y, width, height, viewBox }) {
  const source = readFileSync(new URL(file, publicDir), 'utf8');
  const inner = source.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>.*?<\/title>/, '');
  const box = viewBox ?? source.match(/viewBox="([^"]+)"/)[1];
  return `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="${box}">${inner}</svg>`;
}

/**
 * A grid of rounded squares, one per test run, the way the dashboard draws a test's history: mostly passed, a few
 * flaky, one failed, fading out toward the top.
 */
function runHistory({ x, y, columns, rows, size, gap }) {
  const pattern = ['pppppfpp', 'ppfppppp', 'pppppppx', 'pppfpppp'];
  const colors = { p: TEAL, f: AMBER, x: ROSE };
  let cells = '';
  for (let row = 0; row < rows; row++) {
    const opacity = (0.18 + (0.82 * row) / (rows - 1)).toFixed(2);
    for (let column = 0; column < columns; column++) {
      const kind = pattern[row % pattern.length][column % pattern[0].length];
      const cx = x + column * (size + gap);
      const cy = y + row * (size + gap);
      cells += `<rect x="${cx}" y="${cy}" width="${size}" height="${size}" rx="2.5" fill="${colors[kind]}" opacity="${opacity}"/>`;
    }
  }
  return cells;
}

/** The dark panel of the welcome and finish pages: the logo on a purple-to-navy gradient, over a run history. */
function sidebarPanel(width, height) {
  const markWidth = 70;
  const markHeight = (markWidth * 316) / 266;
  const wordWidth = 76;
  const wordHeight = (wordWidth * 250) / 450;
  const columns = 8;
  const rows = 4;
  const size = 10;
  const gap = 5;
  const gridWidth = columns * size + (columns - 1) * gap;
  const gridHeight = rows * size + (rows - 1) * gap;
  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0" stop-color="${PURPLE}"/>
        <stop offset="0.6" stop-color="#3b1d8f"/>
        <stop offset="1" stop-color="${NAVY}"/>
      </linearGradient>
      <radialGradient id="glow" cx="0.5" cy="0.25" r="0.45">
        <stop offset="0" stop-color="#c4b5fd" stop-opacity="0.35"/>
        <stop offset="1" stop-color="#c4b5fd" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="ground" cx="0.5" cy="1" r="0.55">
        <stop offset="0" stop-color="${TEAL}" stop-opacity="0.2"/>
        <stop offset="1" stop-color="${TEAL}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <rect width="${width}" height="${height}" fill="url(#glow)"/>
    <rect width="${width}" height="${height}" fill="url(#ground)"/>
    ${logo('logo-nav-dark.svg', { x: (width - markWidth) / 2 + 3, y: 40, width: markWidth, height: markHeight, viewBox: '-6 -4 266 316' })}
    ${logo('logo-nav-dark.svg', { x: (width - wordWidth) / 2, y: 40 + markHeight + 16, width: wordWidth, height: wordHeight, viewBox: '310 10 450 250' })}
    ${runHistory({ x: Math.round((width - gridWidth) / 2), y: height - gridHeight - 26, columns, rows, size, gap })}
  `;
}

/** The light logo, right-aligned on white, for the headers above the inner pages. */
function headerLogo(width, height, logoHeight, margin) {
  const logoWidth = (logoHeight * 772) / 316;
  return `
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    ${logo('logo-nav.svg', { x: width - logoWidth - margin, y: (height - logoHeight) / 2, width: logoWidth, height: logoHeight })}
  `;
}

const ART = {
  'installer-sidebar.bmp': { width: 164, height: 314, body: () => sidebarPanel(164, 314) },
  'installer-header.bmp': { width: 150, height: 57, body: () => headerLogo(150, 57, 34, 8) },
  'msi-dialog.bmp': {
    width: 493,
    height: 312,
    body: () => `<rect width="493" height="312" fill="#ffffff"/>${sidebarPanel(164, 312)}`,
  },
  'msi-banner.bmp': { width: 493, height: 58, body: () => headerLogo(493, 58, 36, 14) },
};

/** An uncompressed, bottom-up 24-bit BMP of `rgb` (rows of width * 3 bytes, top row first). */
function bmp(rgb, width, height) {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const pixels = stride * height;
  const file = Buffer.alloc(54 + pixels);
  file.write('BM', 0, 'ascii');
  file.writeUInt32LE(54 + pixels, 2);
  file.writeUInt32LE(54, 10);
  file.writeUInt32LE(40, 14);
  file.writeInt32LE(width, 18);
  file.writeInt32LE(height, 22);
  file.writeUInt16LE(1, 26);
  file.writeUInt16LE(24, 28);
  file.writeUInt32LE(pixels, 34);
  file.writeInt32LE(2835, 38);
  file.writeInt32LE(2835, 42);
  for (let row = 0; row < height; row++) {
    const target = 54 + (height - 1 - row) * stride;
    for (let column = 0; column < width; column++) {
      const source = (row * width + column) * 3;
      file[target + column * 3] = rgb[source + 2];
      file[target + column * 3 + 1] = rgb[source + 1];
      file[target + column * 3 + 2] = rgb[source];
    }
  }
  return file;
}

/** Supersampling factor: the art is drawn at this scale, then reduced, for smooth edges on the small shapes. */
const SCALE = 4;

for (const [name, { width, height, body }] of Object.entries(ART)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body()}</svg>`;
  const { data } = await sharp(Buffer.from(svg), { density: 72 * SCALE })
    .resize(width, height, { kernel: 'lanczos3' })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  writeFileSync(new URL(name, outDir), bmp(data, width, height));
  console.log(`${fileURLToPath(new URL(name, outDir))} (${width} x ${height})`);
}
