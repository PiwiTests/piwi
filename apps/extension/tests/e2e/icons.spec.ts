import { test, expect } from './fixtures.js';
import { ICONS } from '../../src/shared/icons.js';

/** How far a glyph's box may sit from the grid's center, in grid units: a 16-pixel icon draws a unit at ⅔ of a pixel. */
const TOLERANCE = 0.1;

/** A triangle is centered on its weight, to the right of its box's center. */
const OFFSETS: Partial<Record<keyof typeof ICONS, { x: number; y: number }>> = { play: { x: 0.5, y: 0 } };

/**
 * Every icon is drawn on the middle of its 24 × 24 grid, so it sits in the
 * middle of its button or badge, and inside the grid with its stroke.
 */
test('every icon is centered on its grid', async ({ context }) => {
  const page = await context.newPage();
  await page.setContent('<svg viewBox="0 0 24 24" width="24" height="24"></svg>');
  const paths = Object.fromEntries(
    Object.entries(ICONS).map(([name, parts]) => [
      name,
      (parts as readonly (string | { fill: string })[]).map((part) => (typeof part === 'string' ? part : part.fill)),
    ]),
  );
  const boxes = await page.evaluate((icons) => {
    const svg = document.querySelector('svg')!;
    const out: Record<string, { x1: number; y1: number; x2: number; y2: number }> = {};
    for (const [name, ds] of Object.entries(icons)) {
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      for (const d of ds) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        group.appendChild(path);
      }
      svg.replaceChildren(group);
      const box = group.getBBox();
      out[name] = { x1: box.x, y1: box.y, x2: box.x + box.width, y2: box.y + box.height };
    }
    return out;
  }, paths);

  const off: string[] = [];
  for (const [name, box] of Object.entries(boxes)) {
    const want = OFFSETS[name as keyof typeof ICONS] ?? { x: 0, y: 0 };
    const dx = (box.x1 + box.x2) / 2 - 12 - want.x;
    const dy = (box.y1 + box.y2) / 2 - 12 - want.y;
    if (Math.abs(dx) > TOLERANCE || Math.abs(dy) > TOLERANCE) off.push(`${name}: ${dx.toFixed(2)}, ${dy.toFixed(2)}`);
    // A stroke 2 units wide reaches 1 unit outside the path.
    if (box.x1 < 1 || box.y1 < 1 || box.x2 > 23 || box.y2 > 23) off.push(`${name}: outside the grid`);
  }
  expect(off).toEqual([]);
});
