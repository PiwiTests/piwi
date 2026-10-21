// The fixture project and the stub Piwi instance the editor clients capture their illustrations against: a small
// shop's Playwright suite with one brittle locator in a page object, the latest CI run failing on it and on a coupon
// assertion, a local run since that fixed a third test, a flaky catalog test, and a service the tests reach.
// `apps/vscode/scripts/take-screenshots.mjs` and `apps/jetbrains/scripts/take-screenshots.mjs` share it.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

export const PROJECT = { id: 7, name: 'Acme Mugs' };
export const PAGE_OBJECT_FILE = 'tests/pages/checkout.page.ts';
export const SPEC_FILE = 'tests/checkout.spec.ts';
/** The line of the page object the latest run failed at. */
export const FAILING_LINE = 15;

// ── The fixture project ─────────────────────────────────────────────────────

const PAGE_OBJECT = `import type { Page } from '@playwright/test';

export class CheckoutPage {
  constructor(private readonly page: Page) {}

  readonly heading = () => this.page.getByRole('heading', { name: 'Your cart' });
  readonly total = () => this.page.getByTestId('order-total');

  async applyCoupon(code: string) {
    await this.page.getByLabel('Coupon code').fill(code);
    await this.page.getByRole('button', { name: 'Apply' }).click();
  }

  async placeOrder() {
    await this.page.locator('.btn-primary').nth(1).click();
  }
}
`;

const CHECKOUT_SPEC = `import { test, expect } from './fixtures';
import { CheckoutPage } from './pages/checkout.page';

test.describe('checkout', () => {
  test('pays by card', async ({ page, cart }) => {
    await cart.add('Blue mug');
    await page.getByRole('button', { name: 'Checkout' }).click();
    const checkout = new CheckoutPage(page);
    await expect(checkout.heading()).toBeVisible();
    await checkout.placeOrder();
    await expect(page.getByRole('heading', { name: 'Thanks for your order' })).toBeVisible();
  });

  test('applies a coupon', async ({ page, cart }) => {
    await cart.add('Blue mug');
    await page.getByRole('button', { name: 'Checkout' }).click();
    const checkout = new CheckoutPage(page);
    await checkout.applyCoupon('MORNING10');
    await expect(checkout.total()).toHaveText('10.80 €');
  });

  test('removes a row', async ({ page, cart }) => {
    await cart.add('Blue mug');
    await cart.add('Red mug');
    await page.getByRole('button', { name: 'Checkout' }).click();
    await page.getByRole('row', { name: /Red mug/ }).getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('row')).toHaveCount(2);
  });
});
`;

const CATALOG_SPEC = `import { test, expect } from './fixtures';

test.describe('catalog', () => {
  test('adds a mug to the cart', async ({ page }) => {
    await page.goto('/');
    await page
      .getByTestId('product-card')
      .filter({ hasText: 'Blue mug' })
      .getByRole('button', { name: 'Add to cart' })
      .click();
    await expect(page.getByRole('button', { name: /Cart, \\d+ items?/ })).toBeVisible();
  });

  test('filters in-stock products', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('In stock').check();
    await page.getByRole('combobox', { name: 'Sort by' }).selectOption('Price');
    await expect(page.getByRole('button', { name: 'Add to cart' })).toHaveCount(3);
  });
});
`;

const SEARCH_SPEC = `import { test, expect } from './fixtures';

test('finds a product by name', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('Search products').fill('travel');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('heading', { name: 'Travel mug' })).toBeVisible();
});
`;

const PRIVACY_SPEC = `import { test, expect } from './fixtures';

test('accepts the cookie banner', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('dialog', { name: 'We use cookies' }).getByRole('button', { name: 'Accept all' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
});
`;

const FIXTURES = `import { test as base, expect } from '@playwright/test';
import { piwiFixtures } from '@piwitests/reporter';

export const test = base.extend(piwiFixtures).extend<{ cart: { add(name: string): Promise<void> } }>({
  cart: async ({ page }, use) => {
    await page.goto('/');
    await use({
      async add(name) {
        await page.getByTestId('product-card').filter({ hasText: name }).getByRole('button', { name: 'Add to cart' }).click();
      },
    });
  },
});
export { expect };
`;

const SERVICE = `import type { Cart, Coupon } from './types';

export function addItem(cart: Cart, sku: string, quantity = 1): Cart {
  const line = cart.lines.find((l) => l.sku === sku);
  if (line) line.quantity += quantity;
  else cart.lines.push({ sku, quantity });
  return cart;
}

export function applyCoupon(cart: Cart, coupon: Coupon): Cart {
  if (coupon.expiresAt < Date.now()) throw new Error('This coupon has expired');
  cart.discount = Math.round(subtotal(cart) * coupon.rate);
  return cart;
}

export function subtotal(cart: Cart): number {
  return cart.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
}
`;

const PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test';
import { wrapConfig } from '@piwitests/reporter';

export default wrapConfig(
  defineConfig({
    testDir: 'tests',
    use: { baseURL: 'http://localhost:4200' },
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  }),
  { projectName: 'Acme Mugs' },
);
`;

/** Enough of the two packages' types for the editor's TypeScript to report nothing of its own. */
const TYPE_STUBS = {
  'node_modules/@playwright/test/package.json': JSON.stringify({
    name: '@playwright/test',
    version: '1.63.0',
    types: 'index.d.ts',
  }),
  'node_modules/@playwright/test/index.d.ts': `export interface Page { [key: string]: any }
export interface Locator { [key: string]: any }
export declare const test: any;
export declare const expect: any;
export declare function defineConfig(config: any): any;
`,
  'node_modules/@piwitests/reporter/package.json': JSON.stringify({
    name: '@piwitests/reporter',
    version: '0.56.0',
    types: 'index.d.ts',
  }),
  'node_modules/@piwitests/reporter/index.d.ts': `export declare const piwiFixtures: any;
export declare function wrapConfig(config: any, options: any): any;
`,
};

export const FILES = {
  'playwright.config.ts': PLAYWRIGHT_CONFIG,
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: false, noEmit: true },
      include: ['tests', 'src', 'playwright.config.ts'],
    },
    null,
    2,
  ),
  'package.json': JSON.stringify(
    {
      name: 'acme-mugs',
      private: true,
      devDependencies: { '@playwright/test': '^1.63.0', '@piwitests/reporter': '*' },
    },
    null,
    2,
  ),
  '.gitignore': 'node_modules\n',
  'tests/fixtures.ts': FIXTURES,
  [PAGE_OBJECT_FILE]: PAGE_OBJECT,
  [SPEC_FILE]: CHECKOUT_SPEC,
  'tests/catalog.spec.ts': CATALOG_SPEC,
  'tests/search.spec.ts': SEARCH_SPEC,
  'tests/privacy.spec.ts': PRIVACY_SPEC,
  'src/cart/cart-service.ts': SERVICE,
  ...TYPE_STUBS,
};

/**
 * Writes the project as `acme-mugs` under `parent` and commits it, so the run's commit names files the editor can
 * read. Returns the project's path and that commit.
 */
export function writeWorkspace(parent) {
  const workspace = path.join(parent, 'acme-mugs');
  for (const [file, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    fs.writeFileSync(path.join(workspace, file), text);
  }
  const git = (...a) =>
    execFileSync('git', ['-c', 'user.email=dev@acme.test', '-c', 'user.name=Acme', ...a], {
      cwd: workspace,
      encoding: 'utf-8',
    });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'checkout: coupons');
  return { workspace, commit: git('rev-parse', 'HEAD').trim() };
}

// ── The stub instance ───────────────────────────────────────────────────────

const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();

const test = (id, title, file, suite, status) => ({ id, title, file, suite, status });
const TESTS = [
  test(1, 'finds a product by name', 'tests/search.spec.ts', [], 'passed'),
  test(2, 'adds a mug to the cart', 'tests/catalog.spec.ts', ['catalog'], 'passed'),
  test(3, 'filters in-stock products', 'tests/catalog.spec.ts', ['catalog'], 'flaky'),
  test(4, 'pays by card', SPEC_FILE, ['checkout'], 'failed'),
  test(5, 'applies a coupon', SPEC_FILE, ['checkout'], 'failed'),
  test(6, 'removes a row', SPEC_FILE, ['checkout'], 'passed'),
  test(7, 'accepts the cookie banner', 'tests/privacy.spec.ts', [], 'passed'),
];
const use = (t, actions, ...callSites) => ({
  test: t,
  actions,
  callSites,
  projects: ['chromium'],
  branches: ['main'],
  pages: callSites.map(() => [0, true]),
});
const entry = (locator, ...uses) => ({ locator, lastSeenAt: ago(130), uses });
const INDEX = {
  projectId: PROJECT.id,
  projectName: PROJECT.name,
  branch: null,
  defaultBranch: 'main',
  branches: [{ name: 'main', lastSeenAt: ago(130), tests: TESTS.length }],
  builtAt: ago(130),
  generatedAt: ago(1),
  testIdAttributes: ['data-testid'],
  pages: ['/checkout', '/'],
  tests: TESTS,
  locators: [
    entry(
      "getByRole('button', { name: 'Checkout' })",
      use(3, ['click'], `${SPEC_FILE}:7:16`),
      use(4, ['click'], `${SPEC_FILE}:16:16`),
      use(5, ['click'], `${SPEC_FILE}:25:16`),
    ),
    entry(
      "locator('.btn-primary').nth(1)",
      use(3, ['click'], `${PAGE_OBJECT_FILE}:${FAILING_LINE}:21`),
      use(4, ['click'], `${PAGE_OBJECT_FILE}:${FAILING_LINE}:21`),
    ),
    entry("getByRole('heading', { name: 'Your cart' })", use(3, ['expect.toBeVisible'], `${PAGE_OBJECT_FILE}:6:40`)),
    entry("getByTestId('order-total')", use(4, ['expect.toHaveText'], `${PAGE_OBJECT_FILE}:7:38`)),
    entry("getByLabel('Coupon code')", use(4, ['fill'], `${PAGE_OBJECT_FILE}:10:21`)),
    entry("getByRole('button', { name: 'Apply' })", use(4, ['click'], `${PAGE_OBJECT_FILE}:11:21`)),
    entry(
      "getByRole('row', { name: /Red mug/ }).getByRole('button', { name: 'Remove' })",
      use(5, ['click'], `${SPEC_FILE}:26:16`),
    ),
    entry("getByRole('row')", use(5, ['expect.toHaveCount'], `${SPEC_FILE}:27:23`)),
    entry(
      "getByTestId('product-card').filter({ hasText: 'Blue mug' }).getByRole('button', { name: 'Add to cart' })",
      use(1, ['click'], 'tests/catalog.spec.ts:6:12'),
    ),
    entry(
      "getByRole('button', { name: /Cart, \\d+ items?/ })",
      use(1, ['expect.toBeVisible'], 'tests/catalog.spec.ts:11:23'),
    ),
    entry("getByLabel('In stock')", use(2, ['check'], 'tests/catalog.spec.ts:16:16')),
    entry("getByRole('combobox', { name: 'Sort by' })", use(2, ['selectOption'], 'tests/catalog.spec.ts:17:16')),
    entry(
      "getByRole('button', { name: 'Add to cart' })",
      use(2, ['expect.toHaveCount'], 'tests/catalog.spec.ts:18:23'),
    ),
    entry("getByPlaceholder('Search products')", use(0, ['fill'], 'tests/search.spec.ts:5:14')),
    entry("getByRole('button', { name: 'Search' })", use(0, ['click'], 'tests/search.spec.ts:6:14')),
    entry("getByRole('heading', { name: 'Travel mug' })", use(0, ['expect.toBeVisible'], 'tests/search.spec.ts:7:21')),
    entry(
      "getByRole('dialog', { name: 'We use cookies' }).getByRole('button', { name: 'Accept all' })",
      use(6, ['click'], 'tests/privacy.spec.ts:5:14'),
    ),
  ],
  truncated: false,
};

export const RECOMMENDED = "getByRole('button', { name: 'Place order' })";
const ranked = (locator, method, score) => ({ locator, method, args: {}, score });
const ALTERNATIVES = [
  ranked(RECOMMENDED, 'getByRole', 92),
  ranked("getByText('Place order')", 'getByText', 61),
  ranked("locator('form.checkout button[type=submit]')", 'locator', 38),
];

const OLD_LINE = "    await this.page.locator('.btn-primary').nth(1).click();";
const NEW_LINE = `    await this.page.${RECOMMENDED}.click();`;
const HEADLINE = "locator('.btn-primary').nth(1) was not found";
const CI_CHECKOUT = '/home/runner/work/acme-mugs/acme-mugs';

const failure = (executionId, testCaseId, title, line, duration, detail) => ({
  executionId,
  testCaseId,
  title,
  file: SPEC_FILE,
  line,
  status: 'failed',
  traces: [`traces/${executionId}.zip`],
  screenshot: `screenshots/${executionId}.png`,
  source: 'baseline',
  runId: 124,
  browserName: 'chromium',
  duration,
  isNew: true,
  owner: '@acme/checkout',
  ...detail,
});

/** The run's two failures: the brittle locator in the page object, and a coupon that leaves the total unchanged. */
const RUN_FAILURES = [
  failure(900, 4, 'pays by card', 5, 31_200, {
    clusterId: 3,
    clusterTitle: 'Place order button not found',
    headline: HEADLINE,
    location: `${CI_CHECKOUT}/${PAGE_OBJECT_FILE}:${FAILING_LINE}:21`,
    message: `TimeoutError: locator.click: Timeout 15000ms exceeded.\nCall log:\n  - waiting for locator('.btn-primary').nth(1)\n`,
    frames: [`${PAGE_OBJECT_FILE}:${FAILING_LINE}:46`, `${SPEC_FILE}:10:20`],
  }),
  failure(901, 5, 'applies a coupon', 14, 4_800, {
    clusterId: 4,
    clusterTitle: 'Coupon leaves the total unchanged',
    headline: 'toHaveText: expected "10.80 €", received "12.00 €"',
    location: `${CI_CHECKOUT}/${SPEC_FILE}:19:36`,
    message: `Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId('order-total')\nExpected string: "10.80 €"\nReceived string: "12.00 €"\nTimeout: 5000ms\n`,
    frames: [`${SPEC_FILE}:19:36`],
  }),
];

/** The failures of run #124 as they stand after run #125, which this editor started and which passed one of them. */
const branchFailures = (commit) => ({
  run: {
    id: 124,
    status: 'failed',
    branch: 'main',
    startTime: ago(130),
    origin: 'ci',
    commit,
    totalTests: 7,
    passedTests: 3,
    failedTests: 3,
    flakyTests: 1,
    skippedTests: 0,
  },
  overlays: [
    {
      id: 125,
      status: 'passed',
      origin: 'editor',
      isFullRun: false,
      startTime: ago(12),
      commit,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      flakyTests: 0,
      skippedTests: 0,
    },
  ],
  failures: RUN_FAILURES,
  resolved: [
    {
      testCaseId: 6,
      title: 'removes a row',
      file: SPEC_FILE,
      line: 22,
      browserName: 'chromium',
      runId: 125,
      executionId: 910,
      baselineExecutionId: 902,
    },
  ],
});

const HEALING = {
  applicable: true,
  reason: null,
  failingLocator: { method: 'locator', args: { selector: '.btn-primary' } },
  fromPriorSuccess: ALTERNATIVES,
  fromElementMatch: null,
  fromAriaSnapshot: null,
  source: 'prior-run',
  recommendation: {
    recommended: ALTERNATIVES[0],
    reason: 'A role and a name survive a restyle; the class and the position did not.',
  },
  capturedAt: ago(1500),
  location: `${PAGE_OBJECT_FILE}:${FAILING_LINE}:21`,
  sourceLine: { line: FAILING_LINE, text: OLD_LINE },
  healedInRunId: null,
  edit: { filePath: PAGE_OBJECT_FILE, line: FAILING_LINE, oldLine: OLD_LINE, newLine: NEW_LINE, unifiedDiff: null },
};

const CASES = TESTS.map((t) => ({
  id: t.id,
  title: t.title,
  filePath: t.file,
  suitePath: t.suite.join('\x1f'),
  status: t.status,
  totalRuns: 48,
  passedRuns: t.status === 'passed' ? 47 : t.status === 'flaky' ? 39 : 44,
  failedRuns: t.status === 'failed' ? 4 : t.status === 'flaky' ? 2 : 1,
  flakyRuns: t.status === 'flaky' ? 7 : 0,
}));

/** The failure screenshot every execution serves: the demo's checkout page with its error banner. */
const SCREENSHOT = path.join(
  repoRoot,
  'apps',
  'application',
  'public',
  'demo',
  'screenshots',
  'checkout-error-banner.png',
);

/** Serves what the editor service reads of a Piwi instance, on a free loopback port. */
export function startStub(commit) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://stub');
    const json = (body) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    const p = u.pathname;
    if (p === '/api/projects/menu') return json({ items: [PROJECT] });
    if (p === `/api/projects/${PROJECT.id}/locator-index`) return json(INDEX);
    if (p === `/api/projects/${PROJECT.id}/code-index`)
      return json({
        files: ['src/cart/cart-service.ts'],
        tests: TESTS,
        reach: [{ file: 0, tests: [1, 2, 3, 4, 5], origin: 'server', runtime: 'server', via: 'coverage' }],
        builtAt: ago(130),
        truncated: false,
      });
    if (p === `/api/projects/${PROJECT.id}/test-cases`) return json({ items: CASES });
    if (p === `/api/projects/${PROJECT.id}/locator-alternatives`)
      return json({
        items: [
          {
            testCaseId: 4,
            location: `${PAGE_OBJECT_FILE}:${FAILING_LINE}:21`,
            method: 'locator',
            alternatives: ALTERNATIVES,
            lastSeenAt: ago(1500),
          },
        ],
      });
    if (p === `/api/projects/${PROJECT.id}/branch-failures`) return json(branchFailures(commit));
    if (p === `/api/projects/${PROJECT.id}/test-functions`) return json({ testFunctions: [] });
    if (p === `/api/projects/${PROJECT.id}/selections/preview`)
      return json({
        materialization: { args: [SPEC_FILE], command: `npx playwright test ${SPEC_FILE}` },
      });
    if (p === '/api/test-run-cases/900/locator-healing') return json(HEALING);
    if (p === '/api/test-run-cases/901/locator-healing')
      return json({
        ...HEALING,
        applicable: false,
        reason: 'The locator found its element; the assertion after it failed.',
        fromPriorSuccess: null,
        recommendation: null,
        edit: null,
        location: `${SPEC_FILE}:19:36`,
        sourceLine: null,
      });
    if (p === '/api/test-runs/124') return json({ ...branchFailures(commit).run, metadata: { piwiOrigin: 'ci' } });
    if (p === '/api/links') return json({ items: [] });
    if (p === `/api/projects/${PROJECT.id}/timeout-opportunities`) return json({ items: [] });
    if (p === `/api/projects/${PROJECT.id}/flake-lab`) return json({ tests: [] });
    if (p === `/api/projects/${PROJECT.id}/feature-map`) return json({ features: [] });
    if (p.startsWith('/api/files/')) {
      res.setHeader('Content-Type', 'image/png');
      return fs.createReadStream(SCREENSHOT).pipe(res);
    }
    res.statusCode = 404;
    json({});
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })),
  );
}
