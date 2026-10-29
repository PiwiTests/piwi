import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { contentOnScreen } from '../lib/script.mjs';

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
