#!/usr/bin/env node
/**
 * Records the trace fixtures of `tests/dom-snapshot-state.spec.ts`: one page holding every live state a trace
 * snapshot keeps beside the DOM (field values, a password, checkboxes, a selected option, a scrolled list and
 * page, a modal dialog, a popover, a web component with an adopted stylesheet), a menu shown by CSS `:hover` and
 * a `:focus-visible` rule, driven by a test that hovers the menu and whose last click fails, so the failure-time
 * snapshot holds them all.
 *
 * Usage (from apps/application/), once per Playwright version the fixtures cover:
 *   node scripts/record-live-state-traces.mjs          # the workspace's Playwright
 *   node scripts/record-live-state-traces.mjs <dir>    # another one: a folder whose node_modules holds playwright-core
 *
 * `CHROMIUM_PATH` points at a Chromium to launch when that Playwright has none of its own installed.
 *
 * Output (committed): tests/fixtures/trace-live-state-<major>.<minor>.zip
 */

import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = process.argv[2] ? resolve(process.argv[2], 'package.json') : join(APP_DIR, 'package.json');
const playwright = createRequire(from)('playwright-core');
const version = createRequire(from)('playwright-core/package.json').version.split('.').slice(0, 2).join('.');

const PAGE = `<!doctype html><html><head><style>
.card { padding: 4px; & .inner { color: green } }
x-card:not(:defined) { visibility: hidden }
.submenu { display: none }
#products:hover > .submenu { display: block }
button:focus-visible { outline: 3px solid rgb(255, 0, 0) }
</style></head><body>
<nav><ul><li id="products">Products<ul class="submenu"><li>Laptops</li></ul></li></ul></nav>
<label>Name <input id="name" value="default"></label>
<label>Password <input id="pw" type="password"></label>
<textarea id="notes">initial</textarea>
<input id="agree" type="checkbox" checked>
<input id="news" type="checkbox">
<select id="country"><option value="fr" selected>France</option><option value="de">Germany</option></select>
<div id="list" style="height:60px;overflow:auto"><div style="height:400px">tall</div></div>
<div class="card"><span class="inner">nested</span></div>
<x-card id="wc"><span>light</span></x-card>
<button id="open">Open</button>
<dialog id="dlg"><p>modal body</p><button id="ok">OK</button></dialog>
<div id="toast" popover="manual">Saved</div>
<div style="height:2000px">spacer</div>
<script>
customElements.define('x-card', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<b class="title">shadow title</b><slot></slot>';
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.title { color: purple }');
    root.adoptedStyleSheets = [sheet];
  }
});
const sheet = new CSSStyleSheet();
sheet.replaceSync('body { font-family: serif }');
document.adoptedStyleSheets = [sheet];
document.getElementById('open').addEventListener('click', () => {
  document.getElementById('dlg').showModal();
  document.getElementById('toast').showPopover();
});
</script></body></html>`;

const browser = await playwright.chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
await context.tracing.start({ snapshots: true });
const page = await context.newPage();
await page.setContent(PAGE);
await page.fill('#name', 'Ada Lovelace');
await page.fill('#pw', 'hunter2');
await page.fill('#notes', 'typed notes');
await page.uncheck('#agree');
await page.check('#news');
await page.selectOption('#country', 'de');
await page.hover('#products');
await page.click('#open');
await page.evaluate(() => {
  document.getElementById('list').scrollTop = 120;
  window.scrollTo(0, 300);
});
await page.click('#missing', { timeout: 300 }).catch(() => {});
const out = join(APP_DIR, 'tests', 'fixtures', `trace-live-state-${version}.zip`);
await context.tracing.stop({ path: out });
await browser.close();
console.log(`Recorded ${out}`);
