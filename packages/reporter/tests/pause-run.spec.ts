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
 * server tells it. The project is headed, as the pause needs. With a display (`DISPLAY`, on Linux: CI runs it under
 * `xvfb-run`), Chromium opens its windows, and Playwright's Inspector would open at a stop as it does for a person;
 * without one, Chromium runs without a window (`--headless=new`), where Playwright never opens its Inspector.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
// Inside the package, so the suite resolves the same @playwright/test as the built reporter.
const project = path.join(pkgRoot, 'tests', `.pause-run-${process.pid}`);
/** The tests' timeout, and how long the slow answers wait: longer than it. */
const TIMEOUT_MS = 3000;
const HOLD_MS = 4000;
/** How long the person takes to end a `page.pause()` Piwi leaves to Playwright. */
const OWN_PAUSE_MS = 1000;
/** How long after a stop shows its Inspector would be running, had Playwright opened one. */
const INSPECTOR_CHECK_MS = 500;
/** Whether the run opens real windows, and can see Playwright's Inspector open. */
const WINDOWS = process.platform === 'linux' && !!process.env.DISPLAY;

/** Whether Playwright's Inspector is open: a Chromium app window of its own (`--app=data:text/html,`). */
function inspectorOpen(): boolean {
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--app=data:text/html,')) return true;
    } catch {
      // The process ended.
    }
  }
  return false;
}

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
/** Playwright's own \`page.pause()\`, which the person ends from the Inspector once the server answers. */
async function ownPause(page, where) {
  const dbg = page.context().debugger;
  const onStop = () => {
    if (!dbg.pausedDetails()) return;
    dbg.off('pausedstatechanged', onStop);
    fetch('${base}/own-pause', { method: 'POST', body: where }).then(() => dbg.resume()).catch(() => {});
  };
  dbg.on('pausedstatechanged', onStop);
  const started = Date.now();
  await page.pause();
  await fetch('${base}/own-pause-end', { method: 'POST', body: JSON.stringify({ where, held: Date.now() - started }) });
}
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
test('poll', async ({ page }) => {
  await page.goto('${base}/a');
  await expect.poll(() => page.locator('input').inputValue(), { timeout: 1000 }).toBe(''); // bp
});
test.describe.serial('a pause in an afterAll', () => {
  let page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });
  test.afterAll(async () => {
    await ownPause(page, 'afterAll');
    await page.close();
  });
  test('arms its context', async () => {
    await page.goto('${base}/a');
    await page.goto('${base}/b'); // bp
  });
});
// Last: Playwright's Inspector stays open with its context, and no stop shows the bar after it.
test.describe.serial('a pause in a beforeAll', () => {
  let page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await ownPause(page, 'beforeAll');
  });
  test.afterAll(async () => {
    await page.close();
  });
  test('runs after it', async () => {
    await page.goto('${base}/a');
  });
});
`;

/** Each test's result, as the run's own reporter writes it: its steps with their places and times. */
const STEPS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    const step = (s) => ({ title: s.title, category: s.category, location: s.location, startTime: s.startTime.getTime(), duration: s.duration, steps: s.steps.map(step) });
    const body = (name) => {
      const found = result.attachments.find((a) => a.name === name);
      return found?.body?.toString('utf8') ?? (found?.path ? fs.readFileSync(found.path, 'utf8') : null);
    };
    this.tests.push({ title: test.title, status: result.status, startTime: result.startTime.getTime(), duration: result.duration, errors: result.errors.map((e) => e.message), steps: result.steps.map(step), pauses: body('piwi-pauses'), aria: body('piwi-aria-snapshot'), errorContext: body('error-context') });
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
  startTime: number;
  duration: number;
  errors: string[];
  steps: DumpedStep[];
  pauses: string | null;
  aria: string | null;
  errorContext: string | null;
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
  { answer: 'Resume', hold: HOLD_MS }, // poll: inputValue(), past the poll's own deadline
  { answer: 'Resume' }, // arms its context: page.goto(/b)
];

let server: FakeServer;
/** Each stop the bar showed, and whether Playwright's Inspector was open just after it showed (with windows). */
const stops: Array<{ where: string; what: string; inspector?: boolean }> = [];
/** Each `page.pause()` left to Playwright: whether its Inspector opened (with windows), and how long it held. */
const ownPauses: Record<string, { inspector?: boolean; held?: number }> = {};
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
      const stop = JSON.parse(req.body) as (typeof stops)[number];
      stops.push(stop);
      const next = ANSWERS[stops.length - 1] ?? { answer: 'Resume' };
      // Checked soon after the stop shows, while the run is still held at it.
      const checkAfter = Math.min(next.hold ?? 50, INSPECTOR_CHECK_MS);
      if (WINDOWS) setTimeout(() => (stop.inspector = inspectorOpen()), checkAfter);
      setTimeout(() => res.end(next.answer), next.hold ?? 50);
      return;
    }
    if (req.url === '/own-pause') {
      setTimeout(() => {
        ownPauses[req.body] = { ...ownPauses[req.body], ...(WINDOWS ? { inspector: inspectorOpen() } : {}) };
        res.end();
      }, OWN_PAUSE_MS);
      return;
    }
    if (req.url === '/own-pause-end') {
      const { where, held } = JSON.parse(req.body) as { where: string; held: number };
      ownPauses[where] = { ...ownPauses[where], held };
      res.end();
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
  use: { headless: false, launchOptions: { args: ${WINDOWS ? '[]' : "['--headless=new']"} } },
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
  it('passes every test a wait did not fail under the bar, a stop longer than the test timeout included', () => {
    expect(exitCode, output).toBe(1);
    expect(tests.map((t) => [t.title, t.status])).toEqual([
      ['stops', 'passed'],
      ['own context', 'passed'],
      ['page pause', 'passed'],
      ['first', 'passed'],
      ['second', 'passed'],
      ['poll', 'failed'],
      ['arms its context', 'passed'],
      ['runs after it', 'passed'],
    ]);
  });

  it('stops at a navigation and a key press on a breakpoint, at the next call after Step, and at none after Finish', () => {
    const [goto, press, click, , ownContext, second, poll, arms] = bp;
    expect(stops.map(({ where, what }) => ({ where, what }))).toEqual([
      { where: `Paused at pause.spec.cjs:${goto}`, what: expect.stringMatching(/^Navigate .*\/b$/) },
      { where: `Paused at pause.spec.cjs:${press}`, what: 'Press "Tab"' },
      { where: `Paused at pause.spec.cjs:${press! + 1}`, what: `Click getByRole('button')` },
      { where: `Paused at pause.spec.cjs:${click}`, what: `Click getByRole('button')` },
      { where: `Paused at pause.spec.cjs:${ownContext}`, what: `Expect "toBeVisible" getByRole('button')` },
      { where: expect.stringMatching(/^Paused at pause\.spec\.cjs:\d+$/), what: 'Pause' },
      { where: `Paused at pause.spec.cjs:${second}`, what: expect.stringMatching(/^Navigate .*\/b$/) },
      { where: `Paused at pause.spec.cjs:${poll}`, what: `Get input value locator('input')` },
      { where: `Paused at pause.spec.cjs:${arms}`, what: expect.stringMatching(/^Navigate .*\/b$/) },
    ]);
  });

  it.runIf(WINDOWS)('keeps Playwright’s Inspector closed at every stop it shows the bar at', () => {
    expect(stops.filter((s) => s.inspector !== false).map((s) => s.where)).toEqual([]);
  });

  it('leaves a page.pause() in a hook to Playwright: its Inspector opens, and the person ends it', () => {
    // Without windows Playwright stops at `page.pause()` only in a context Piwi armed: the one of the afterAll.
    expect(ownPauses.afterAll?.held).toBeGreaterThanOrEqual(OWN_PAUSE_MS);
    if (!WINDOWS) return;
    expect(ownPauses.beforeAll?.held).toBeGreaterThanOrEqual(OWN_PAUSE_MS);
    expect([ownPauses.beforeAll?.inspector, ownPauses.afterAll?.inspector]).toEqual([true, true]);
  });

  it('takes the bar down when a wait started before the stop fails the test, and keeps the stop', () => {
    const result = test('poll');
    expect(result.errors.join('\n')).toMatch(/Timeout 1000ms exceeded while waiting on the predicate/);
    expect(readPauses(Buffer.from(result.pauses ?? ''))).toEqual([
      expect.objectContaining({
        location: expect.stringMatching(`^tests/pause.spec.cjs:${bp[6]}:`),
        reason: 'breakpoint',
      }),
    ]);
    expect(result.aria).toContain('button "Go"');
    expect(result.aria).not.toContain('Piwi: test paused');
    expect(result.errorContext ?? '').not.toContain('Piwi: test paused');
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
      expect(held(withoutPausedTime(result.steps, pauses)), title).toEqual([]);
    }
  });

  it('moves the steps after a stop back by the time stopped, so the test’s body fits its duration', () => {
    const result = test('stops');
    const pauses = readPauses(Buffer.from(result.pauses ?? ''));
    const stopped = pauses.reduce((sum, p) => sum + p.duration, 0);
    const hooks = (steps: DumpedStep[], title: string) => steps.find((s) => s.title === title)!;
    const before = hooks(result.steps, 'Before Hooks');
    const bodyStart = before.startTime + before.duration;
    const moved = hooks(withoutPausedTime(result.steps, pauses), 'After Hooks');
    expect(hooks(result.steps, 'After Hooks').startTime - moved.startTime).toBe(stopped);
    expect(hooks(result.steps, 'After Hooks').startTime - bodyStart).toBeGreaterThan(result.duration);
    expect(moved.startTime - bodyStart).toBeLessThan(result.duration);
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
