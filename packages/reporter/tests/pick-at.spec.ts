import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import { probeElementAttrs, showAnchorPicker, showPickerChoices } from '@piwitests/picker-dom';
import { CAPTURED_ATTRS_ARG } from '../src/internal/capture/capture-fixtures.js';
import { PICK_AT_NEEDS, boxesAt, pickAtPoint, snapshotBoxes } from '../src/internal/capture/pick-at.js';
import { playwrightAtLeast } from './_helpers.js';

/** A page's ARIA snapshot in AI mode with its boxes, as Playwright 1.64 writes it, a page scrolled and an iframe in it. */
const SNAPSHOT = `- generic [active] [ref=e1] [box=8,-1057,784,1649]:
  - heading "Sign in" [level=1] [ref=e2] [box=8,-1057,784,37]
  - generic [ref=e3] [box=8,81,227,17]:
    - text: Email
    - textbox "Email" [ref=e4] [box=50,80,185,21]: dev@example.com [ref=e9] [box=0,0,9999,9999]
  - button "Continue \\"now\\" [ref=e8] [box=0,0,1,1]" [ref=e5] [box=239,80,69,21]
  - link "Home" [ref=e6] [box=10,120,0,0]:
    - /url: /home
  - iframe [ref=e7] [box=48,522,204,64]:
    - button "Inner" [ref=f1e2] [box=8,8,46,21]`;

describe('pick on the image', () => {
  it('reads the main frame’s elements and their boxes, whatever a name or a value says', () => {
    expect(snapshotBoxes(SNAPSHOT)).toEqual([
      { ref: 'e1', role: 'generic', x: 8, y: -1057, width: 784, height: 1649, depth: 0, ancestors: [] },
      { ref: 'e2', role: 'heading', x: 8, y: -1057, width: 784, height: 37, depth: 1, ancestors: ['e1'] },
      { ref: 'e3', role: 'generic', x: 8, y: 81, width: 227, height: 17, depth: 1, ancestors: ['e1'] },
      // The value after the colon names no box of its own.
      { ref: 'e4', role: 'textbox', x: 50, y: 80, width: 185, height: 21, depth: 2, ancestors: ['e1', 'e3'] },
      // A name that looks like a ref and a box is a name.
      { ref: 'e5', role: 'button', x: 239, y: 80, width: 69, height: 21, depth: 1, ancestors: ['e1'] },
      // An element with no size is left out, and so is one in an iframe, whose box is its frame's.
      { ref: 'e7', role: 'iframe', x: 48, y: 522, width: 204, height: 64, depth: 1, ancestors: ['e1'] },
    ]);
    expect(snapshotBoxes('- button "Go" [ref=e1]')).toEqual([]);
    expect(snapshotBoxes('')).toEqual([]);
  });

  it('finds the elements under a point, the innermost first, then the smallest and the deepest', () => {
    const boxes = snapshotBoxes(SNAPSHOT);
    expect(boxesAt(boxes, 273.9, 90.4).map((b) => b.ref)).toEqual(['e5', 'e1']);
    // The field overflows its label's smaller box: the field is under the point.
    expect(boxesAt(boxes, 60, 90).map((b) => b.ref)).toEqual(['e4', 'e3', 'e1']);
    expect(boxesAt(boxes, 100, 540).map((b) => b.ref)).toEqual(['e7', 'e1']);
    // A box holds its left and top edges, not its right and bottom ones.
    expect(boxesAt(boxes, 308, 90).map((b) => b.ref)).toEqual(['e1']);
    expect(boxesAt(boxes, 239, 80).map((b) => b.ref)).toEqual(['e5', 'e1']);
    expect(boxesAt(boxes, 900, 900)).toEqual([]);
    const twins = snapshotBoxes(`- generic [ref=e1] [box=0,0,10,10]:
  - generic [ref=e2] [box=0,0,10,10]`);
    expect(boxesAt(twins, 5, 5).map((b) => b.ref)).toEqual(['e2', 'e1']);
    // Two elements that overlap, neither in the other: the smaller.
    const siblings = snapshotBoxes(`- generic [ref=e1] [box=0,0,100,100]:
  - dialog [ref=e2] [box=0,0,50,50]
  - button "Go" [ref=e3] [box=10,10,20,20]`);
    expect(boxesAt(siblings, 15, 15).map((b) => b.ref)).toEqual(['e3', 'e2', 'e1']);
  });
});

/** A page whose button the point is over, with what a person sees there: the probe runs as the pause bar's does. */
const PROBE = { fn: probeElementAttrs, arg: CAPTURED_ATTRS_ARG };
const STYLE = '<style>body { margin: 0; font: 16px sans-serif } button { width: 120px; height: 40px }</style>';

describe.skipIf(!playwrightAtLeast('1.60'))('pick on the image, on a page', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => browser?.close());

  /** The locator picked at a point of a page of `body`, or why none was. */
  async function pickOn(body: string, x: number, y: number, options: { deviceScaleFactor?: number } = {}) {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, ...options });
    try {
      const page = await context.newPage();
      await page.setContent(`<!doctype html><meta charset="utf-8">${STYLE}${body}`);
      const found = await pickAtPoint(page, PROBE, x, y);
      return 'refusal' in found ? found.refusal : found.picked.picked.locator;
    } finally {
      await context.close();
    }
  }

  it('picks what a dialog, a fixed banner or a sticky header shows over the element under it', async () => {
    // A dialog over the page: its text covers the button.
    const dialog = `<button style="position:absolute;left:100px;top:100px">Behind</button>
      <div role="dialog" aria-label="Terms" style="position:fixed;inset:0;background:#fff">
        <p style="position:absolute;left:40px;top:60px;width:400px;height:200px;margin:0">Read these terms first.</p>
      </div>`;
    expect(await pickOn(dialog, 160, 120)).toBe("getByText('Read these terms first.')");
    // A cookie banner fixed over the page's button.
    const banner = `<button style="position:absolute;left:100px;top:100px">Pay</button>
      <div role="region" aria-label="Cookies" style="position:fixed;left:0;top:80px;width:100%;height:120px;background:#333">
        <button style="margin:20px;width:300px;height:80px">Accept all cookies</button>
      </div>`;
    expect(await pickOn(banner, 160, 120)).toBe("getByRole('button', { name: 'Accept all cookies' })");
    // Away from its button, the banner itself.
    expect(await pickOn(banner, 600, 120)).toBe("getByRole('region', { name: 'Cookies' })");
    // A sticky header over the page scrolled under it.
    const sticky = `<header style="position:sticky;top:0;height:60px;background:#eee"><a href="#top">Home</a></header>
      <div style="height:200px"></div><button>Under</button><div style="height:2000px"></div>
      <script>scrollTo(0, 210)</script>`;
    expect(await pickOn(sticky, 60, 30)).toBe("getByRole('banner')");
    expect(await pickOn(sticky, 60, 70)).toBe("getByRole('button', { name: 'Under' })");
  });

  it('passes through an overlay of pointer-events: none, and reaches into an open shadow root', async () => {
    const watermark = `<a href="#x" style="position:absolute;left:100px;top:100px;width:100px;height:40px;display:block">Go there</a>
      <div style="position:fixed;inset:0;pointer-events:none">
        <span style="position:absolute;left:90px;top:90px;width:400px;height:100px;display:block">Watermark</span>
      </div>`;
    expect(await pickOn(watermark, 140, 115)).toBe("getByRole('link', { name: 'Go there' })");
    const shadow = `<div id="host"></div><script>
      document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
        '<div style="padding:10px"><button style="width:120px;height:40px">In shadow</button></div>';
    </script>`;
    expect(await pickOn(shadow, 50, 30)).toBe("getByRole('button', { name: 'In shadow' })");
  });

  it('names a point in CSS pixels of the viewport, the page scrolled or at a device scale factor of 2', async () => {
    const scrolled = `<div style="height:1000px">top</div><button>Lower</button><div style="height:2000px"></div>
      <script>scrollTo(0, 1000)</script>`;
    expect(await pickOn(scrolled, 60, 20)).toBe("getByRole('button', { name: 'Lower' })");
    const banner = `<button style="position:absolute;left:100px;top:100px">Pay</button>
      <div style="position:fixed;left:0;top:80px;width:100%;height:120px"><button style="margin:20px;width:300px;height:80px">Accept</button></div>`;
    expect(await pickOn(banner, 160, 120, { deviceScaleFactor: 2 })).toBe("getByRole('button', { name: 'Accept' })");
    expect(await pickOn(banner, 50, 250, { deviceScaleFactor: 2 })).toBe(
      'No element there: pick an element of the page, not its background.',
    );
  });

  it('leaves Piwi’s own panels out: the picker’s choice list and anchors step pick the page under them', async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    try {
      const page = await context.newPage();
      await page.setContent(`<!doctype html><meta charset="utf-8">${STYLE}
        <form data-testid="shop"><button id="page" style="position:fixed;inset:0;width:100%;height:100%">Page</button></form>`);
      await page.evaluate(showPickerChoices, { failing: null, choices: [{ locator: "getByRole('link')", score: 90 }] });
      const choice = await page.locator('#__piwi_picker_choices button').first().boundingBox({ timeout: 2000 });
      const atChoice = await pickAtPoint(page, PROBE, choice!.x + 5, choice!.y + 5);
      expect('picked' in atChoice && atChoice.picked.picked.locator).toBe("getByRole('button', { name: 'Page' })");
      await page.evaluate(() => (globalThis as any).__piwiChoiceCleanup?.());
      await page.evaluate(() => {
        const g = globalThis as any;
        g.__piwiPickedElement = g.document.getElementById('page');
      });
      await page.evaluate(showAnchorPicker, {
        tagRoles: { button: 'button', form: 'form' },
        inputRoles: {},
        roleSources: 'button',
        leafRole: 'button',
        leafLevel: null,
        leafTestId: null,
      });
      const panel = await page.locator('#__piwi_anchor_panel').boundingBox({ timeout: 2000 });
      const atPanel = await pickAtPoint(page, PROBE, panel!.x + 10, panel!.y + 10);
      expect('picked' in atPanel && atPanel.picked.picked.locator).toBe("getByRole('button', { name: 'Page' })");
    } finally {
      await context.close();
    }
  }, 15_000);
});

describe.runIf(!playwrightAtLeast('1.60'))('pick on the image, on a Playwright without the snapshot’s boxes', () => {
  it('refuses, naming the version it needs', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent('<!doctype html><button>Save</button>');
      expect(await pickAtPoint(page, PROBE, 10, 10)).toEqual({ refusal: PICK_AT_NEEDS });
    } finally {
      await browser.close();
    }
  });
});
