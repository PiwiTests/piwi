import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBugArgs, runBug } from '../src/cli/bug.js';
import { runCodegen } from '../src/cli/codegen.js';

const SPEC = {
  code: "import { test, expect } from '@playwright/test';\n\ntest('bug: coupon', async ({ page }) => {\n  test.fail();\n});\n",
  path: 'tests/bugs/coupon.spec.ts',
  warnings: [],
};

describe('parseBugArgs', () => {
  it('reads the id, the flags and the env fallbacks', () => {
    expect(parseBugArgs(['#37', '--write'], { PIWI_DASHBOARD_URL: 'https://dash.example/', PIWI_API_KEY: 'k' })).toEqual({
      id: 37,
      write: true,
      out: null,
      run: true,
      force: false,
      mode: 'commit',
      serverUrl: 'https://dash.example',
      apiKey: 'k',
    });
    expect(parseBugArgs(['37', '--out', 'a.spec.ts', '--no-run', '--run-mode'], { PIWI_DASHBOARD_URL: 'x' })).toMatchObject(
      { write: true, out: 'a.spec.ts', run: false, mode: 'run' },
    );
  });

  it('needs an id and a dashboard', () => {
    expect(() => parseBugArgs([], { PIWI_DASHBOARD_URL: 'x' })).toThrow(/No bug report id/);
    expect(() => parseBugArgs(['abc'], { PIWI_DASHBOARD_URL: 'x' })).toThrow(/No bug report id/);
    expect(() => parseBugArgs(['37'], {})).toThrow(/No dashboard/);
  });
});

describe('runBug', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-bug-'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prints the spec to commit, asked of the dashboard with the key', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(SPEC), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runBug(['37'], { PIWI_DASHBOARD_URL: 'https://dash.example', PIWI_API_KEY: 'k' })).toBe(0);
    expect(write).toHaveBeenCalledWith(SPEC.code);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://dash.example/api/bug-reports/37/spec?mode=commit');
    expect(init.headers).toEqual({ 'X-API-Key': 'k' });
  });

  it('writes it without running it, and keeps an existing file without --force', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(SPEC), { status: 200 })));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = path.join(dir, 'tests', 'bugs', 'coupon.spec.ts');
    const env = { PIWI_DASHBOARD_URL: 'https://dash.example' };
    expect(await runBug(['37', '--out', out, '--no-run'], env)).toBe(0);
    expect(fs.readFileSync(out, 'utf-8')).toBe(SPEC.code);
    fs.writeFileSync(out, 'mine');
    expect(await runBug(['37', '--out', out, '--no-run'], env)).toBe(2);
    expect(fs.readFileSync(out, 'utf-8')).toBe('mine');
  });

  it('--write puts the spec in the bugs folder from the repository root, whatever the working directory', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const web = path.join(dir, 'apps', 'web');
    fs.mkdirSync(web, { recursive: true });
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ...SPEC, path: 'apps/web/tests/bugs/coupon.spec.ts' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runBug(['37', '--write', '--no-run'], { PIWI_DASHBOARD_URL: 'https://dash.example' }, web)).toBe(0);
    expect(fs.readFileSync(path.join(web, 'tests', 'bugs', 'coupon.spec.ts'), 'utf-8')).toBe(SPEC.code);
    expect(fs.existsSync(path.join(web, 'apps'))).toBe(false);
    expect(String(error.mock.calls[error.mock.calls.length - 1]?.[0])).toBe('piwi bug: wrote tests/bugs/coupon.spec.ts');
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://dash.example/api/bug-reports/37/spec?mode=commit',
    );
  });

  it('--out asks for the test import of its own folder, relative to the repository root', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const web = path.join(dir, 'apps', 'web');
    fs.mkdirSync(web, { recursive: true });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(SPEC), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = { PIWI_DASHBOARD_URL: 'https://dash.example' };
    expect(await runBug(['37', '--out', 'e2e/repro/coupon.spec.ts', '--no-run'], env, web)).toBe(0);
    expect(fs.existsSync(path.join(web, 'e2e', 'repro', 'coupon.spec.ts'))).toBe(true);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://dash.example/api/bug-reports/37/spec?mode=commit&specDir=apps%2Fweb%2Fe2e%2Frepro',
    );
  });

  it('--write outside a repository reads the bugs folder from the working directory', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(SPEC), { status: 200 })));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runBug(['37', '--write', '--no-run'], { PIWI_DASHBOARD_URL: 'https://dash.example' }, dir)).toBe(0);
    expect(fs.existsSync(path.join(dir, 'tests', 'bugs', 'coupon.spec.ts'))).toBe(true);
    expect(String(error.mock.calls[0]?.[0])).toContain('not in a git repository');
  });

  it('fails on a report the dashboard does not have', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runBug(['99'], { PIWI_DASHBOARD_URL: 'https://dash.example' })).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain('no bug report #99');
  });
});

describe('codegen bug:<id>', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the steps of a bug report from the dashboard', async () => {
    const report = {
      title: 'Coupon not applied',
      steps: {
        v: 1,
        title: null,
        origin: 'https://staging.acme.test',
        recordedAt: 0,
        note: null,
        steps: [{ action: 'goto', target: null, value: '/cart', redacted: false, pageUrl: '/cart', timestamp: 0 }],
      },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(report), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runCodegen(['bug:12', '--offline'], { PIWI_DASHBOARD_URL: 'https://dash.example' })).toBe(0);
    expect((fetchMock.mock.calls[0] as unknown[] | undefined)?.[0]).toBe('https://dash.example/api/bug-reports/12');
    expect(String(write.mock.calls[0]?.[0])).toContain("test('Coupon not applied'");
    expect(String(write.mock.calls[0]?.[0])).toContain("await page.goto('/cart');");
  });
});
