import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestResult } from '@playwright/test/reporter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildErrorText } from '../src/internal/collect/error-text.js';

/**
 * A real Playwright run of an ES-module suite (`"type": "module"`, laid out like `examples/sample-app`: fixtures, a
 * page object, specs), through the built package. Its stack frames carry `file://` URLs, its folder has a space in
 * its name, and each locator call's site is still recorded relative to the run's folder, the way the error text the
 * reporter stores names a failure's place.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
// Inside the package, so the suite resolves the same @playwright/test as the built reporter.
const project = path.join(pkgRoot, 'tests', `.esm-call-sites-run ${process.pid}`);

const FIXTURES = `import { test as base, expect } from '@playwright/test';
import { piwiFixtures } from ${JSON.stringify(pathToFileURL(dist).href)};

export const test = base.extend(piwiFixtures);
export { expect };
`;

const CART_PAGE = `import type { Page } from '@playwright/test';

/** The shop's cart. */
export class CartPage {
  constructor(readonly page: Page) {}

  async open(): Promise<void> {
    await this.page.setContent('<h1>Cart</h1><button>Add to cart</button>');
  }

  async add(): Promise<void> {
    await this.page.getByRole('button', { name: 'Add to cart' }).click(); // add
  }

  async checkOut(): Promise<void> {
    await this.page.getByRole('button', { name: 'Check out' }).click({ timeout: 500 }); // check out
  }
}
`;

const CART_SPEC = `import { test, expect } from './fixtures';
import { CartPage } from './pages/cart-page';

test('adds to the cart', async ({ page }) => {
  const cart = new CartPage(page);
  await cart.open();
  await cart.add();
  await expect(page.getByRole('heading', { name: 'Cart' })).toBeVisible(); // heading
});

test('checks out', async ({ page }) => {
  test.fail();
  const cart = new CartPage(page);
  await cart.open();
  await cart.checkOut();
});
`;

/** Each test's recorded call sites and its errors, as the run's own reporter writes them. */
const SITES_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    const locators = result.attachments.find((a) => a.name === 'piwi-locators');
    this.tests.push({
      title: test.title,
      status: result.status,
      sites: locators?.body ? JSON.parse(locators.body.toString('utf8')).map((l) => l.location) : [],
      errors: result.errors.map((e) => ({ message: e.message })),
      error: result.error ? { location: result.error.location } : undefined,
    });
  }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

interface DumpedTest {
  title: string;
  status: string;
  sites: Array<string | null>;
  errors: Array<{ message?: string }>;
  error?: { location?: { file: string; line: number; column: number } };
}

let tests: DumpedTest[] = [];
let exitCode: number | null = null;
let output = '';

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

/** The call site of `method` on the line of `source` marked `// mark`: `file:line:col`, the column at the method's name. */
function site(file: string, source: string, mark: string, method: string): string {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => line.endsWith(`// ${mark}`));
  return `${file}:${index + 1}:${lines[index]!.indexOf(`.${method}(`) + 2}`;
}

function test(title: string): DumpedTest {
  const found = tests.find((t) => t.title === title);
  if (!found) throw new Error(`no result for "${title}":\n${output}`);
  return found;
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  write('package.json', JSON.stringify({ name: 'esm-suite', private: true, type: 'module' }));
  // Its own outputDir: Playwright defaults to the package's test-results/, which every spawned run clears on start.
  write(
    'playwright.config.ts',
    `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  workers: 1,
  reporter: [['./sites-reporter.cjs', { outputFile: 'results.json' }]],
});
`,
  );
  write('sites-reporter.cjs', SITES_REPORTER);
  write('tests/fixtures.ts', FIXTURES);
  write('tests/pages/cart-page.ts', CART_PAGE);
  write('tests/cart.spec.ts', CART_SPEC);

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PIWI_DASHBOARD_URL;
  delete env.PIWI_PROBE;
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 90_000 },
      (error, stdout, stderr) => {
        exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
        output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  const results = path.join(project, 'results.json');
  tests = fs.existsSync(results) ? (JSON.parse(fs.readFileSync(results, 'utf8')) as DumpedTest[]) : [];
}, 120_000);

afterAll(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe('an ES-module suite', () => {
  it('runs, the failing test failing as expected', () => {
    expect(exitCode, output).toBe(0);
    expect(tests.map((t) => [t.title, t.status])).toEqual([
      ['adds to the cart', 'passed'],
      ['checks out', 'failed'],
    ]);
  });

  it('records each call site relative to the run, in the page object and in the spec', () => {
    expect(test('adds to the cart').sites).toEqual([
      site('tests/pages/cart-page.ts', CART_PAGE, 'add', 'click'),
      site('tests/cart.spec.ts', CART_SPEC, 'heading', 'toBeVisible'),
    ]);
  });

  it("records a failed call's site as the stored error text names the failure's place", () => {
    const failed = test('checks out');
    const expected = site('tests/pages/cart-page.ts', CART_PAGE, 'check out', 'click');
    expect(failed.sites).toEqual([expected]);
    const text = buildErrorText(failed as unknown as TestResult, project);
    expect(text?.split('\n').pop()).toBe(`    at ${expected}`);
  });
});
