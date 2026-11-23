import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type FakeServer, withoutCi } from './_helpers.js';

/**
 * A real Playwright run through the built package, with browser coverage on and Playwright's `reuseContext`: one
 * worker hands the same page to each test, resetting it to `about:blank` between them. Every test sets up, and each
 * records the coverage of its own navigation.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
// Inside the package, so the suite resolves the same @playwright/test as the built reporter.
const project = path.join(pkgRoot, 'tests', `.code-reach-reuse-run-${process.pid}`);

const PAGE = `<!doctype html><title>shop</title>
<button id="pay">Pay</button><script src="/src/pay.js"></script>`;
const SCRIPT = `function pay() {
  document.body.dataset.paid = 'yes';
}
document.querySelector('#pay').addEventListener('click', () => pay());
`;

const SPEC = `const { test, expect } = require('../fixture.cjs');
for (const name of ['first', 'second', 'third']) {
  test(name, async ({ page }) => {
    await page.goto('/');
    await page.click('#pay');
    await expect(page.locator('body')).toHaveAttribute('data-paid', 'yes');
  });
}
`;

/** Each test's status and the files of its `piwi-code-reach` attachment, as the run's own reporter writes them. */
const REACH_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    const found = result.attachments.find((a) => a.name === 'piwi-code-reach');
    const body = found?.body?.toString('utf8') ?? (found?.path ? fs.readFileSync(found.path, 'utf8') : null);
    this.tests.push({ title: test.title, status: result.status, errors: result.errors.map((e) => e.message), files: body ? JSON.parse(body) : [] });
  }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

interface DumpedTest {
  title: string;
  status: string;
  errors: string[];
  files: string[];
}

let server: FakeServer;
let tests: DumpedTest[] = [];
let output = '';

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  server = await startServer((req, res) => {
    const script = req.url.startsWith('/src/pay.js');
    res.writeHead(200, { 'content-type': script ? 'text/javascript' : 'text/html' });
    res.end(script ? SCRIPT : PAGE);
  });

  write(
    'fixture.cjs',
    `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
  );
  write('reach-reporter.cjs', REACH_REPORTER);
  write('src/pay.js', SCRIPT);
  // Its own outputDir: Playwright defaults to the package's test-results/, which every spawned run clears on start.
  write(
    'playwright.config.cjs',
    `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 10000,
  workers: 1,
  reporter: [['./reach-reporter.cjs', { outputFile: 'results.json' }]],
  use: { headless: true, baseURL: ${JSON.stringify(server.url)}, reuseContext: true },
});
`,
  );
  write('tests/shop.spec.cjs', SPEC);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_COVERAGE_BROWSER: 'lines',
    PIWI_CAPTURE_LOCATORS: 'false',
    // A Playwright without the `reuseContext` option reuses its context through this variable.
    PW_TEST_REUSE_CONTEXT: '1',
  };
  for (const name of [
    'PWDEBUG',
    'PIWI_DASHBOARD_URL',
    'PIWI_PAUSE_AT',
    'PIWI_RUN_CHANNEL',
    'PIWI_EDITOR_SEND',
    'PIWI_CAPTURE_CODE_REACH',
    'PIWI_CODE_REACH_ROOTS',
  ])
    delete env[name];
  withoutCi(env);
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

describe('browser coverage on a page the worker reuses', () => {
  it('sets up every test', () => {
    expect(
      tests.map((t) => [t.title, t.status, t.errors.join('\n')]),
      output,
    ).toEqual([
      ['first', 'passed', ''],
      ['second', 'passed', ''],
      ['third', 'passed', ''],
    ]);
  });

  it('records the navigation of each test', () => {
    for (const test of tests) {
      expect(test.files, test.title).toEqual([expect.stringMatching(/(^|\/)src\/pay\.js$/)]);
    }
  });
});
