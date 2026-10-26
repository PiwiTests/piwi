import { createServer, IncomingMessage, ServerResponse, type Server } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Socket, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rollup/parseAst';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, eventHandler, toNodeListener } from 'h3';
import { coveragePluginSource, instrument, instrumentable } from '../src/coverage-transform';
import { enableCoverage, resetCoverageForTests } from '../src/coverage-runtime';
import { requestScope } from '../src/request-scope';

const here = fileURLToPath(new URL('.', import.meta.url));
const runtime = join(here, '../src/coverage-runtime.ts');
const tmp = join(here, '.coverage-tmp');

let written = 0;

/** Instrument `source` as the file `path` (lines kept as they are), write it and import it. */
async function load<T>(path: string, source: string): Promise<{ module: T; table: ReturnType<typeof instrument>['file'] }> {
  const result = instrument(source, parseAst(source) as never, {
    fileId: path,
    runtime,
    path,
    checksums: ['sha256:00'],
    originalLine: (line) => line,
  });
  mkdirSync(tmp, { recursive: true });
  const file = join(tmp, `module-${++written}.mjs`);
  writeFileSync(file, result.code);
  return { module: (await import(file)) as T, table: result.file };
}

/** Hand the runtime the span table of the given files, as the generated plugin does. */
function enable(files: Record<string, ReturnType<typeof instrument>['file']>): void {
  enableCoverage(JSON.stringify({ v: 1, files }));
}

/** A plugin installed on an h3 app, as Nitro does, in a fresh module graph. */
async function installPlugin(app: ReturnType<typeof createApp>) {
  const plugin = await import('../src/index');
  plugin.default({ h3App: app, hooks: { hook: () => {} } } as never);
}

async function withServer(app: ReturnType<typeof createApp>, fn: (base: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(toNodeListener(app));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function collect(base: string, groups: Array<{ key: string; requests: string[] }>, granularity = 'lines') {
  const res = await fetch(`${base}/__piwi/coverage/collect`, { method: 'POST', body: JSON.stringify({ granularity, groups }) });
  return { status: res.status, body: (await res.json()) as any };
}

beforeEach(() => {
  vi.resetModules();
  resetCoverageForTests();
  vi.stubEnv('NODE_ENV', 'test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('the coverage transform', () => {
  it('counts the statements Istanbul counts, at their first line, and each function from its first to its last line', () => {
    const source = [
      '"use strict";', //                            1
      "import { x } from './x';", //                 2
      'let a = 1, b;', //                            3
      'export const twice = (n) => n * 2;', //       4
      'export function quote(items) {', //           5
      '  let total = 0;', //                         6
      '  for (const item of items)', //              7
      '    total += twice(item);', //                8
      '  return total;', //                          9
      '}', //                                        10
      'const o = { get v() { return 1; } };', //     11
    ].join('\n');
    const { file } = instrument(source, parseAst(source) as never, {
      fileId: 'f',
      runtime: 'rt',
      path: 'a.ts',
      checksums: [],
      originalLine: (line) => line,
    });
    // The top level (function 0): `let a = 1` and `const o = …`; `b` has no initializer, the import is no statement.
    expect(file.s[0]).toEqual([0, 3, 4, 11]);
    expect(file.f).toEqual([null, [4, 4], [5, 10], [11, 11]]);
    expect(file.s[1]).toEqual([0, 4]);
    expect(file.s[2]).toEqual([0, 6, 7, 8, 9]);
    expect(file.s[3]).toEqual([0, 11]);
  });

  it('keeps the code working: directives, a statement as another body, labels, switch cases, classes, generators', async () => {
    const { module } = await load<{ run: () => unknown[] }>(
      'kept.js',
      [
        '"use strict";',
        'export function run() {',
        '  "use strict";',
        '  const out = [];',
        '  if (out.length) out.push(0)',
        '  else out.push(1)',
        '  outer: for (let i = 0; i < 2; i++) { for (;;) { out.push(i); continue outer; } }',
        '  switch (out.length) { case 3: out.push(3); break; default: out.push(-1) }',
        '  class Base { constructor(v) { this.v = v } }',
        '  class Derived extends Base { w = 5; static s = 6; constructor() { super(2); } get twice() { return this.v * 2 } }',
        '  const d = new Derived();',
        '  out.push(d.twice, d.w, Derived.s);',
        '  function* gen() { yield 7; }',
        '  out.push(...gen());',
        '  const make = () => ({ k: 8 });',
        '  out.push(make().k, ((x) => (y) => x + y)(4)(5));',
        '  while (false) out.push(0);',
        '  try { throw new Error("x") } catch { out.push(10) } finally { out.push(11) }',
        '  return out',
        '}',
      ].join('\n'),
    );
    expect(module.run()).toEqual([1, 0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('keeps the declarations of a block in its scope: bare blocks and case blocks are lists, not statements to wrap', async () => {
    const { module } = await load<{ run: (x?: number) => unknown[] }>(
      'blocks.js',
      [
        'export function run(x) {',
        '  const out = [];',
        '  { const a = 1; function g() { return a } out.push(g()) }',
        '  let y = 1;',
        '  switch (x ?? 1) { case 1: { let y = 2; out.push(y) } }',
        '  switch (x ?? 1) { case 1: { const v = 10; out.push(v + 1); break } }',
        '  out.push(y);',
        '  return out',
        '}',
      ].join('\n'),
    );
    expect(module.run()).toEqual([1, 2, 11, 1]);
  });

  it('finds the arrow after its parameters and outside comments', async () => {
    const { module } = await load<{ names: (rows: Array<{ name: string }>) => string[]; one: () => number }>(
      'arrows.js',
      [
        'export const names = (rows) => rows.map((r) => /* id => name */ r.name);',
        'export const one = (f = (a) => a) => // returns => 1',
        '  f(1);',
      ].join('\n'),
    );
    expect(module.names([{ name: 'a' }, { name: 'b' }])).toEqual(['a', 'b']);
    expect(module.one()).toBe(1);
  });

  it('keeps a directive without its semicolon, and names the application uses itself', async () => {
    const { module } = await load<{ strict: () => boolean; clash: (__p: number, __pm: number) => number }>(
      'directives.mjs',
      [
        '"use strict"',
        'export function strict() {',
        '  "use strict"',
        '  return this === undefined',
        '}',
        'export function clash(__p, __pm) { const __pt = 1; return __p + __pm + __pt }',
        'function __pmi() { return 0 }',
      ].join('\n'),
    );
    expect(module.strict.call(undefined)).toBe(true);
    expect(module.clash(1, 2)).toBe(4);
  });

  it('instruments application code only: under the root, outside node_modules, generated output and the package', () => {
    const options = { root: '/repo', runtime: 'rt', exclude: ['/repo/integrations/nitro'] };
    expect(instrumentable('/repo/server/api/orders.post.ts', options)).toBe(true);
    expect(instrumentable('/repo/node_modules/h3/dist/index.mjs', options)).toBe(false);
    expect(instrumentable('/repo/.nitro/dev/index.mjs', options)).toBe(false);
    expect(instrumentable('/repo/integrations/nitro/src/index.ts', options)).toBe(false);
    expect(instrumentable('/elsewhere/a.ts', options)).toBe(false);
    expect(instrumentable('\0virtual:nitro', options)).toBe(false);
    expect(instrumentable('/repo/app.vue?vue&type=style', options)).toBe(false);
    expect(instrumentable('/repo/types.d.ts', options)).toBe(false);
  });

  it('generates the plugin that hands the span table to the runtime', () => {
    const source = coveragePluginSource('/x/coverage-runtime.js');
    expect(source).toContain('import { enableCoverage } from "/x/coverage-runtime.js"');
    expect(source).toContain('enableCoverage("__PIWI_COVERAGE_TABLE__")');
  });
});

describe('attribution', () => {
  const service = [
    'export async function price(n) {', //           1
    '  await new Promise((r) => setTimeout(r, n));', // 2
    '  return n * 2;', //                             3
    '}', //                                           4
    'export function refund() {', //                  5
    '  return -1;', //                                6
    '}', //                                           7
  ].join('\n');

  it('records each request apart, across awaits, and what runs outside a request at run level', async () => {
    const { module, table } = await load<{ price: (n: number) => Promise<number>; refund: () => number }>('svc.js', service);
    enable({ 'svc.js': table });
    const { beginRequestCoverage } = await import('../src/coverage-runtime');
    const first = beginRequestCoverage()!;
    const second = beginRequestCoverage()!;
    await Promise.all([
      requestScope.run({ coverage: first }, () => module.price(5)),
      requestScope.run({ coverage: second }, async () => {
        await module.price(1);
        module.refund();
      }),
    ]);
    module.refund();
    // Function 1 is price, 2 the promise's executor inside it, 3 refund: each request holds only what it ran.
    const { runCoverage } = await import('../src/coverage-runtime');
    expect(first.p[0]?.[1]).toEqual(new Uint8Array([1, 1, 1]));
    expect(first.p[0]?.[2]).toEqual(new Uint8Array([1, 1]));
    expect(first.p[0]?.[3]).toBeUndefined();
    expect(second.p[0]?.[3]).toEqual(new Uint8Array([1, 1]));
    // The call outside any request went to the run level, which nothing else has reached yet.
    const run = runCoverage('functions') as { files: Array<{ functions: number[][] }> };
    expect(run.files[0].functions).toEqual([[5, 7]]);
  });
});

describe('the recorder', () => {
  const late = [
    'export async function work(gate) {', // 1
    '  await gate;', //                      2
    '  return 7;', //                        3
    '}', //                                  4
    'export function more() {', //           5
    '  return 8;', //                        6
    '}', //                                  7
  ].join('\n');

  it('keeps at run level what a request still runs once collected', async () => {
    const { module, table } = await load<{ work: (gate: Promise<void>) => Promise<number> }>('late.js', late);
    enable({ 'late.js': table });
    const runtime = await import('../src/coverage-runtime');
    const coverage = runtime.beginRequestCoverage()!;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const pending = requestScope.run({ coverage }, () => module.work(gate));
    const id = runtime.nameRequest(coverage)!;
    runtime.collectCoverage({ granularity: 'lines', groups: [{ key: 't', requests: [id] }] });
    open();
    await pending;
    const run = runtime.runCoverage('lines') as { files: Array<{ lines: number[][] }> };
    expect(run.files[0].lines).toEqual([[2, 3]]);
  });

  it('counts what a named request records afterwards toward the kept bytes, and gives them back once collected', async () => {
    const { module, table } = await load<{ work: (gate: Promise<void>) => Promise<number>; more: () => number }>(
      'bytes.js',
      late,
    );
    enable({ 'bytes.js': table });
    const runtime = await import('../src/coverage-runtime');
    const state = () => (globalThis as Record<symbol, { keptBytes: number }>)[Symbol.for('piwitests.coverage')];
    const coverage = runtime.beginRequestCoverage()!;
    await requestScope.run({ coverage }, () => module.work(Promise.resolve()));
    const id = runtime.nameRequest(coverage)!;
    const named = state().keptBytes;
    requestScope.run({ coverage }, () => module.more());
    expect(state().keptBytes).toBeGreaterThan(named);
    runtime.collectCoverage({ granularity: 'files', groups: [{ key: 't', requests: [id] }] });
    expect(state().keptBytes).toBe(0);
  });
});

describe('the plugin, in a coverage build', () => {
  const handlers = [
    'export function orders(n) {', //    1
    '  if (n > 1) return n;', //          2
    '  return 0;', //                     3
    '}', //                               4
    'export function items() {', //       5
    '  return [1, 2];', //                6
    '}', //                               7
  ].join('\n');

  async function app() {
    const { module, table } = await load<{ orders: (n: number) => number; items: () => number[] }>(
      'routes.js',
      handlers,
    );
    const { module: other, table: otherTable } = await load<{ never: () => number }>(
      'never.js',
      'export function never() {\n  return 1;\n}\n',
    );
    void other;
    enable({ 'routes.js': table, 'never.js': otherTable });
    const h3 = createApp();
    h3.use(
      '/api/orders',
      eventHandler(async () => {
        await new Promise((r) => setTimeout(r, 2));
        return { n: module.orders(2) };
      }),
    );
    h3.use('/api/items', eventHandler(() => module.items()));
    h3.use('/static', eventHandler(() => 'static'));
    h3.use(
      '/api/page',
      eventHandler(async () => {
        // A request the server makes to itself, as Nitro's localFetch during server-side rendering.
        const req = new IncomingMessage(new Socket());
        req.url = '/api/items';
        req.method = 'GET';
        await toNodeListener(h3)(req, new ServerResponse(req));
        return 'page';
      }),
    );
    await installPlugin(h3);
    return h3;
  }

  it('names a request that ran instrumented code, and only those', async () => {
    await withServer(await app(), async (base) => {
      const orders = await fetch(`${base}/api/orders`);
      expect(orders.headers.get('x-piwi-coverage')).toMatch(/^[0-9a-f]{12}\.\d+\.[0-9a-f]{32}$/);
      const plain = await fetch(`${base}/static`);
      expect(plain.headers.get('x-piwi-coverage')).toBeNull();
    });
  });

  it('answers each group with its requests merged, then forgets them', async () => {
    await withServer(await app(), async (base) => {
      const orders = (await fetch(`${base}/api/orders`)).headers.get('x-piwi-coverage')!;
      const items = (await fetch(`${base}/api/items`)).headers.get('x-piwi-coverage')!;
      const { status, body } = await collect(base, [
        { key: 'a', requests: [orders] },
        { key: 'b', requests: [items, 'nope.1.2'] },
      ]);
      expect(status).toBe(200);
      expect(body.v).toBe(1);
      expect(body.instance.id).toBe(orders.split('.')[0]);
      expect(body.groups[0]).toEqual({
        key: 'a',
        files: [{ path: 'routes.js', runtime: 'server', functions: [[1, 4]], lines: [[2, 2]], checksums: ['sha256:00'] }],
        missing: [],
      });
      expect(body.groups[1].files).toEqual([
        { path: 'routes.js', runtime: 'server', functions: [[5, 7]], lines: [[6, 6]], checksums: ['sha256:00'] },
      ]);
      expect(body.groups[1].missing).toEqual(['nope.1.2']);
      const again = await collect(base, [{ key: 'a', requests: [orders] }], 'files');
      expect(again.body.groups[0]).toEqual({ key: 'a', files: [], missing: [orders] });
    });
  });

  it('records a request the server makes to itself into the outer request', async () => {
    await withServer(await app(), async (base) => {
      const id = (await fetch(`${base}/api/page`)).headers.get('x-piwi-coverage')!;
      const { body } = await collect(base, [{ key: 'page', requests: [id] }], 'functions');
      expect(body.groups[0].files).toEqual([
        { path: 'routes.js', runtime: 'server', functions: [[5, 7]], checksums: ['sha256:00'] },
      ]);
    });
  });

  it('keeps concurrent requests apart', async () => {
    await withServer(await app(), async (base) => {
      const calls = Array.from({ length: 40 }, (_, i) => (i % 2 ? 'orders' : 'items'));
      const ids = await Promise.all(
        calls.map(async (route) => [route, (await fetch(`${base}/api/${route}`)).headers.get('x-piwi-coverage')!] as const),
      );
      const { body } = await collect(
        base,
        ids.map(([route, id], i) => ({ key: `${route}-${i}`, requests: [id] })),
        'functions',
      );
      for (const group of body.groups) {
        const expected = group.key.startsWith('orders') ? [[1, 4]] : [[5, 7]];
        expect(group.files).toEqual([{ path: 'routes.js', runtime: 'server', functions: expected, checksums: ['sha256:00'] }]);
      }
    });
  });

  it('answers the run level with every file of the span table, its executable lines and functions', async () => {
    await withServer(await app(), async (base) => {
      await fetch(`${base}/api/orders`);
      const run = (await (await fetch(`${base}/__piwi/coverage/run?granularity=lines`)).json()) as any;
      expect(run.files).toEqual([
        {
          path: 'never.js',
          runtime: 'server',
          functions: [],
          lines: [],
          checksums: ['sha256:00'],
          executable: [[2, 2]],
          allFunctions: [[1, 3]],
        },
        {
          path: 'routes.js',
          runtime: 'server',
          functions: [[1, 4]],
          lines: [[2, 2]],
          checksums: ['sha256:00'],
          executable: [[2, 3], [6, 6]],
          allFunctions: [[1, 4], [5, 7]],
        },
      ]);
    });
  });

  it('refuses a body that is not a collection', async () => {
    await withServer(await app(), async (base) => {
      const res = await fetch(`${base}/__piwi/coverage/collect`, { method: 'POST', body: '{}' });
      expect(res.status).toBe(400);
      const get = await fetch(`${base}/__piwi/coverage/collect`);
      expect(get.status).toBe(405);
    });
  });
});

describe('the guard', () => {
  it('refuses to start a coverage build in production, unless coverage is explicitly served there', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => enableCoverage('{}')).toThrow(/refusing to start in production/);
    vi.stubEnv('PIWI_TEST_LOGS_DISABLED', 'false');
    expect(() => enableCoverage('{}')).not.toThrow();
  });

  it('warns in another environment it serves no coverage in', () => {
    vi.stubEnv('NODE_ENV', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enableCoverage('{}');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('serves no coverage'));
    warn.mockRestore();
  });
});
