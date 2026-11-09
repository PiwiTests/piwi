import { describe, test, expect } from 'vitest';
import { diffRawImages, pickBaselineShot } from '~~/server/utils/visual-diff';
import type { ScreenshotFileRow } from '~~/server/utils/case-screenshots';

/** Solid-color RGBA image. */
function solid(width: number, height: number, rgba: [number, number, number, number]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { data, width, height };
}

describe('diffRawImages', () => {
  test('identical images produce zero changed pixels and no mismatch', () => {
    const a = solid(20, 10, [255, 255, 255, 255]);
    const b = solid(20, 10, [255, 255, 255, 255]);
    const result = diffRawImages(a, b);
    expect(result.changedPixels).toBe(0);
    expect(result.dimensionMismatch).toBe(false);
    expect(result.width).toBe(20);
    expect(result.height).toBe(10);
    expect(result.overlay.length).toBe(20 * 10 * 4);
  });

  test('a changed block is counted', () => {
    const a = solid(10, 10, [255, 255, 255, 255]);
    const b = solid(10, 10, [255, 255, 255, 255]);
    // Paint a 4x4 black block into b
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        b.data.set([0, 0, 0, 255], (y * 10 + x) * 4);
      }
    }
    const result = diffRawImages(a, b);
    expect(result.changedPixels).toBe(16);
    expect(result.dimensionMismatch).toBe(false);
  });

  test('mismatched dimensions are compared on the padded union canvas and flagged', () => {
    const a = solid(10, 10, [10, 20, 30, 255]);
    const b = solid(12, 8, [10, 20, 30, 255]);
    const result = diffRawImages(a, b);
    expect(result.dimensionMismatch).toBe(true);
    expect(result.width).toBe(12);
    expect(result.height).toBe(10);
    // The non-overlapping regions differ (color vs transparent padding):
    // a is missing the 2px right column (2*8 visible in b), b is missing the
    // bottom 2 rows of a (10*2). Overlap area is identical.
    expect(result.changedPixels).toBe(2 * 8 + 10 * 2);
  });
});

describe('pickBaselineShot', () => {
  let nextId = 1;
  /** A screenshot row: its attachment name, and its stored file name. */
  function shot(subtype: string | null, file: string): ScreenshotFileRow {
    return { id: nextId++, type: 'attachment', subtype, label: 'image/png', path: `project-1/run-1/case-1/${file}` };
  }

  test('a step screenshot is compared with the same step, not the newest step', () => {
    const failing = shot('Step 3', 'step-3.png');
    const candidates = [
      shot('Step 10', 'step-10.png'),
      shot('Step 9', 'step-9.png'),
      shot('Step 3', 'step-3.png'),
      shot('Step 1', 'step-1.png'),
    ];
    expect(pickBaselineShot(failing, candidates)).toBe(candidates[2]);
  });

  test("Playwright's failure screenshot still matches the passing run's screenshot", () => {
    const failing = shot('screenshot', 'test-failed-1.png');
    const candidates = [shot('Cart', 'cart.png'), shot('screenshot', 'test-finished-1.png')];
    expect(pickBaselineShot(failing, candidates)).toBe(candidates[1]);
  });

  test('with no screenshot of the same name, the newest is the baseline', () => {
    const failing = shot('Step 3', 'step-3.png');
    const candidates = [shot('Checkout', 'checkout.png'), shot('Cart', 'cart.png')];
    expect(pickBaselineShot(failing, candidates)).toBe(candidates[0]);
  });
});
