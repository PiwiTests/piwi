import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocatorIndex } from '@piwitests/core/locator-index';
import { findPlaywrightRoot, parsePreflightArgs, runPreflight } from '../src/cli/preflight.js';
import { spawnPlaywrightForRun } from '../src/cli/select.js';
import type * as SelectModule from '../src/cli/select.js';

vi.mock('../src/cli/select.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SelectModule>()),
  spawnPlaywrightForRun: vi.fn(async () => 0),
}));

const INDEX: LocatorIndex = {
  projectId: 7,
  projectName: 'Acme Mugs',
  branch: null,
  defaultBranch: 'main',
  branches: [],
  builtAt: '2026-09-01T00:00:00Z',
  generatedAt: '2026-09-27T00:00:00Z',
  testIdAttributes: null,
  tests: [
    { id: 1, title: 'pays', file: 'tests/checkout.spec.ts', suite: [], status: 'passed' },
    { id: 2, title: 'pays by card', file: 'tests/checkout.spec.ts', suite: [], status: 'passed' },
    { id: 3, title: 'pays twice', file: 'tests/checkout.spec.ts', suite: [], status: 'flaky' },
    { id: 4, title: 'applies a coupon', file: 'tests/coupon.spec.ts', suite: [], status: 'passed' },
  ],
  locators: [
    {
      locator: "getByRole('button', { name: 'Pay now' })",
      lastSeenAt: '2026-09-26T00:00:00Z',
      uses: [0, 1, 2].map((test) => ({
        test,
        actions: ['click'],
        callSites: ['tests/pages/checkout.page.ts:4:16'],
        projects: ['chromium'],
        branches: ['main'],
      })),
    },
    {
      locator: "getByText('Apply coupon')",
      lastSeenAt: '2026-09-26T00:00:00Z',
      uses: [
        { test: 3, actions: ['click'], callSites: ['tests/coupon.spec.ts:5:20'], projects: [], branches: ['main'] },
      ],
    },
    {
      locator: "getByRole('heading', { name: 'Your cart' })",
      lastSeenAt: '2026-09-26T00:00:00Z',
      uses: [
        {
          test: 3,
          actions: ['expect.toBeVisible'],
          callSites: ['tests/coupon.spec.ts:4:20'],
          projects: [],
          branches: ['main'],
        },
      ],
    },
  ],
  truncated: false,
};

const PAGE_OBJECT = `import type { Page } from '@playwright/test';
export class CheckoutPage {
  constructor(private readonly page: Page) {}
  pay = () => this.page.getByRole('button', { name: "Pay now" });
}
`;

const COUPON_SPEC = `import { test } from '@playwright/test';
test('applies a coupon', async ({ page }) => {
  await page.goto('/cart');
  await page.getByRole('heading', { name: 'Your cart' }).waitFor();
  await page.getByText(LABELS.apply).click();
});
`;

let server: http.Server;
let url = '';
let requests: string[] = [];
let apiKeys: Array<string | undefined> = [];
let impactBodies: Array<{
  changedFiles: string[];
  changes?: Array<{ filePath: string; blob: string; lines: number[][] }>;
}> = [];
let codeIndex: unknown = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    apiKeys.push(req.headers['x-api-key'] as string | undefined);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/projects/menu') {
      res.end(JSON.stringify({ items: [{ id: 7, name: 'Acme Mugs' }] }));
    } else if (req.url?.startsWith('/api/projects/7/code-index') && codeIndex) {
      res.end(JSON.stringify(codeIndex));
    } else if (req.url?.startsWith('/api/projects/7/locator-index')) {
      res.end(JSON.stringify(INDEX));
    } else if (req.url === '/api/projects/7/selections/impact' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => impactBodies.push(JSON.parse(body)));
      res.end(
        JSON.stringify({
          key: 'impact',
          version: null,
          tests: [],
          resolvedHash: 'h',
          estimate: { count: 9, totalDurationMs: null },
          warnings: [],
          materialization: { format: 'args', args: ['tests/checkout.spec.ts:3'], command: '' },
          impact: { changedFiles: 2, mappedFiles: 2, widened: false, unmappedSourceFiles: [] },
        }),
      );
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let dir = '';
let out: string[] = [];
let err: string[] = [];

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' });
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

const ENV = { PIWI_DESKTOP_CONFIG: '/nonexistent/desktop.json' };

function run(...argv: string[]): Promise<number> {
  return runPreflight(['--server-url', url, '--project', 'Acme Mugs', ...argv], ENV, dir);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-preflight-'));
  git('init', '-q', '-b', 'main');
  write('playwright.config.ts', 'export default {};\n');
  write(
    'src/components/CheckoutButton.vue',
    '<template>\n  <button class="pay" @click="pay">\n    Pay now\n  </button>\n</template>\n',
  );
  write('src/locales/en.json', '{\n  "checkout": {\n    "coupon": {\n      "apply": "Apply coupon"\n    }\n  }\n}\n');
  write('tests/pages/checkout.page.ts', PAGE_OBJECT);
  write('tests/coupon.spec.ts', COUPON_SPEC);
  write('tests/labels.ts', "export const LABELS = { apply: 'Apply coupon' };\n");
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  // The change: the button's text renamed, the coupon string renamed in the locale file.
  write(
    'src/components/CheckoutButton.vue',
    '<template>\n  <button class="pay" @click="pay">\n    Pay\n  </button>\n</template>\n',
  );
  write('src/locales/en.json', '{\n  "checkout": {\n    "coupon": {\n      "apply": "Use coupon"\n    }\n  }\n}\n');
  out = [];
  err = [];
  requests = [];
  apiKeys = [];
  impactBodies = [];
  codeIndex = null;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parsePreflightArgs', () => {
  it('reads the flags with their defaults', () => {
    expect(parsePreflightArgs([])).toMatchObject({ base: 'HEAD', branch: null, fix: false, run: false, strict: false });
    const args = parsePreflightArgs([
      '--base',
      '@{upstream}',
      '--branch=develop',
      '--fix',
      '--strict',
      '--',
      '--headed',
    ]);
    expect(args).toMatchObject({
      base: '@{upstream}',
      branch: 'develop',
      fix: true,
      strict: true,
      extra: ['--headed'],
    });
  });

  it('refuses an unknown flag and a flag missing its value', () => {
    expect(() => parsePreflightArgs(['--fixx'])).toThrow(/unknown argument/);
    expect(() => parsePreflightArgs(['--base'])).toThrow(/--base needs a value/);
  });
});

describe('piwi preflight', () => {
  it('finds the Playwright config upward', () => {
    fs.mkdirSync(path.join(dir, 'tests/deep'), { recursive: true });
    expect(findPlaywrightRoot(path.join(dir, 'tests/deep'))).toBe(path.resolve(dir));
    expect(findPlaywrightRoot(os.tmpdir())).toBeNull();
  });

  it('lists the breaks with their tests, call sites and rewrites', async () => {
    expect(await run()).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('piwi preflight · Acme Mugs · main · 3 locators from 4 tests · diff against HEAD');
    expect(text).toContain('2 locators this change breaks');
    expect(text).toContain('src/components/CheckoutButton.vue:3');
    expect(text).toContain('"Pay now" → "Pay"');
    expect(text).toContain("getByRole('button', { name: 'Pay now' })");
    expect(text).toContain('click · 3 tests · likely');
    expect(text).toContain('tests/pages/checkout.page.ts:4');
    expect(text).toContain("→ getByRole('button', { name: 'Pay' })");
    expect(text).toContain('"Apply coupon" → "Use coupon" (key checkout.coupon.apply)');
    expect(text).toContain('edit by hand');
    expect(text).toContain('holds it: tests/labels.ts:1');
    expect(text).toContain('9 tests reach the changed files');
    expect(text).toContain('Apply the 1 rewrite: npx @piwitests/reporter preflight --fix');
    expect(requests).toContain('GET /api/projects/7/locator-index');
    expect(fs.existsSync(path.join(dir, '.piwi', 'locator-index.json'))).toBe(true);
  });

  it('--fix rewrites the literal in the page object and keeps its quotes', async () => {
    expect(await run('--fix')).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'tests/pages/checkout.page.ts'), 'utf-8')).toContain(
      `this.page.getByRole('button', { name: "Pay" })`,
    );
    expect(fs.readFileSync(path.join(dir, 'tests/labels.ts'), 'utf-8')).toContain("'Apply coupon'");
    expect(out.join('\n')).toContain('Edited 1 file:');
  });

  it('--strict exits 1 while a likely break is left unfixed', async () => {
    expect(await run('--strict')).toBe(1);
    // The coupon break needs a hand edit, so --fix alone does not clear --strict.
    expect(await run('--strict', '--fix')).toBe(1);
    // Once the page object holds the new string, the break counts as fixed until the next run updates the index.
    git('checkout', '--', 'src/locales/en.json');
    out = [];
    expect(await run('--strict')).toBe(0);
    expect(out.join('\n')).toContain('already rewritten');
  });

  it('--run runs the tests reaching the change and the specs of the broken locators', async () => {
    const spawn = vi.mocked(spawnPlaywrightForRun);
    spawn.mockClear();
    expect(await run('--run', '--', '--headed')).toBe(0);
    expect(impactBodies[impactBodies.length - 1]!.changedFiles.sort()).toEqual([
      'src/components/CheckoutButton.vue',
      'src/locales/en.json',
      'tests/checkout.spec.ts',
      'tests/coupon.spec.ts',
    ]);
    // Each modified file goes with its base blob and changed base lines, for line-level impact.
    const { changes } = impactBodies[impactBodies.length - 1]!;
    expect(changes?.map((c) => [c.filePath, c.lines])).toEqual([
      ['src/components/CheckoutButton.vue', [[3, 3]]],
      ['src/locales/en.json', [[4, 4]]],
    ]);
    expect(changes?.every((c) => /^[0-9a-f]{40}$/.test(c.blob))).toBe(true);
    expect(spawn).toHaveBeenCalledWith('npx', ['tests/checkout.spec.ts:3', '--headed'], {
      ...ENV,
      PIWI_ORIGIN: 'preflight',
    });
    spawn.mockResolvedValueOnce(1);
    expect(await run('--run')).toBe(1);
  });

  it('with code reach, a break is likely only when one of its tests reaches the changed file', async () => {
    codeIndex = {
      files: ['src/components/CheckoutButton.vue', 'src/other.ts'],
      tests: [INDEX.tests[0], INDEX.tests[3]],
      reach: [
        { file: 0, tests: [0], origin: 'client' },
        { file: 1, tests: [1], origin: 'client' },
      ],
      builtAt: null,
      truncated: false,
    };
    expect(await run('--json')).toBe(0);
    const result = JSON.parse(out.join('\n'));
    const confidence = Object.fromEntries(
      result.breaks.map((b: { locator: string; confidence: string }) => [b.locator, b.confidence]),
    );
    // Test 1 reaches the button's component; the locale file is never executed, so it keeps its confidence.
    expect(confidence).toEqual({
      "getByRole('button', { name: 'Pay now' })": 'likely',
      "getByText('Apply coupon')": 'likely',
    });
    codeIndex = { ...(codeIndex as object), reach: [{ file: 1, tests: [0, 1], origin: 'client' }] };
    out = [];
    await run('--json');
    expect(
      JSON.parse(out.join('\n')).breaks.find((b: { locator: string }) => b.locator.includes('Pay now')).confidence,
    ).toBe('possible');
  });

  it('--fix leaves a possible break alone and lists its rewrite to apply by hand', async () => {
    // No test of the Pay now chain reaches the button's component: the break is only possible.
    codeIndex = {
      files: ['src/other.ts'],
      tests: [INDEX.tests[0]],
      reach: [{ file: 0, tests: [0], origin: 'client' }],
      builtAt: null,
      truncated: false,
    };
    expect(await run('--fix')).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'tests/pages/checkout.page.ts'), 'utf-8')).toBe(PAGE_OBJECT);
    const text = out.join('\n');
    expect(text).toContain('it may break (a bare string matched)');
    expect(text).toContain("if it does, edit by hand: getByRole('button', { name: 'Pay' })");
    expect(text).not.toContain('Edited');
    expect(text).not.toContain('preflight --fix');
  });

  it('--json prints the breaks, the sites and the impact', async () => {
    expect(await run('--json')).toBe(0);
    const result = JSON.parse(out.join('\n'));
    expect(result.breaks).toHaveLength(2);
    expect(result.breaks[0]).toMatchObject({
      locator: "getByRole('button', { name: 'Pay now' })",
      confidence: 'likely',
      rewrite: "getByRole('button', { name: 'Pay' })",
      sites: [{ callSite: 'tests/pages/checkout.page.ts:4:16', action: 'edit' }],
    });
    expect(result.impact).toEqual({ count: 9, widened: false });
  });

  it('says what it checked when the diff breaks nothing', async () => {
    git('checkout', '--', '.');
    write(
      'src/components/CheckoutButton.vue',
      '<template>\n  <button class="pay" @click="pay">\n    Pay now!\n  </button>\n</template>\n',
    );
    expect(await run()).toBe(0);
    expect(out.join('\n')).toContain('No break found in the 1 string this diff changes.');
  });

  it('runs offline on the cached index, and exits 2 with neither', async () => {
    expect(await run()).toBe(0);
    out = [];
    const offline = await runPreflight(['--server-url', 'http://127.0.0.1:9', '--project', 'Acme Mugs'], ENV, dir);
    expect(offline).toBe(2);
    expect(err.join('\n')).toContain('no cached index');
    // The cache is keyed by instance, project and branch.
    fs.writeFileSync(
      path.join(dir, '.piwi', 'locator-index.json'),
      fs.readFileSync(path.join(dir, '.piwi', 'locator-index.json'), 'utf-8').replace(url, 'http://127.0.0.1:9'),
    );
    expect(await runPreflight(['--server-url', 'http://127.0.0.1:9', '--project', 'Acme Mugs'], ENV, dir)).toBe(0);
    expect(err.join('\n')).toContain('using the index cached');
    expect(out.join('\n')).toContain('"Pay now" → "Pay"');
  });

  it('reads the connection from the workspace .env', async () => {
    write('.env', `PIWI_DASHBOARD_URL=${url}\nPIWI_PROJECT_NAME="Acme Mugs"\n`);
    expect(await runPreflight([], ENV, dir)).toBe(0);
    expect(out.join('\n')).toContain('2 locators this change breaks');
  });

  it('never sends the key exported in the environment to a URL the workspace .env names', async () => {
    write('.env', `PIWI_DASHBOARD_URL=${url}\nPIWI_PROJECT_NAME="Acme Mugs"\n`);
    expect(await runPreflight([], { ...ENV, PIWI_API_KEY: 'pd_mine' }, dir)).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    expect(apiKeys.every((key) => key === undefined)).toBe(true);
  });

  it('exits 2 with no dashboard and outside a repository', async () => {
    expect(await runPreflight([], ENV, dir)).toBe(2);
    expect(err.join('\n')).toContain('no dashboard URL');
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-nogit-'));
    try {
      expect(await runPreflight([], ENV, bare)).toBe(2);
      expect(err.join('\n')).toContain('not inside a git repository');
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
