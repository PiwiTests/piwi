import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import type { JsCoverageEntry } from '@piwitests/core/code-reach';
import {
  codeReachRoots,
  pageMapFetcher,
  resetCodeReachCaches,
  MAX_CACHED_SCRIPTS,
  mergeCoverageRead,
  resolveCodeReach,
  startCodeReach,
  stopCodeReach,
  type ParsedScript,
  type RanScript,
} from '../src/internal/capture/code-reach.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const vlq = (n: number) => {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
};

let dir = '';

function write(file: string, text: string): string {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
}

beforeEach(() => {
  resetCodeReachCaches();
});

describe('resolveCodeReach', () => {
  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-reach-')));
    write('src/components/Pay.vue', '<template><button>Pay</button></template>');
    write('src/cart.ts', 'export const x = 1;');
    write('src/unused.ts', 'export const y = 2;');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const roots = () => ({ roots: [dir], repoRoot: dir });

  it('a module served by path counts when a function other than its top level ran', async () => {
    const source = 'export function pay() {}\npay();';
    const ran: JsCoverageEntry = {
      url: 'http://localhost:5173/src/components/Pay.vue?t=1',
      source,
      functions: [
        { functionName: '', ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] },
        { functionName: 'pay', ranges: [{ startOffset: 7, endOffset: 24, count: 1 }] },
      ],
    };
    const importedOnly: JsCoverageEntry = {
      url: `http://localhost:5173/@fs${dir}/src/unused.ts`,
      source,
      functions: [{ functionName: '', ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }],
    };
    expect(await resolveCodeReach([ran, importedOnly], roots(), async () => null)).toEqual(['src/components/Pay.vue']);
  });

  it('a bundle resolves through its fetched source map, webpack prefixes and node_modules handled', async () => {
    // Line 0 maps to cart.ts, line 1 to node_modules, line 2 to unused.ts.
    const map = {
      version: 3,
      sources: [
        'webpack://shop/./src/cart.ts',
        'webpack://shop/./node_modules/vue/index.js',
        'webpack://shop/./src/unused.ts',
      ],
      mappings: ['AAAA', `A${vlq(1)}AA`, `A${vlq(1)}AA`].join(';'),
    };
    const source = 'function a(){}\nfunction b(){}\nfunction c(){}\na();b();\n//# sourceMappingURL=app.js.map';
    const entry: JsCoverageEntry = {
      url: 'http://localhost:3000/assets/app.js',
      source,
      functions: [
        { functionName: '', ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] },
        { functionName: 'a', ranges: [{ startOffset: 0, endOffset: 14, count: 1 }] },
        { functionName: 'b', ranges: [{ startOffset: 15, endOffset: 29, count: 1 }] },
        { functionName: 'c', ranges: [{ startOffset: 30, endOffset: 44, count: 0 }] },
      ],
    };
    const fetched: string[] = [];
    const files = await resolveCodeReach([entry, entry], roots(), async (url) => {
      fetched.push(url);
      return JSON.stringify(map);
    });
    expect(files).toEqual(['src/cart.ts']);
    expect(fetched).toEqual(['http://localhost:3000/assets/app.js.map']);
  });

  it('a rebuilt bundle at the same address reads its new map', async () => {
    const mapTo = (file: string) =>
      JSON.stringify({ version: 3, sources: [`webpack://shop/./${file}`], mappings: 'AAAA' });
    const build = (body: string): JsCoverageEntry => {
      const source = `${body}\n//# sourceMappingURL=app.js.map`;
      return {
        url: 'http://localhost:3000/assets/app.js',
        source,
        functions: [
          { functionName: '', ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] },
          { functionName: 'a', ranges: [{ startOffset: 0, endOffset: 14, count: 1 }] },
        ],
      };
    };
    const maps = [mapTo('src/cart.ts'), mapTo('src/unused.ts')];
    const fetchMap = async () => maps.shift() ?? null;
    expect(await resolveCodeReach([build('function a(){}a();')], roots(), fetchMap)).toEqual(['src/cart.ts']);
    expect(await resolveCodeReach([build('function a(){}a();a();')], roots(), fetchMap)).toEqual(['src/unused.ts']);
  });

  it('keeps only the latest version of a script, and a bounded number of scripts', async () => {
    const map = JSON.stringify({ version: 3, sources: ['webpack://shop/./src/cart.ts'], mappings: 'AAAA' });
    const script = (url: string, body: string): JsCoverageEntry => {
      const source = `${body}\n//# sourceMappingURL=${url.slice(url.lastIndexOf('/') + 1)}.map`;
      return {
        url,
        source,
        functions: [{ functionName: 'a', ranges: [{ startOffset: 0, endOffset: 14, count: 1 }] }],
      };
    };
    const fetched: string[] = [];
    const fetchMap = async (url: string) => (fetched.push(url), map);
    const app = 'http://localhost:3000/assets/app.js';
    for (const body of ['function a(){}a();', 'function a(){}a();a();', 'function a(){}a();']) {
      await resolveCodeReach([script(app, body)], roots(), fetchMap);
    }
    // The first version was replaced by the second, so it is read again.
    expect(fetched).toHaveLength(3);

    fetched.length = 0;
    for (let i = 0; i <= MAX_CACHED_SCRIPTS; i++) {
      await resolveCodeReach(
        [script(`http://localhost:3000/assets/chunk-${i}.js`, 'function a(){}a();')],
        roots(),
        fetchMap,
      );
    }
    await resolveCodeReach(
      [script('http://localhost:3000/assets/chunk-0.js', 'function a(){}a();')],
      roots(),
      fetchMap,
    );
    expect(fetched).toHaveLength(MAX_CACHED_SCRIPTS + 2);
  });

  it('reads an inline map', async () => {
    const map = { version: 3, sources: ['src/cart.ts'], mappings: 'AAAA' };
    const inline = `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
    const source = `function a(){}a();\n//# sourceMappingURL=${inline}`;
    const entry: JsCoverageEntry = {
      url: 'http://localhost:3000/bundle.js',
      source,
      functions: [
        { functionName: '', ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] },
        { functionName: 'a', ranges: [{ startOffset: 0, endOffset: 14, count: 1 }] },
      ],
    };
    expect(await resolveCodeReach([entry], roots(), async () => null)).toEqual(['src/cart.ts']);
  });

  it('a module served by path with a map counts only for functions that map to its source', async () => {
    // Line 0 is the module's own code; lines 1 and 2 are hot-reload code the dev server appends, with no mapping.
    const body = 'export function pay() {}\nfunction $RefreshReg$() {}\nqueueMicrotask(() => {});\n';
    // Segments at columns 0 and 7 of line 0.
    const map = { version: 3, sources: ['Pay.vue'], mappings: 'AAAA,OAAO' };
    const source = `${body}//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
    const entry = (ran: 'own' | 'injected'): JsCoverageEntry => ({
      url: `http://localhost:5173/src/components/Pay.vue?t=${ran}`,
      source,
      functions: [
        { functionName: '', ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] },
        { functionName: 'pay', ranges: [{ startOffset: 7, endOffset: 24, count: ran === 'own' ? 1 : 0 }] },
        { functionName: '$RefreshReg$', ranges: [{ startOffset: 25, endOffset: 52, count: 1 }] },
        { functionName: '', ranges: [{ startOffset: 68, endOffset: 76, count: 1 }] },
      ],
    });
    expect(await resolveCodeReach([entry('injected')], roots(), async () => null)).toEqual([]);
    expect(await resolveCodeReach([entry('own')], roots(), async () => null)).toEqual(['src/components/Pay.vue']);
  });

  it("drops a Vite dev server's base, read from its client's address", async () => {
    const source = 'export function pay() {}\npay();';
    const module = (url: string): JsCoverageEntry => ({
      url,
      source,
      functions: [
        { functionName: '', ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] },
        { functionName: 'pay', ranges: [{ startOffset: 7, endOffset: 24, count: 1 }] },
      ],
    });
    const client: JsCoverageEntry = { url: 'http://localhost:3000/_nuxt/@vite/client', source: '', functions: [] };
    const pay = module('http://localhost:3000/_nuxt/components/Pay.vue?t=2');
    expect(await resolveCodeReach([pay], { roots: [path.join(dir, 'src')], repoRoot: dir }, async () => null)).toEqual(
      [],
    );
    resetCodeReachCaches();
    expect(
      await resolveCodeReach([client, pay], { roots: [path.join(dir, 'src')], repoRoot: dir }, async () => null),
    ).toEqual(['src/components/Pay.vue']);
  });

  it("skips React's replayed server component stacks", async () => {
    const map = { version: 3, sources: ['src/cart.ts'], mappings: 'AAAA' };
    const source = `function a(){}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
    const entry: JsCoverageEntry = {
      url: 'about://React/Server/file:///app/.next/server/chunks/ssr/page.js?0',
      source,
      functions: [{ functionName: 'a', ranges: [{ startOffset: 0, endOffset: 14, count: 1 }] }],
    };
    expect(await resolveCodeReach([entry], roots(), async () => null)).toEqual([]);
  });

  it("resolves Turbopack's [project] sources against the repository root", async () => {
    const map = { version: 3, sources: ['turbopack:///[project]/src/cart.ts'], mappings: 'AAAA' };
    const source = `function a(){}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
    const entry: JsCoverageEntry = {
      url: 'http://localhost:3000/_next/static/chunks/0h7j95za6o12g.js',
      source,
      functions: [{ functionName: 'a', ranges: [{ startOffset: 0, endOffset: 14, count: 1 }] }],
    };
    const app = path.join(dir, 'app');
    expect(await resolveCodeReach([entry], { roots: [app, dir], repoRoot: dir }, async () => null)).toEqual([
      'src/cart.ts',
    ]);
  });

  it('defaults the roots to the config directory, with the repository root last', () => {
    const r = codeReachRoots(dir, null);
    expect(r.roots[0]).toBe(dir);
    expect(r.roots[r.roots.length - 1]).toBe(r.repoRoot);
    expect(codeReachRoots(dir, ['app']).roots).toEqual([path.join(dir, 'app'), r.repoRoot]);
  });

  it('reads directories per origin from an object, `*` for every other origin', () => {
    const r = codeReachRoots(dir, {
      'http://localhost:5281/': 'portals/admin',
      'http://localhost:5284': ['portals/site', 'shared'],
      '*': ['app'],
      'not a url': 'ignored',
    });
    expect(r.roots).toEqual([path.join(dir, 'app'), r.repoRoot]);
    expect([...r.byOrigin!]).toEqual([
      ['http://localhost:5281', [path.join(dir, 'portals/admin')]],
      ['http://localhost:5284', [path.join(dir, 'portals/site'), path.join(dir, 'shared')]],
    ]);
    expect(codeReachRoots(dir, { 'http://localhost:5281': 'portals/admin' }).roots).toEqual([
      ...new Set([dir, r.repoRoot]),
    ]);
  });

  it('resolves a module against the directories of its own origin, else of its page', async () => {
    write('portals/admin/js/index.ts', 'export {};');
    write('portals/site/js/index.ts', 'export {};');
    const source = 'export function go() {}\ngo();';
    const index = (port: number): JsCoverageEntry => ({
      url: `http://localhost:${port}/dist/js/index.ts`,
      source,
      functions: [
        { functionName: '', ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] },
        { functionName: 'go', ranges: [{ startOffset: 7, endOffset: 23, count: 1 }] },
      ],
    });
    const vite = (port: number): JsCoverageEntry => ({
      url: `http://localhost:${port}/dist/@vite/client`,
      functions: [],
    });
    const r = codeReachRoots(dir, {
      'http://localhost:5231': 'portals/admin',
      'http://localhost:5284': 'portals/site',
    });
    // The script's own origin has directories.
    expect(
      await resolveCodeReach([vite(5231), index(5231)], r, async () => null, 'http://localhost:5281/Home'),
    ).toEqual(['portals/admin/js/index.ts']);
    // It has none: its page's origin picks them.
    expect(
      await resolveCodeReach([vite(5234), index(5234)], r, async () => null, 'http://localhost:5284/Home'),
    ).toEqual(['portals/site/js/index.ts']);
    // The page it was parsed on wins over the address the page ends on.
    const parsedOnAdmin = { ...index(5235), pageUrl: 'http://localhost:5231/Home' };
    expect(
      await resolveCodeReach([vite(5235), parsedOnAdmin], r, async () => null, 'http://localhost:5284/Home'),
    ).toEqual(['portals/admin/js/index.ts']);
  });
});

describe('mergeCoverageRead', () => {
  const fn = (functionName: string, startOffset: number, endOffset: number, count: number) => ({
    functionName,
    ranges: [{ startOffset, endOffset, count }],
  });
  const ranOf = (ran: Map<string, RanScript>) =>
    [...ran.values()].map((r) => [r.script.url, r.functions.map((f) => f.functionName)]);

  it('keeps the functions that ran in any read, by script version, in the order of their first read', () => {
    const ran = new Map<string, RanScript>();
    const scripts = new Map<string, ParsedScript>([
      ['1', { url: 'http://a/pay.js', hash: 'p' }],
      ['2', { url: 'http://a/next.js', hash: 'n' }],
    ]);
    mergeCoverageRead(ran, scripts, [{ scriptId: '1', functions: [fn('', 0, 100, 1), fn('pay', 10, 20, 0)] }]);
    mergeCoverageRead(ran, scripts, [
      { scriptId: '1', functions: [fn('pay', 10, 20, 1), fn('idle', 30, 40, 0)] },
      { scriptId: '2', functions: [fn('next', 5, 9, 0)] },
    ]);
    // A script the page did not report, with no URL, is left out.
    mergeCoverageRead(ran, scripts, [
      { scriptId: '1', functions: [fn('pay', 10, 20, 1)] },
      { scriptId: '9', functions: [fn('eval', 0, 4, 1)] },
    ]);
    expect(ranOf(ran)).toEqual([
      ['http://a/pay.js', ['', 'pay']],
      ['http://a/next.js', []],
    ]);
  });

  it('reads a script id against the scripts the page knew as the read was taken', () => {
    // A cross-site navigation starts a renderer that numbers its scripts afresh.
    const ran = new Map<string, RanScript>();
    const scripts = new Map<string, ParsedScript>([['3', { url: 'http://first.test/first.js', hash: 'f' }]]);
    mergeCoverageRead(ran, scripts, [{ scriptId: '3', functions: [fn('first', 2, 9, 1)] }]);
    scripts.set('3', { url: 'http://second.test/second.js', hash: 's' });
    mergeCoverageRead(ran, scripts, [{ scriptId: '3', functions: [fn('second', 2, 7, 1)] }]);
    expect(ranOf(ran)).toEqual([
      ['http://first.test/first.js', ['first']],
      ['http://second.test/second.js', ['second']],
    ]);
  });
});

describe('in Chromium', () => {
  let browser: Browser | null = null;
  let server: http.Server;
  let url = '';

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-reach-live-')));
    write('index.html', '<button id="pay">Pay</button><script type="module" src="/src/main.js"></script>');
    write(
      'src/main.js',
      "import { pay } from './pay.js';\ndocument.querySelector('#pay').addEventListener('click', () => pay());\n",
    );
    write('src/pay.js', "export function pay() {\n  document.body.dataset.paid = 'yes';\n}\n");
    write('src/idle.js', 'export function idle() {}\n');
    // An iframe that leaves its first document for a second one, each running a bundle with an inline source map:
    // a bundle resolves only through its source, which has to be read before its document goes.
    write('frame.html', '<iframe src="/first.html"></iframe>');
    for (const name of ['first', 'second']) {
      write(`${name}.html`, `<button id="go">Go</button><script src="/dist/${name}.js"></script>`);
      const code =
        `function ${name}() {\n  document.body.dataset.done = '${name}';\n}\n` +
        `document.querySelector('#go').addEventListener('click', () => ${name}());\n` +
        `document.body.dataset.ready = '${name}';\n`;
      write(`src/${name}.js`, code);
      // Each generated line maps to the same line of the source.
      const map = { version: 3, sources: [`src/${name}.js`], mappings: 'AAAA;AACA;AACA;AACA;AACA' };
      const inline = Buffer.from(JSON.stringify(map)).toString('base64');
      write(`dist/${name}.js`, `${code}//# sourceMappingURL=data:application/json;base64,${inline}\n`);
    }
    // A page with a same-process iframe, whose module only adds a beforeunload listener of its own.
    write('guarded.html', '<iframe src="/first.html"></iframe><script type="module" src="/src/guard.js"></script>');
    write('src/guard.js', "addEventListener('beforeunload', function guard() {\n  document.title = 'leaving';\n});\n");
    server = http.createServer((req, res) => {
      const file = path.join(dir, (req.url ?? '/').split('?')[0] === '/' ? 'index.html' : req.url!.split('?')[0]!);
      if (!fs.existsSync(file)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      browser = await chromium.launch();
    } catch {
      browser = null;
    }
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records the modules whose functions ran', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await browser.newPage();
    expect(await startCodeReach(page)).toBe(true);
    await page.goto(url);
    await page.click('#pay');
    await page.waitForFunction("document.body.dataset.paid === 'yes'");
    const entries = await stopCodeReach(page);
    await page.close();
    const files = await resolveCodeReach(entries ?? [], { roots: [dir], repoRoot: dir }, async () => null);
    // main.js ran its click handler and pay.js its function; idle.js was never loaded.
    expect(files).toEqual(['src/main.js', 'src/pay.js']);
  });

  /** An iframe that runs its first document, then leaves it for the second; returns what the capture read. */
  async function iframeJourney(): Promise<{ read: string[]; files: string[] }> {
    const page = await browser!.newPage();
    expect(await startCodeReach(page)).toBe(true);
    await page.goto(`${url}frame.html`);
    const frame = page.frameLocator('iframe');
    await frame.locator('body[data-ready="first"] #go').click();
    await frame.locator('body[data-done="first"]').waitFor();
    await page.evaluate("document.querySelector('iframe').src = '/second.html'");
    await frame.locator('body[data-ready="second"] #go').click();
    await frame.locator('body[data-done="second"]').waitFor();
    const entries = (await stopCodeReach(page)) ?? [];
    await page.close();
    return {
      read: entries.filter((entry) => entry.source !== undefined).map((entry) => new URL(entry.url).pathname),
      files: await resolveCodeReach(entries, { roots: [dir], repoRoot: dir }, async () => null),
    };
  }

  it("keeps the files of an iframe's earlier document", async (ctx) => {
    if (!browser) return ctx.skip();
    expect((await iframeJourney()).files).toEqual(['src/first.js', 'src/second.js']);
  });

  it("keeps the files of the page's earlier documents, through a link and a goto", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await browser.newPage();
    expect(await startCodeReach(page)).toBe(true);
    await page.goto(`${url}first.html`);
    await page.click('body[data-ready="first"] #go');
    await page.waitForFunction("document.body.dataset.done === 'first'");
    // The page's own beforeunload listener stops the debugger too, before the mark's.
    await page.evaluate("addEventListener('beforeunload', function appGuard() {})");
    await page.evaluate("location.href = '/second.html'");
    await page.click('body[data-ready="second"] #go');
    await page.waitForFunction("document.body.dataset.done === 'second'");
    await page.goto(url);
    const entries = (await stopCodeReach(page)) ?? [];
    await page.close();
    expect(await resolveCodeReach(entries, { roots: [dir], repoRoot: dir }, async () => null)).toEqual([
      'src/first.js',
      'src/second.js',
    ]);
  });

  it("keeps what the page's own beforeunload listener ran, read at its iframe's mark as the main frame leaves", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await browser.newPage();
    expect(await startCodeReach(page)).toBe(true);
    await page.goto(`${url}guarded.html`);
    await page.frameLocator('iframe').locator('body[data-ready="first"]').waitFor();
    await page.goto(url);
    const entries = (await stopCodeReach(page)) ?? [];
    await page.close();
    expect(await resolveCodeReach(entries, { roots: [dir], repoRoot: dir }, async () => null)).toEqual([
      'src/guard.js',
    ]);
  });

  it('keeps the files of a document left for another site', async (ctx) => {
    if (!browser) return ctx.skip();
    // Two sites served by the same server: the second document may run in a renderer of its own.
    const sites = await chromium.launch({ args: ['--host-resolver-rules=MAP *.test 127.0.0.1'] });
    try {
      const page = await sites.newPage();
      const port = new URL(url).port;
      expect(await startCodeReach(page)).toBe(true);
      await page.goto(`http://first.test:${port}/first.html`);
      await page.click('body[data-ready="first"] #go');
      await page.waitForFunction("document.body.dataset.done === 'first'");
      await page.goto(`http://second.test:${port}/second.html`);
      await page.click('body[data-ready="second"] #go');
      await page.waitForFunction("document.body.dataset.done === 'second'");
      const entries = (await stopCodeReach(page)) ?? [];
      expect(await resolveCodeReach(entries, { roots: [dir], repoRoot: dir }, async () => null)).toEqual([
        'src/first.js',
        'src/second.js',
      ]);
    } finally {
      await sites.close();
    }
  });

  it('covers a page opened before the capture, from its next action on', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await browser.newPage();
    await page.goto(url);
    // Two captures in a row, as two tests sharing the page.
    for (let i = 0; i < 2; i++) {
      expect(await startCodeReach(page)).toBe(true);
      await page.click('#pay');
      await page.waitForFunction("document.body.dataset.paid === 'yes'");
      const files = await resolveCodeReach(
        (await stopCodeReach(page)) ?? [],
        { roots: [dir], repoRoot: dir },
        async () => null,
      );
      expect(files).toEqual(['src/main.js', 'src/pay.js']);
    }
    await page.close();
  });

  it('reads a script once per worker, and resolves it the same in a later test', async (ctx) => {
    if (!browser) return ctx.skip();
    const first = await iframeJourney();
    expect(first.read).toEqual(expect.arrayContaining(['/dist/first.js', '/dist/second.js']));
    expect(first.files).toEqual(['src/first.js', 'src/second.js']);
    expect(await iframeJourney()).toEqual({ read: [], files: ['src/first.js', 'src/second.js'] });
  });
});

describe('on production builds', () => {
  // A Vite and a webpack build of one small application, with source maps: see fixtures/code-reach/README.md.
  const fixture = path.join(import.meta.dirname, 'fixtures', 'code-reach');
  let browser: Browser | null = null;
  let server: http.Server;
  let origin = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const pathname = (req.url ?? '/').split('?')[0]!;
      const file = path.join(fixture, 'build', pathname.endsWith('/') ? `${pathname}index.html` : pathname);
      if (!file.startsWith(path.join(fixture, 'build')) || !fs.existsSync(file)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const type = file.endsWith('.html')
        ? 'text/html'
        : file.endsWith('.map')
          ? 'application/json'
          : 'text/javascript';
      res.setHeader('Content-Type', type);
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      browser = await chromium.launch();
    } catch {
      browser = null;
    }
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function reach(build: 'vite' | 'webpack', click: 'cart' | 'reports' | null): Promise<string[]> {
    const page = await browser!.newPage();
    try {
      expect(await startCodeReach(page)).toBe(true);
      await page.goto(`${origin}/${build}/`);
      await page.waitForSelector('h1');
      if (click) {
        await page.click(`#${click}`);
        await page.waitForSelector(click === 'cart' ? '#total' : '#revenue');
      }
      const entries = await stopCodeReach(page);
      return await resolveCodeReach(entries ?? [], { roots: [fixture], repoRoot: fixture }, pageMapFetcher(page));
    } finally {
      await page.close();
    }
  }

  for (const build of ['vite', 'webpack'] as const) {
    it(`maps each test to the files it ran in a ${build} build`, async (ctx) => {
      if (!browser) return ctx.skip();
      // analytics.js runs only top-level code, and the bundler's own helpers map to no file of their own.
      expect(await reach(build, null)).toEqual(['src/ui/header.js']);
      expect(await reach(build, 'cart')).toEqual([
        'src/main.js',
        'src/ui/cart.js',
        'src/ui/header.js',
        'src/utils/format.js',
      ]);
      expect(await reach(build, 'reports')).toEqual([
        'src/main.js',
        'src/ui/header.js',
        'src/ui/reports.js',
        'src/utils/format.js',
      ]);
    });
  }
});
