import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { readPageInteraction } from '../src/internal/capture/capture-fixtures.js';

const PAGE = `<!doctype html><html><head><script>/* dropped from snapshots */</script></head><body>
<script>/* a body script shifts no element path */</script>
<nav><ul><li id="products">Products</li><li>About</li></ul></nav>
<form><input id="email" value="ada@example.com"><input type="checkbox" name="all"><input type="password" name="pw"></form>
<x-card></x-card>
<p id="first">Hello <b>big</b> world</p><p>Second paragraph</p>
<script>
customElements.define('x-card', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<span>title</span><button>Inside</button>'; }
});
document.querySelector('[name=all]').indeterminate = true;
</script></body></html>`;

describe('readPageInteraction', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });
  afterAll(async () => browser?.close());

  it('names the focused field, its caret, the hovered element and indeterminate boxes by element path', async () => {
    await page.setContent(PAGE);
    await page.hover('#products');
    await page.focus('#email');
    await page.evaluate(() => (globalThis as any).document.querySelector('#email').setSelectionRange(3, 7));

    expect(await page.evaluate(readPageInteraction)).toEqual({
      focus: {
        element: { path: 'html:1/body:1/form:1/input:1', label: 'input#email' },
        visible: true,
        selection: [3, 7],
      },
      hover: { path: 'html:1/body:1/nav:1/ul:1/li:1', label: 'li#products' },
      indeterminate: [{ path: 'html:1/body:1/form:1/input:2', label: 'input[name="all"]' }],
    });
  });

  it('steps into an open shadow root with |', async () => {
    await page.setContent(PAGE);
    await page.locator('x-card button').hover();
    await page.locator('x-card button').focus();
    const read = await page.evaluate(readPageInteraction);
    expect(read.focus?.element).toEqual({ path: 'html:1/body:1/x-card:1|button:1', label: 'button "Inside"' });
    expect(read.hover).toEqual({ path: 'html:1/body:1/x-card:1|button:1', label: 'button "Inside"' });
  });

  it("records a page text selection by offsets into its elements' text, never the text", async () => {
    await page.setContent(PAGE);
    await page.evaluate(() => {
      const g = globalThis as any;
      const first = g.document.querySelector('#first');
      // From " wo|rld", 12 characters into "Hello big world" across the <b>, to "Second|".
      const range = g.document.createRange();
      range.setStart(first.lastChild, 3);
      range.setEnd(first.nextElementSibling.firstChild, 6);
      g.getSelection().removeAllRanges();
      g.getSelection().addRange(range);
    });
    const read = await page.evaluate(readPageInteraction);
    expect(read.selection).toEqual({
      start: { path: 'html:1/body:1/p:1', offset: 12 },
      end: { path: 'html:1/body:1/p:2', offset: 6 },
      length: await page.evaluate(() => String((globalThis as any).getSelection()).length),
    });
    expect(JSON.stringify(read)).not.toContain('Second');
  });

  it('reads no focus when nothing is focused, and never a value', async () => {
    await page.setContent(PAGE);
    await page.fill('[name=pw]', 'hunter2');
    await page.evaluate(() => (globalThis as any).document.activeElement.blur());
    const read = await page.evaluate(readPageInteraction);
    expect(read.focus).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain('hunter2');
    expect(JSON.stringify(read)).not.toContain('ada@example.com');
  });
});
