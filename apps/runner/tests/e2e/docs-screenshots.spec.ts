import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { VIEWER, hubRun, playShell, root, runRequest } from './shell';

/**
 * Piwi Runner's window on its docs page (`apps/docs/features/piwi-runner.md`), in English, at its default width and at
 * 2×: its runs (one going on with its worker live, one that failed with its output, one that passed) and its settings.
 * Skipped unless `PIWI_DOCS_SHOTS=1`; recapture with `PIWI_DOCS_SHOTS=1 npm run runner:e2e -- docs-screenshots`, after
 * `npm run runner:window`. The harness in `apps/application/scripts/take-feature-screenshots.mjs` lists the
 * `runner-*.png` images as external so `--check` leaves them alone.
 */

const SCREENSHOTS = path.join(root, 'apps', 'docs', 'public', 'screenshots');
const ESC = '\u001b';
/** The output of a run of two tests, the second failing, with Playwright's colors. */
const FAILED_OUTPUT = [
  'Running 2 tests using 1 worker',
  '',
  `  ${ESC}[32m✓${ESC}[39m  1 ${ESC}[2m[chromium] › tests/cart.spec.ts:12:3 › cart › removes an item${ESC}[22m ${ESC}[2m(1.4s)${ESC}[22m`,
  `  ${ESC}[31m✘${ESC}[39m  2 ${ESC}[2m[chromium] › tests/cart.spec.ts:30:3 › cart › applies a coupon${ESC}[22m ${ESC}[2m(5.1s)${ESC}[22m`,
  '',
  '  1) [chromium] › tests/cart.spec.ts:30:3 › cart › applies a coupon',
  '',
  `    Error: ${ESC}[2mexpect(${ESC}[22m${ESC}[31mlocator${ESC}[39m${ESC}[2m).${ESC}[22mtoHaveText${ESC}[2m(${ESC}[22m${ESC}[32mexpected${ESC}[39m${ESC}[2m)${ESC}[22m failed`,
  '',
  `    Expected: ${ESC}[32m"Total: $45.00"${ESC}[39m`,
  `    Received: ${ESC}[31m"Total: $50.00"${ESC}[39m`,
  '',
  `  ${ESC}[31m1 failed${ESC}[39m`,
  `  ${ESC}[32m1 passed${ESC}[39m ${ESC}[2m(7.9s)${ESC}[22m`,
];
const PASSED_OUTPUT = ['Running 1 test using 1 worker', '', `  ${ESC}[32m1 passed${ESC}[39m ${ESC}[2m(2.2s)${ESC}[22m`];

const CART_TESTS = [
  { title: 'cart › removes an item', filePath: 'tests/cart.spec.ts', line: 12, projectName: 'chromium' },
  { title: 'cart › applies a coupon', filePath: 'tests/cart.spec.ts', line: 30, projectName: 'chromium' },
];
const SEARCH_TEST = [
  { title: 'search › finds a product by name', filePath: 'tests/search.spec.ts', line: 8, projectName: 'chromium' },
];

test.skip(!process.env.PIWI_DOCS_SHOTS, 'captures docs illustrations only when PIWI_DOCS_SHOTS=1');
test.use({ viewport: { width: 960, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
/** How long the folds' and the tabs' transitions take, on the page's own clock. */
const SETTLE_MS = 400;

/** Confirms a request for `tests`, which the window starts as the shell's next run. */
async function confirm(page: Page, id: string, tests?: typeof CART_TESTS): Promise<void> {
  const request = { ...runRequest(id, null), ...(tests ? { tests } : {}) };
  await page.evaluate((sent) => window.__events.send('host', { type: 'run-request', request: sent }), request);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.clock.fastForward(1_100);
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** The shell's output of run `id`, then its exit after `ms`. */
async function finish(page: Page, id: number, lines: string[], code: number, ms: number): Promise<void> {
  for (const line of lines) {
    await page.evaluate((event) => window.__events.emit('piwi:local-run', event), { id, kind: 'stdout', line });
  }
  await page.clock.fastForward(ms);
  await page.evaluate((event) => window.__events.emit('piwi:local-run', event), { id, kind: 'exit', code });
}

test('the runs and the settings, for the docs', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-18T14:02:00') });
  await playShell(page, 'en');
  await page.goto('/');
  await expect(page.getByTestId('runner-header')).toContainText('Connected to piwi.example.com');

  await confirm(page, 'r1', SEARCH_TEST);
  await finish(page, 1, PASSED_OUTPUT, 0, 31_000);
  await confirm(page, 'r2', CART_TESTS);
  await finish(page, 2, FAILED_OUTPUT, 1, 52_000);
  await confirm(page, 'r3');
  await page.evaluate((viewer) => window.__events.send('hub', { type: 'hello', viewer }), VIEWER);
  await page.evaluate((event) => window.__events.send('hub', event), hubRun('desktop-3', { stopped: false }));
  await page.clock.fastForward(24_000);

  // The run that passed folded, the one that failed open with its output.
  const passed = page.getByTestId('runner-finished').locator('[data-status="passed"]');
  await passed.getByRole('button', { name: 'search › finds a product by name' }).click();
  await expect(
    page.getByTestId('runner-finished').locator('[data-status="failed"] [data-testid="run-output"]'),
  ).toBeVisible();
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: path.join(SCREENSHOTS, 'runner-runs.png') });

  await page.getByTestId('runner-status').click();
  await expect(page.getByTestId('runner-connection')).toBeVisible();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({
    path: path.join(SCREENSHOTS, 'runner-settings.png'),
    clip: { x: 0, y: 0, width: 960, height: 560 },
  });
});
