import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type FakeServer, withoutCi } from './_helpers.js';

/**
 * Real Playwright runs through the built package, with browser coverage on: one closing each test's context, and one
 * with Playwright's `reuseContext`, where the worker hands the same page to each test and resets it to `about:blank`
 * between them. Every test sets up and records its own navigation, and a fixture on the context alone that navigates
 * as it ends (`logout`) still counts for its test where the context closes.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
// Inside the package, so the suite resolves the same @playwright/test as the built reporter.
const project = path.join(pkgRoot, 'tests', `.code-reach-reuse-run-${process.pid}`);

const PAGE = `<!doctype html><title>shop</title>
<button id="pay">Pay</button><script src="/src/pay.js"></script>`;
const PAY = `function pay() {
  document.body.dataset.paid = 'yes';
}
document.querySelector('#pay').addEventListener('click', () => pay());
`;
const BYE_PAGE = `<!doctype html><title>bye</title><script src="/src/bye.js"></script>`;
const BYE = `function bye() {
  document.body.dataset.bye = 'yes';
}
bye();
`;

const SPEC = `const { test: base, expect } = require('../fixture.cjs');
const test = base.extend({
  // Torn down after the page fixture, as it was set up before it.
  logout: async ({ context }, use) => {
    await use();
    await context.pages()[0].goto('/bye');
  },
});
async function pay(page) {
  await page.goto('/');
  await page.click('#pay');
  await expect(page.locator('body')).toHaveAttribute('data-paid', 'yes');
}
test('pays', async ({ page }) => pay(page));
test('logs out', async ({ logout, page }) => pay(page));
test('pays again', async ({ page }) => pay(page));
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

interface Run {
  tests: DumpedTest[];
  output: string;
}

let server: FakeServer;
let closing: Run = { tests: [], output: '' };
let reusing: Run = { tests: [], output: '' };

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

/** A config of the suite, with its own results file and outputDir (Playwright's default is the package's test-results/). */
function config(name: string, use: string): string {
  return `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  outputDir: './test-results-${name}',
  timeout: 10000,
  workers: 1,
  reporter: [['./reach-reporter.cjs', { outputFile: 'results-${name}.json' }]],
  use: { headless: true, baseURL: ${JSON.stringify(server.url)}${use} },
});
`;
}

async function run(name: string, extraEnv: NodeJS.ProcessEnv): Promise<Run> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_COVERAGE_BROWSER: 'lines',
    PIWI_CAPTURE_LOCATORS: 'false',
    ...extraEnv,
  };
  for (const key of [
    'PWDEBUG',
    'PW_TEST_REUSE_CONTEXT',
    'PIWI_DASHBOARD_URL',
    'PIWI_PAUSE_AT',
    'PIWI_RUN_CHANNEL',
    'PIWI_EDITOR_SEND',
    'PIWI_CAPTURE_CODE_REACH',
    'PIWI_CODE_REACH_ROOTS',
  ]) {
    if (!(key in extraEnv)) delete env[key];
  }
  withoutCi(env);
  const output = await new Promise<string>((resolve) => {
    execFile(
      process.execPath,
      [createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test', '--config', `${name}.config.cjs`],
      { cwd: project, env, timeout: 120_000 },
      (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`),
    );
  });
  const results = path.join(project, `results-${name}.json`);
  const tests = fs.existsSync(results) ? (JSON.parse(fs.readFileSync(results, 'utf8')) as DumpedTest[]) : [];
  return { tests, output };
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  server = await startServer((req, res) => {
    const script = req.url.startsWith('/src/pay.js') ? PAY : req.url.startsWith('/src/bye.js') ? BYE : null;
    res.writeHead(200, { 'content-type': script ? 'text/javascript' : 'text/html' });
    res.end(script ?? (req.url.startsWith('/bye') ? BYE_PAGE : PAGE));
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
  write('src/pay.js', PAY);
  write('src/bye.js', BYE);
  write('tests/shop.spec.cjs', SPEC);
  write('closing.config.cjs', config('closing', ''));
  write('reusing.config.cjs', config('reusing', ', reuseContext: true'));

  closing = await run('closing', {});
  // A Playwright without the `reuseContext` option reuses its context through this variable.
  reusing = await run('reusing', { PW_TEST_REUSE_CONTEXT: '1' });
}, 300_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  await server?.close();
});

/** The test's files, each from its `src/` folder on. */
function filesOf(run: Run, title: string): string[] {
  const found = run.tests.find((t) => t.title === title);
  if (!found) throw new Error(`no result for "${title}":\n${run.output}`);
  return found.files.map((file) => file.replace(/^.*\/(?=src\/)/, ''));
}

function statuses(run: Run): string[][] {
  return run.tests.map((t) => [t.title, t.status, t.errors.join('\n')]);
}

const PASSED = [
  ['pays', 'passed', ''],
  ['logs out', 'passed', ''],
  ['pays again', 'passed', ''],
];

describe('browser coverage on a context that closes after each test', () => {
  it('sets up every test', () => {
    expect(statuses(closing), closing.output).toEqual(PASSED);
  });

  it('counts what a fixture on the context runs as it ends', () => {
    expect(filesOf(closing, 'pays')).toEqual(['src/pay.js']);
    expect(filesOf(closing, 'logs out')).toEqual(['src/bye.js', 'src/pay.js']);
    expect(filesOf(closing, 'pays again')).toEqual(['src/pay.js']);
  });
});

describe('browser coverage on a page the worker reuses', () => {
  it('sets up every test', () => {
    expect(statuses(reusing), reusing.output).toEqual(PASSED);
  });

  it('records the navigation of each test', () => {
    for (const title of ['pays', 'logs out', 'pays again']) {
      expect(filesOf(reusing, title), title).toContain('src/pay.js');
    }
  });
});
