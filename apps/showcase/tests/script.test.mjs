import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Gestures, contentOnScreen } from '../lib/script.mjs';

describe('a page’s content on the screen', () => {
  // As Chromium told them on a 3840 × 2160 screen at scale 2, its toolbar 87 CSS pixels high.
  const window = { screenX: 0, screenY: 0, outerWidth: 1920, outerHeight: 1080 };

  test('at the browser’s scale, below its toolbar', () => {
    const content = contentOnScreen({ ...window, innerWidth: 1920, innerHeight: 993, dpr: 2 }, 2);
    assert.deepEqual(content, { x: 0, y: 174, width: 3840, height: 1986, dpr: 2 });
  });

  test('zoomed to 125 %, the same place on the screen, at 2.5 device pixels a CSS pixel', () => {
    const content = contentOnScreen({ ...window, innerWidth: 1536, innerHeight: 794, dpr: 2.5 }, 2);
    assert.deepEqual(content, { x: 0, y: 175, width: 3840, height: 1985, dpr: 2.5 });
  });

  test('a window placed on the screen, its page unzoomed', () => {
    const runs = { screenX: 1080, screenY: 540, outerWidth: 800, outerHeight: 500, innerWidth: 800, innerHeight: 500 };
    assert.deepEqual(contentOnScreen({ ...runs, dpr: 2 }, 2), { x: 2160, y: 1080, width: 1600, height: 1000, dpr: 2 });
  });
});

describe('a gesture’s point', () => {
  // VS Code's window, 1080 × 720 CSS pixels at scale 2, and an element whose box is `rect` in it.
  const vscode = {
    evaluate: async () => ({
      screenX: 0,
      screenY: 0,
      outerWidth: 1080,
      outerHeight: 720,
      innerWidth: 1080,
      innerHeight: 720,
      dpr: 2,
    }),
  };
  const pointOf = async (rect, options) => {
    const gestures = new Gestures({ windows: { vscode: () => vscode }, scale: 2 });
    const locator = { waitFor: async () => {}, boundingBox: async () => rect };
    await gestures.record('click', 'vscode', locator, {}, options);
    return gestures.log[0].point;
  };

  test('is the middle of an element inside the window', async () => {
    assert.deepEqual(await pointOf({ x: 100, y: 200, width: 40, height: 20 }), { x: 240, y: 420 });
  });

  test('is the middle of the part inside the window of an element that runs past it, as Playwright clicks', async () => {
    // An editor’s lines, scrolled far down: from 681 CSS pixels above the window to 391 into it, and past its right.
    assert.deepEqual(await pointOf({ x: 426, y: -681, width: 1198, height: 1072 }), { x: 1506, y: 391 });
  });

  test('is the given position in the element', async () => {
    assert.deepEqual(await pointOf({ x: 100, y: 200, width: 40, height: 20 }, { position: { x: 5, y: 6 } }), {
      x: 210,
      y: 412,
    });
  });
});
