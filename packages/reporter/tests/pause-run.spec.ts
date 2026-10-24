import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type FakeServer } from './_helpers.js';
import { readPauses, withoutPausedTime } from '../src/internal/collect/paused-steps.js';
import type { PauseRecord } from '../src/internal/capture/pause-at.js';

/**
 * A real Playwright run with breakpoints, through the built package: the stops come from Playwright's debugger, the
 * pause bar shows in the page, and a script of the page answers it the way a person would, with what this test's
 * server tells it. The project is headed, as the pause needs, and Chromium runs without a window (`--headless=new`),
 * so it needs no display.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
// Inside the package, so the suite resolves the same @playwright/test as the built reporter.
const project = path.join(pkgRoot, 'tests', `.pause-run-${process.pid}`);
/** The tests' timeout, and how long the slow answers wait: longer than it. */
const TIMEOUT_MS = 3000;
const HOLD_MS = 4000;

/** A page of the app: it answers Piwi's pause bar with what the server says, once per bar. */
const PAGE = (title: string) => `<!doctype html><title>${title}</title><input><button>Go</button>
<script>
new MutationObserver(() => {
  const bar = document.getElementById('__piwi-pause-bar');
  if (!bar || bar.dataset.answered) return;
  bar.dataset.answered = '1';
  const stop = { where: bar.children[0].textContent, what: bar.children[1].textContent };
  fetch('/stop', { method: 'POST', body: JSON.stringify(stop) })
    .then((response) => response.text())
    .then((answer) => [...bar.querySelectorAll('button')].find((b) => b.textContent === answer).click());
}).observe(document.documentElement, { childList: true, subtree: true });
</script>`;

/** The spec the run executes; `// bp` marks a breakpoint's line. */
const SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('stops', async ({ page }) => {
  await page.goto('${base}/a');
  await page.goto('${base}/b'); // bp
  await page.keyboard.press('Tab'); // bp
  await page.getByRole('button').click();
  await expect(page).toHaveTitle('b');
  await page.getByRole('button').click(); // bp
  await page.keyboard.press('Tab'); // bp
});
test('own context', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('${base}/a');
  await expect(page.getByRole('button')).toBeVisible(); // bp
  await context.close();
});
test('page pause', async ({ page }) => {
  await page.goto('${base}/a');
  await page.pause();
  await page.getByRole('button').click();
});
test.describe.serial('a page a hook opened', () => {
  let page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });
  test.afterAll(async () => {
    await page.close();
  });
  test('first', async () => {
    await page.goto('${base}/a');
  });
  test('second', async () => {
    await page.goto('${base}/b'); // bp
  });
});
`;

/** Each test's result, as the run's own reporter writes it: its steps with their places and times. */
const STEPS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    const step = (s) => ({ title: s.title, category: s.category, location: s.location, startTime: s.startTime.getTime(), duration: s.duration, steps: s.steps.map(step) });
    const pauses = result.attachments.find((a) => a.name === 'piwi-pauses');
    this.tests.push({ title: test.title, status: result.status, duration: result.duration, errors: result.errors.map((e) => e.message), steps: result.steps.map(step), pauses: pauses?.body?.toString('utf8') ?? null });
  }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

interface DumpedStep {
  title: string;
  category: string;
  location?: { file: string; line: number; column: number };
  startTime: number;
  duration: number;
  steps: DumpedStep[];
}

interface DumpedTest {
  title: string;
  status: string;
  duration: number;
  errors: string[];
  steps: DumpedStep[];
  pauses: string | null;
}

/** The answers the page gives, in the order the bar shows. */
const ANSWERS: Array<{ answer: string; hold?: number }> = [
  { answer: 'Resume', hold: HOLD_MS }, // stops: page.goto(/b)
  { answer: 'Step' }, // stops: keyboard.press
  { answer: 'Resume' }, // stops: the click after it, no breakpoint
  { answer: 'Finish' }, // stops: the second click
  { answer: 'Resume' }, // own context: the assertion
  { answer: 'Resume', hold: HOLD_MS }, // page.pause()
  { answer: 'Resume', hold: HOLD_MS }, // a page a hook opened: page.goto(/b)
];

let server: FakeServer;
const stops: Array<{ where: string; what: string }> = [];
let tests: DumpedTest[] = [];
let bp: number[] = [];
let exitCode: number | null = null;
let output = '';

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  server = await startServer((req, res) => {
    if (req.url === '/stop') {
      stops.push(JSON.parse(req.body) as { where: string; what: string });
      const next = ANSWERS[stops.length - 1] ?? { answer: 'Resume' };
      setTimeout(() => res.end(next.answer), next.hold ?? 50);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE(req.url === '/b' ? 'b' : 'a'));
  });

  const spec = SPEC(server.url);
  bp = spec.split('\n').flatMap((line, i) => (line.endsWith('// bp') ? [i + 1] : []));
  write(
    'fixture.cjs',
    `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
  );
  write('steps-reporter.cjs', STEPS_REPORTER);
  // Its own outputDir: Playwright defaults to the package's test-results/, which every spawned run clears on start.
  write(
    'playwright.config.cjs',
    `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: ${TIMEOUT_MS},
  workers: 1,
  reporter: [['./steps-reporter.cjs', { outputFile: 'results.json' }]],
  use: { headless: false, launchOptions: { args: ['--headless=new'] } },
});
`,
  );
  write('tests/pause.spec.cjs', spec);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_PAUSE_AT: bp.map((line) => `tests/pause.spec.cjs:${line}`).join(';'),
  };
  for (const name of ['CI', 'PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_RECORD_CHANNEL', 'PIWI_EDITOR_SEND'])
    delete env[name];
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 120_000 },
      (error, stdout, stderr) => {
        exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
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

/** Every step of a test, depth first. */
function allSteps(steps: DumpedStep[]): DumpedStep[] {
  return steps.flatMap((s) => [s, ...allSteps(s.steps)]);
}

function test(title: string): DumpedTest {
  const found = tests.find((t) => t.title === title);
  if (!found) throw new Error(`no result for "${title}":\n${output}`);
  return found;
}

describe('a run with breakpoints', () => {
  it('passes every test, a stop longer than the test timeout included', () => {
    expect(exitCode, output).toBe(0);
    expect(tests.map((t) => [t.title, t.status])).toEqual([
      ['stops', 'passed'],
      ['own context', 'passed'],
      ['page pause', 'passed'],
      ['first', 'passed'],
      ['second', 'passed'],
    ]);
  });

  it('stops at a navigation and a key press on a breakpoint, at the next call after Step, and at none after Finish', () => {
    const [goto, press, click, , ownContext, second] = bp;
    expect(stops).toEqual([
      { where: `Paused at pause.spec.cjs:${goto}`, what: expect.stringMatching(/^Navigate .*\/b$/) },
      { where: `Paused at pause.spec.cjs:${press}`, what: 'Press "Tab"' },
      { where: `Paused at pause.spec.cjs:${press! + 1}`, what: `Click getByRole('button')` },
      { where: `Paused at pause.spec.cjs:${click}`, what: `Click getByRole('button')` },
      { where: `Paused at pause.spec.cjs:${ownContext}`, what: `Expect "toBeVisible" getByRole('button')` },
      { where: expect.stringMatching(/^Paused at pause\.spec\.cjs:\d+$/), what: 'Pause' },
      { where: `Paused at pause.spec.cjs:${second}`, what: expect.stringMatching(/^Navigate .*\/b$/) },
    ]);
  });

  it('lists each stop it showed in piwi-pauses, with its place, reason and duration', () => {
    const pauses = readPauses(Buffer.from(test('stops').pauses ?? ''));
    expect(pauses.map((p) => [p.location.replace(/:\d+$/, ''), p.reason])).toEqual([
      [`tests/pause.spec.cjs:${bp[0]}`, 'breakpoint'],
      [`tests/pause.spec.cjs:${bp[1]}`, 'breakpoint'],
      [`tests/pause.spec.cjs:${bp[1]! + 1}`, 'step'],
      [`tests/pause.spec.cjs:${bp[2]}`, 'breakpoint'],
    ]);
    expect(pauses[0]!.duration).toBeGreaterThanOrEqual(HOLD_MS);
    expect(readPauses(Buffer.from(test('page pause').pauses ?? ''))).toEqual([
      expect.objectContaining({ title: 'Pause', reason: 'page-pause' }),
    ]);
    expect(test('first').pauses).toBeNull();
  });

  it('keeps every stop out of the test duration, and out of the steps once the reporter reads piwi-pauses', () => {
    for (const title of ['stops', 'page pause', 'second']) {
      const result = test(title);
      expect(result.duration, title).toBeLessThan(TIMEOUT_MS);
      const pauses: PauseRecord[] = readPauses(Buffer.from(result.pauses ?? ''));
      const held = (steps: DumpedStep[]) => allSteps(steps).filter((s) => s.duration >= HOLD_MS);
      expect(held(result.steps).length, title).toBeGreaterThan(0);
      expect(held(withoutPausedTime(result.steps, pauses, project)), title).toEqual([]);
    }
  });

  it('shows none of its own calls among the test’s steps', () => {
    for (const result of tests) {
      const titles = allSteps(result.steps).map((s) => s.title);
      expect(titles, result.title).not.toContainEqual(
        expect.stringMatching(
          /Pause on next|Step to next|Run to|^Resume|Evaluate|Wait for function|highlight|Piwi capture/i,
        ),
      );
    }
    const body = test('stops').steps.filter((s) => s.category === 'pw:api' || s.category === 'expect');
    expect(body.map((s) => s.title)).toEqual([
      expect.stringMatching(/^Navigate/),
      expect.stringMatching(/^Navigate/),
      'Press "Tab"',
      'Click',
      'Expect "toHaveTitle"',
      'Click',
      'Press "Tab"',
    ]);
  });
});
