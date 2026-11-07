import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { TestStep } from '@playwright/test/reporter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildResourceReport, tallyLifecycleSteps } from '../src/internal/collect/resource-verdicts.js';
import { sourceLineReader } from '../src/internal/support/source-snippet.js';

/**
 * A real Playwright run of a suite without the capture fixtures, whose steps are tallied as the reporter tallies
 * them: the step titles, the hooks' titles and columns and each call's column are Playwright's own, so a release
 * that changes one shows here, on the floor version too.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
// Inside the package, so the suite resolves the same @playwright/test as the reporter.
const project = path.join(pkgRoot, 'tests', `.probable-leaks-run-${process.pid}`);

const LEAKS_SPEC = `import { test, chromium, request } from '@playwright/test';

test('leaks a context', async ({ browser }) => {
  await browser.newContext(); // context
});
test('closes a context', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.close();
});
test('leaks a page', async ({ browser }) => {
  await browser.newPage(); // page
});
test('closes a page', async ({ browser }) => {
  const page = await browser.newPage();
  await page.close();
});
test('leaks a browser', async () => {
  await chromium.launch(); // browser
});
test('closes a browser with what it opened', async () => {
  const other = await chromium.launch();
  await other.newContext();
  await other.newPage();
  await other.close();
});
test('leaves an API context, which is not counted', async () => {
  await request.newContext();
});
test('opens a page in its context', async ({ context }) => {
  await context.newPage();
});
`;

const HOOKS_SPEC = `import { test, type BrowserContext, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
let shared: BrowserContext;
let page: Page;
test.beforeAll('open the shop', async ({ browser }) => {
  shared = await browser.newContext();
});
test.afterAll(async () => {
  await shared.close();
  await page.close();
});
test.afterEach(async ({ context }) => {
  await context.close();
});
test('hands a page on', async ({ browser }) => {
  page = await browser.newPage();
});
test('uses it', async () => {
  await page.goto('about:blank');
});
`;

/** Each attempt and its steps, as the run's own reporter writes them. */
const STEPS_REPORTER = `const fs = require('node:fs');
const strip = (steps) => steps.map((s) => ({
  title: s.title,
  category: s.category,
  location: s.location,
  error: s.error ? { message: String(s.error.message ?? '') } : undefined,
  steps: strip(s.steps),
}));
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.attempts = []; }
  onTestEnd(test, result) {
    this.attempts.push({
      id: test.id,
      file: test.location.file,
      worker: result.workerIndex,
      failed: result.status !== test.expectedStatus,
      steps: strip(result.steps),
    });
  }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.attempts)); }
};
`;

interface DumpedAttempt {
  id: string;
  file: string;
  worker: number;
  failed: boolean;
  steps: unknown[];
}

let attempts: DumpedAttempt[] = [];
let exitCode: number | null = null;
let output = '';

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

/** `file:line` of the line of `source` marked `// mark`, as the reporter names it. */
function marked(file: string, source: string, mark: string): string {
  const line = source.split('\n').findIndex((text) => text.endsWith(`// ${mark}`)) + 1;
  return `${path.relative(process.cwd(), path.join(project, file)).split(path.sep).join('/')}:${line}`;
}

beforeAll(async () => {
  write('package.json', JSON.stringify({ name: 'probable-leaks-suite', private: true }));
  write(
    'playwright.config.ts',
    `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  reporter: [['./steps-reporter.cjs', { outputFile: 'attempts.json' }]],
});
`,
  );
  write('steps-reporter.cjs', STEPS_REPORTER);
  write('tests/hooks.spec.ts', HOOKS_SPEC);
  write('tests/leaks.spec.ts', LEAKS_SPEC);

  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test'],
      { cwd: project, timeout: 90_000 },
      (error, stdout, stderr) => {
        exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
        output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  const results = path.join(project, 'attempts.json');
  attempts = fs.existsSync(results) ? (JSON.parse(fs.readFileSync(results, 'utf8')) as DumpedAttempt[]) : [];
}, 120_000);

afterAll(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe('probable leaks from a real run without the fixtures', () => {
  it('finds each object left open at its line, and nothing that was closed', () => {
    expect(exitCode, output).toBe(0);
    expect(attempts, output).toHaveLength(10);
    const source = sourceLineReader();
    const tallies = attempts.map((attempt) =>
      tallyLifecycleSteps(
        { file: path.relative(project, attempt.file), test: attempt.id, worker: attempt.worker, failed: attempt.failed },
        attempt.steps as TestStep[],
        source,
      ),
    );
    const findings = buildResourceReport({ censuses: [], tallies }).findings;
    expect(findings.map(({ kind, where }) => [kind, where]).sort()).toEqual([
      ['browser', marked('tests/leaks.spec.ts', LEAKS_SPEC, 'browser')],
      ['context', marked('tests/leaks.spec.ts', LEAKS_SPEC, 'context')],
      ['page', marked('tests/leaks.spec.ts', LEAKS_SPEC, 'page')],
    ]);
  });
});
