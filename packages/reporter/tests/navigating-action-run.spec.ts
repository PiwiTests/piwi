import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type FakeServer } from './_helpers.js';
import type { LocatorSnapshot } from '../src/internal/capture/locator-healing.js';

/**
 * A real Playwright run through the built package, whose clicks take their element away as they run: a submit button
 * and a link that navigate at once, to a page that answers after `NEXT_PAGE_MS`. Each keeps the element it clicked in
 * its `piwi-locators` snapshot, as a click on an element that stays does.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
// Inside the package, so the suite resolves the same @playwright/test as the built reporter.
const project = path.join(pkgRoot, 'tests', `.navigating-action-run-${process.pid}`);
/** How long the page a click navigates to takes to answer: the clicked page stays until it does. */
const NEXT_PAGE_MS = 1000;

const CHECKOUT = `<!doctype html><title>checkout</title>
<form action="/done"><label>Coupon <input name="coupon"></label><button>Place order</button></form>
<a href="/done">Continue shopping</a>`;

const SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('places the order', async ({ page }) => {
  await page.goto('${base}/checkout');
  await page.getByRole('button', { name: 'Place order' }).click(); // act
  await expect(page).toHaveTitle('done');
});
test('follows a link', async ({ page }) => {
  await page.goto('${base}/checkout');
  await page.getByRole('link', { name: 'Continue shopping' }).click(); // act
  await expect(page).toHaveTitle('done');
});
`;

/** Each test's status and its `piwi-locators` snapshots, as the run's own reporter writes them. */
const LOCATORS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    const found = result.attachments.find((a) => a.name === 'piwi-locators');
    const body = found?.body?.toString('utf8') ?? (found?.path ? fs.readFileSync(found.path, 'utf8') : null);
    this.tests.push({ title: test.title, status: result.status, errors: result.errors.map((e) => e.message), locators: body ? JSON.parse(body) : [] });
  }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

interface DumpedTest {
  title: string;
  status: string;
  errors: string[];
  locators: LocatorSnapshot[];
}

let server: FakeServer;
let tests: DumpedTest[] = [];
/** The lines of the spec marked `// act`: the clicks that take their element away. */
let actLines: number[] = [];
let output = '';

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url.startsWith('/done')) {
      setTimeout(() => res.end('<!doctype html><title>done</title><h1>Thank you</h1>'), NEXT_PAGE_MS);
      return;
    }
    res.end(CHECKOUT);
  });

  write(
    'fixture.cjs',
    `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
  );
  write('locators-reporter.cjs', LOCATORS_REPORTER);
  // Its own outputDir: Playwright defaults to the package's test-results/, which every spawned run clears on start.
  write(
    'playwright.config.cjs',
    `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 15000,
  workers: 1,
  reporter: [['./locators-reporter.cjs', { outputFile: 'results.json' }]],
  use: { headless: true },
});
`,
  );
  const spec = SPEC(server.url);
  actLines = spec.split('\n').flatMap((line, i) => (line.endsWith('// act') ? [i + 1] : []));
  write('tests/checkout.spec.cjs', spec);

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['CI', 'PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_PAUSE_AT', 'PIWI_RUN_CHANNEL', 'PIWI_EDITOR_SEND'])
    delete env[name];
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 120_000 },
      (_error, stdout, stderr) => {
        output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  const results = path.join(project, 'results.json');
  tests = fs.existsSync(results) ? (JSON.parse(fs.readFileSync(results, 'utf8')) as DumpedTest[]) : [];
}, 150_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  await server?.close();
});

/** The snapshot of a test's click marked `// act`; the test passed. */
function snapshotOf(title: string): LocatorSnapshot {
  const found = tests.find((t) => t.title === title);
  if (!found) throw new Error(`no result for "${title}":\n${output}`);
  expect(found.status, found.errors.join('\n')).toBe('passed');
  const snapshot = found.locators.find((s) => actLines.includes(Number(/:(\d+):\d+$/.exec(s.location ?? '')?.[1])));
  if (!snapshot) throw new Error(`no snapshot of the marked click in "${title}": ${JSON.stringify(found.locators)}`);
  return snapshot;
}

describe('a click that takes its element away keeps the element', () => {
  it('a submit button that navigates at once', () => {
    const snapshot = snapshotOf('places the order');
    expect(snapshot.element).toMatchObject({ tagName: 'button', accessibleName: 'Place order' });
    expect(snapshot.alternatives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'getByRole', args: { role: 'button', name: 'Place order' } }),
      ]),
    );
  });

  it('a link that navigates at once', () => {
    const snapshot = snapshotOf('follows a link');
    expect(snapshot.element).toMatchObject({
      tagName: 'a',
      accessibleName: 'Continue shopping',
      attributes: expect.objectContaining({ href: '/done' }),
    });
  });
});
