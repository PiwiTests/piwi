import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import {
  pageMapFetcher,
  startCodeReach,
  stopPageCoverage,
  type CapturedSheet,
} from '../src/internal/capture/code-reach.js';
import { resetCssCoverageCache, resolveCssCoverage } from '../src/internal/capture/css-coverage.js';

let dir = '';

function write(file: string, text: string): string {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
}

const roots = () => ({ roots: [dir], repoRoot: dir });
const noMaps = async () => null;

/** A sheet as the capture records it, its used ranges given by the text of the rules that matched. */
function sheet(text: string, used: string[], extra: Partial<CapturedSheet> = {}): CapturedSheet {
  const ranges = new Map<string, { startOffset: number; endOffset: number }>();
  for (const rule of used) {
    const startOffset = text.indexOf(rule);
    ranges.set(rule, { startOffset, endOffset: startOffset + rule.length });
  }
  return { sourceURL: 'http://app.test/', isInline: false, startLine: 0, text, used: ranges, ...extra };
}

beforeEach(() => resetCssCoverageCache());

describe('resolveCssCoverage', () => {
  const APP = '.a { color: red }\n.b {\n  color: blue;\n}\n.c { color: green }\n';

  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-css-')));
    write('web/assets/app.css', APP);
    write(
      'src/App.vue',
      "<template><p class=\"x\">x</p></template>\n<script>const css = '<style>';</script>\n<style scoped>\n.x { color: red }\n.y { color: blue }\n</style>\n",
    );
    write('src/index.css', '@tailwind base;\n\n.btn {\n  color: red;\n}\n');
    write('src/theme.scss', '$c: red;\n\n.t {\n  color: $c;\n}\n');
    write('node_modules/tailwindcss/index.css', '.p-1 { padding: 1px }\n');
    write('dist/bundle.css', '.z{color:red}\n');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('resolves a sheet served by path, with its matched rules and every rule it declares', async () => {
    const served = sheet(APP, ['.b {\n  color: blue;\n}'], { sourceURL: 'http://app.test/web/assets/app.css' });
    expect(await resolveCssCoverage([served], roots(), noMaps)).toEqual({
      reached: new Map([['web/assets/app.css', [[2, 4]]]]),
      known: new Map([
        [
          'web/assets/app.css',
          [
            [1, 1],
            [2, 4],
            [5, 5],
          ],
        ],
      ]),
    });
  });

  it("places a component's <style> block a Vite dev server injected at its lines in the file", async () => {
    const text = '\n.x { color: red }\n.y { color: blue }\n';
    const injected = sheet(text, ['.x { color: red }'], {
      isInline: true,
      devId: `${dir}/src/App.vue?vue&type=style&index=0&scoped=7a7a37b1&lang.css`,
    });
    const { reached } = await resolveCssCoverage([injected], roots(), noMaps);
    // The `<style>` in the script is no block: the file's block starts on line 3, its `.x` on line 4.
    expect(reached).toEqual(new Map([['src/App.vue', [[4, 4]]]]));
  });

  it("counts a preprocessor's output served without its map at file level, its lines not being the file's", async () => {
    // What a dev server injects for src/index.css once Tailwind ran: the preflight first, `.btn` lines further down.
    const text = '*, ::before { box-sizing: border-box }\nhtml { line-height: 1.5 }\n.btn {\n  color: red;\n}\n';
    const compiled = sheet(text, ['.btn {\n  color: red;\n}'], { isInline: true, devId: `${dir}/src/index.css` });
    expect(await resolveCssCoverage([compiled], roots(), noMaps)).toEqual({
      reached: new Map([['src/index.css', []]]),
      known: new Map(),
    });
  });

  it("maps a sheet's lines through its source map, and drops the sources under node_modules", async () => {
    // Line 1 `.t{color:red}` comes from theme.scss line 3, line 2 `.p-1{…}` from tailwind's own sheet.
    const map = { version: 3, sources: ['src/theme.scss', 'node_modules/tailwindcss/index.css'], mappings: 'AAEA;ACFA' };
    const text = `.t{color:red}\n.p-1{padding:1px}\n/*# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')} */\n`;
    const compiled = sheet(text, ['.t{color:red}', '.p-1{padding:1px}'], { sourceURL: 'http://app.test/' });
    expect((await resolveCssCoverage([compiled], roots(), noMaps)).reached).toEqual(
      new Map([['src/theme.scss', [[3, 3]]]]),
    );
  });

  it('counts nothing for build output, a sheet with no file, or one whose text was not read', async () => {
    const built = sheet('.z{color:red}\n', ['.z{color:red}'], { sourceURL: 'http://app.test/dist/bundle.css' });
    const inPage = sheet('.q { color: red }', ['.q { color: red }'], { isInline: true, sourceURL: 'http://app.test/' });
    const unread: CapturedSheet = { sourceURL: 'http://app.test/web/assets/app.css', isInline: false, startLine: 0, used: new Map() };
    expect(await resolveCssCoverage([built, inPage, unread], roots(), noMaps)).toEqual({
      reached: new Map(),
      known: new Map(),
    });
  });
});

describe('in Chromium', () => {
  let browser: Browser | null = null;
  let server: http.Server;
  let url = '';

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-css-live-')));
    write(
      'assets/app.css',
      '.home { color: red }\n.next { color: blue }\n@media (min-width: 1px) {\n  .wide { margin: 0 }\n}\n.hover:hover { color: green }\n.never { color: pink }\n',
    );
    write('src/Card.vue', '<template><div class="card">x</div></template>\n<style>\n.card { padding: 1px }\n.card-idle { padding: 2px }\n</style>\n');
    write(
      'index.html',
      '<link rel="stylesheet" href="/assets/app.css"><div class="home wide hover">Home</div><a id="go" href="/next.html">Next</a>' +
        // The style element a Vite dev server injects for a component's <style> block.
        `<script>const s = document.createElement('style'); s.setAttribute('data-vite-dev-id', ${JSON.stringify(
          `${dir}/src/Card.vue?vue&type=style&index=0&lang.css`,
        )}); s.textContent = '\\n.card { padding: 1px }\\n.card-idle { padding: 2px }\\n'; document.head.appendChild(s); ` +
        "const d = document.createElement('div'); d.className = 'card'; document.body.appendChild(d);</script>",
    );
    write('next.html', '<link rel="stylesheet" href="/assets/app.css"><div class="next">Next</div>');
    server = http.createServer((req, res) => {
      const file = path.join(dir, (req.url ?? '/').split('?')[0] === '/' ? 'index.html' : req.url!.split('?')[0]!);
      if (!fs.existsSync(file)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('records the rules each document matched, the one it left included, and only the style sheets when asked', async () => {
    vi.stubEnv('PIWI_COVERAGE_CSS', 'rules');
    const page = await browser!.newPage();
    try {
      expect(await startCodeReach(page)).toBe(true);
      await page.goto(`${url}/`);
      await page.hover('.hover');
      // The home document is left through a link: what it matched is read before it goes.
      await page.click('#go');
      await page.waitForURL('**/next.html');
      const { scripts, sheets } = await stopPageCoverage(page);
      expect(scripts).toBeNull();
      const { reached, known } = await resolveCssCoverage(sheets, roots(), pageMapFetcher(page));
      // The home page's rules, the hovered one and the @media line included, then the next page's; never `.never`.
      expect(reached.get('assets/app.css')?.sort((a, b) => a[0] - b[0])).toEqual([
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
        [6, 6],
      ]);
      expect(reached.get('src/Card.vue')).toEqual([[3, 3]]);
      expect(known.get('src/Card.vue')).toEqual([
        [3, 3],
        [4, 4],
      ]);
    } finally {
      await page.close();
    }
  });

  it.each([
    ['the style sheets alone', { PIWI_COVERAGE_CSS: 'rules' }],
    ['scripts and style sheets', { PIWI_COVERAGE_CSS: 'rules', PIWI_COVERAGE_BROWSER: 'functions' }],
  ])('keeps what a document matched when a goto leaves it, with %s', async (_label, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    // The read at the pause once raced the page's resume: repeat to catch it.
    for (let round = 0; round < 4; round++) {
      resetCssCoverageCache();
      const page = await browser!.newPage();
      try {
        expect(await startCodeReach(page)).toBe(true);
        await page.goto(`${url}/next.html`);
        await page.goto('about:blank');
        const { sheets } = await stopPageCoverage(page);
        const { reached } = await resolveCssCoverage(sheets, roots(), pageMapFetcher(page));
        expect(reached.get('assets/app.css')).toEqual([[2, 2]]);
      } finally {
        await page.close();
      }
    }
  });
});
