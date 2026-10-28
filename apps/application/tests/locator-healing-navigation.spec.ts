import { test, expect, type APIRequestContext } from './fixtures';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { detectCi } from '../../../packages/reporter/src/internal/support/ci';
import { PROJECT } from '#shared/test-project-names';
import type { LocatorHealingResult } from '#shared/locator-healing.types';
import { resolveE2ETarget } from './desktop-target';

/**
 * Locator healing for a click that navigates at once, through the built reporter against this server: a passing run
 * clicks **Place order**, whose form submits and leaves the page, and keeps the button it clicked; the next run, with
 * the button renamed **Confirm order**, fails on the same click, and healing offers the renamed button.
 */

const target = resolveE2ETarget();
const reporter = resolve(process.cwd(), '..', '..', 'packages', 'reporter', 'dist', 'index.js');
const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');

/** The shop's checkout, whose button the run names. */
const checkout = (button: string) => `<!doctype html><title>checkout</title>
<form action="/done"><label>Coupon <input name="coupon"></label><button>${button}</button></form>`;

const SPEC = (base: string) => `const { test, expect } = require('./fixture.cjs');
test('places the order', async ({ page }) => {
  await page.goto('${base}/checkout');
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveTitle('done');
});
`;

/** Run the suite as the project's run against this server; resolves with its exit code and output. */
async function runSuite(folder: string): Promise<{ code: number | null; output: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_API_KEY', 'PIWI_PROJECT_NAME', 'PIWI_LIVE_VIEW']) {
    delete env[name];
  }
  for (const name of Object.keys(env)) if (detectCi({ [name]: env[name] })) delete env[name];
  let output = '';
  const child = spawn(process.execPath, [playwrightCli, 'test'], { cwd: folder, env });
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  const code = await new Promise<number | null>((done) => child.on('exit', done));
  return { code, output };
}

/** The executions of the project's latest run, by title. */
async function latestCases(
  request: APIRequestContext,
): Promise<Array<{ title: string; status: string; executionId: number }>> {
  const { items } = (await (await request.get('/api/projects')).json()) as {
    items: Array<{ id: number; name: string }>;
  };
  const project = items.find((p) => p.name === PROJECT.LOCATOR_HEAL_NAVIGATION);
  expect(project, 'the run created its project').toBeTruthy();
  const latest = (await (await request.get(`/api/projects/${project!.id}/latest-run`)).json()) as { id: number };
  const run = (await (await request.get(`/api/test-runs/${latest.id}`)).json()) as {
    testCases: Array<{ title: string; status: string; executionId: number }>;
  };
  return run.testCases;
}

test('healing offers the renamed button of a click that navigated at once', async ({ request }) => {
  test.setTimeout(180_000);
  let button = 'Place order';
  const shop = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url?.startsWith('/done') ? '<!doctype html><title>done</title><h1>Thank you</h1>' : checkout(button));
  });
  await new Promise<void>((done) => shop.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(shop.address() as AddressInfo).port}`;

  fs.mkdirSync(join(process.cwd(), '.test-temp'), { recursive: true });
  const folder = fs.mkdtempSync(join(process.cwd(), '.test-temp', 'locator-heal-navigation-'));
  try {
    fs.writeFileSync(join(folder, 'checkout.spec.cjs'), SPEC(base));
    fs.writeFileSync(
      join(folder, 'fixture.cjs'),
      `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(reporter)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
    );
    fs.writeFileSync(
      join(folder, 'playwright.config.cjs'),
      `const { defineConfig } = require('@playwright/test');
const { wrapConfig } = require(${JSON.stringify(reporter)});
module.exports = wrapConfig(defineConfig({
  testDir: '.',
  outputDir: './test-results',
  timeout: 30000,
  workers: 1,
  reporter: 'line',
  use: { headless: true, actionTimeout: 3000 },
}), { serverUrl: ${JSON.stringify(target.baseUrl)}, projectName: ${JSON.stringify(PROJECT.LOCATOR_HEAL_NAVIGATION)}, uploadTraces: false, uploadReport: false });
`,
    );

    const passed = await runSuite(folder);
    expect(passed.code, passed.output).toBe(0);

    button = 'Confirm order';
    const failed = await runSuite(folder);
    expect(failed.code, failed.output).not.toBe(0);

    const cases = await latestCases(request);
    const failing = cases.find((c) => c.title === 'places the order');
    expect(failing?.status).toBe('failed');

    const healing = (await (
      await request.get(`/api/test-run-cases/${failing!.executionId}/locator-healing`)
    ).json()) as LocatorHealingResult;
    // The passing run kept the button it clicked, so healing finds it on the failing page under its new name.
    expect(healing.source).toBe('element-match');
    expect(healing.fromElementMatch?.map((a) => a.locator)).toContain("getByRole('button', { name: 'Confirm order' })");
    expect(healing.recommendation?.recommended?.locator).toBe("getByRole('button', { name: 'Confirm order' })");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
    await new Promise<void>((done) => shop.close(() => done()));
  }
});
