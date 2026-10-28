import { test, expect, type APIRequestContext } from './fixtures';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import { parseRunToHub } from '@piwitests/core/run-channel';
import { PROJECT } from '#shared/test-project-names';
import { resolveE2ETarget } from './desktop-target';

/**
 * The run page's live view against this server: a real Playwright run through the built reporter, in a project with
 * the live view on, shows **Watch** beside its running test; Watch shows the test's page, with the call each image
 * was taken at; a test stopped by `page.pause()` (the editor's run channel holds it) shows **Paused**. In a project
 * with the live view off, the same run's workers send this server nothing.
 */

const target = resolveE2ETarget();
const reporter = resolve(process.cwd(), '..', '..', 'packages', 'reporter', 'dist', 'index.js');
const REF = 'ed-11ve0e2e';
const TOKEN = 'live-view-e2e-token-0123456789';
const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');

/** A slow page: a spinner that never stops, and a heading the test clicks. */
const SLOW_PAGE = `<style>body { font: 16px sans-serif; padding: 24px } #spin { width: 96px; height: 96px; border: 12px solid #ddd; border-top-color: #7c3aed; border-radius: 50%; animation: s 1s linear infinite } @keyframes s { to { transform: rotate(360deg) } }</style><h1>Checkout</h1><p>Paying…</p><div id="spin"></div>`;

/** The suite the run executes: a test that waits on its slow page until told, then one that stops at `page.pause()`. */
const SPEC = (folder: string) => `const fs = require('node:fs');
const { test, expect } = require('./fixture.cjs');
test('pays on a slow page', async ({ page }) => {
  await page.setContent(${JSON.stringify(SLOW_PAGE)});
  await page.getByRole('heading', { name: 'Checkout' }).click();
  await expect.poll(() => fs.existsSync(${JSON.stringify(join(folder, 'watched'))}), { timeout: 90000 }).toBe(true);
});
test('stops to look', async ({ page }) => {
  await page.setContent('<h1>Receipt</h1>');
  await page.pause();
  await expect(page.getByRole('heading')).toHaveText('Receipt');
});
`;

interface Run {
  folder: string;
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
  hub: net.Server;
  /** Resume the stop the editor's run channel holds, once there is one. */
  resume: () => Promise<void>;
}

/** Start the suite as a project's run, against this server, with an editor's run channel that holds its stops. */
async function startRun(projectName: string): Promise<Run> {
  fs.mkdirSync(join(process.cwd(), '.test-temp'), { recursive: true });
  const folder = fs.mkdtempSync(join(process.cwd(), '.test-temp', 'live-view-'));
  const socketDir = fs.mkdtempSync(join(os.tmpdir(), 'piwi-live-e2e-'));
  const socketPath = join(socketDir, 'channel.sock');
  let held: { socket: net.Socket; stop: number } | null = null;
  const hub = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on(
      'data',
      lineReader(
        (line) => {
          const message = parseRunToHub(line);
          if (message?.type === 'stopped') held = { socket, stop: message.stop };
        },
        () => socket.destroy(),
      ),
    );
  });
  await new Promise<void>((done) => hub.listen(socketPath, done));
  fs.writeFileSync(join(folder, 'live.spec.cjs'), SPEC(folder));
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
  timeout: 120000,
  workers: 1,
  reporter: 'line',
  use: { headless: true, viewport: { width: 1000, height: 625 } },
}), { serverUrl: ${JSON.stringify(target.baseUrl)}, projectName: ${JSON.stringify(projectName)}, uploadTraces: false, uploadReport: false });
`,
  );
  const channel = formatRecordChannel({ path: socketPath, token: TOKEN });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_RUN_CHANNEL: channel,
    PIWI_RECORD_CHANNEL: channel,
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: REF,
  };
  // The editor's stops never hold under CI; the run reports where the config says.
  for (const name of ['CI', 'PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_API_KEY', 'PIWI_PROJECT_NAME', 'PIWI_LIVE_VIEW']) {
    delete env[name];
  }
  let output = '';
  const child = spawn(process.execPath, [playwrightCli, 'test'], { cwd: folder, env });
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  return {
    folder,
    child,
    exited,
    output: () => output,
    hub,
    resume: async () => {
      await expect.poll(() => held !== null, { timeout: 60_000 }).toBe(true);
      held!.socket.write(`${JSON.stringify({ type: 'control', action: 'resume', stop: held!.stop })}\n`);
    },
  };
}

async function endRun(run: Run): Promise<void> {
  if (run.child.exitCode === null) run.child.kill();
  await new Promise<void>((done) => run.hub.close(() => done()));
  fs.rmSync(run.folder, { recursive: true, force: true });
}

/** The id of a project, made by reporting an empty run when it does not exist yet. */
async function projectId(request: APIRequestContext, name: string): Promise<number> {
  const submitted = await request.post('/api/test-runs/submit', {
    data: {
      projectName: name,
      status: 'passed',
      startTime: new Date().toISOString(),
      duration: 1,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      skippedTests: 0,
      testCases: [],
    },
  });
  expect(submitted.ok()).toBeTruthy();
  const { runId } = (await submitted.json()) as { runId: number };
  const run = (await (await request.get(`/api/test-runs/${runId}`)).json()) as { projectId: number };
  return run.projectId;
}

/** The run of the project that is live now. */
async function liveRunId(request: APIRequestContext, project: number, after: number): Promise<number> {
  let id = 0;
  await expect
    .poll(
      async () => {
        const latest = (await (await request.get(`/api/projects/${project}/latest-run`)).json()) as {
          id: number;
          status: string;
        } | null;
        id = latest && latest.id > after && latest.status === 'running' ? latest.id : 0;
        return id;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  return id;
}

test.describe('Live view of a run', () => {
  test.skip(target.desktop, 'the desktop app guards every route with its token, which a test worker does not hold');
  test.describe.configure({ mode: 'serial' });

  test('Watch shows the page of a running test with its call, and Paused a test stopped by page.pause()', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(240_000);
    const project = await projectId(request, PROJECT.LIVE_VIEW_ON);
    const patched = await request.patch(`/api/projects/${project}`, { data: { liveView: true } });
    expect(patched.ok()).toBeTruthy();
    const before = ((await (await request.get(`/api/projects/${project}/latest-run`)).json()) as { id: number }).id;

    const run = await startRun(PROJECT.LIVE_VIEW_ON);
    try {
      const runId = await liveRunId(request, project, before);
      await page.goto(`/test-runs/${runId}`);

      const watch = page.getByRole('button', { name: /^Watch worker \d+ live$/ });
      await expect(watch).toBeVisible({ timeout: 60_000 });
      await page.screenshot({ path: testInfo.outputPath('live-view-row.png') });
      await watch.click();
      const view = page.getByRole('dialog');
      await expect(view).toContainText('pays on a slow page');
      const frame = view.getByTestId('live-frame');
      await expect(frame).toBeVisible({ timeout: 20_000 });
      await expect(frame).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
      await expect(view.getByTestId('live-call')).toContainText('live.spec.cjs');
      // The image is the page as it paints: a spinner turns, so the image changes.
      const first = await frame.getAttribute('src');
      await expect.poll(() => frame.getAttribute('src'), { timeout: 10_000 }).not.toBe(first);
      await page.screenshot({ path: testInfo.outputPath('live-view-watch.png') });
      const wide = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath('live-view-watch-narrow.png') });
      await page.setViewportSize(wide);

      type Live = { enabled: boolean; workers: Array<{ worker: number }>; received: { frames: number; bytes: number } };
      const workers = async () =>
        (await (await request.get(`/api/test-runs/${runId}/live-view/workers`)).json()) as Live;
      const from = await workers();
      const startedAt = Date.now();
      await page.waitForTimeout(3000);
      const live = await workers();
      const seconds = (Date.now() - startedAt) / 1000;
      const frames = live.received.frames - from.received.frames;
      const bytes = live.received.bytes - from.received.bytes;
      console.log(
        `[live view] ${frames} frames in ${seconds.toFixed(1)} s: ${(frames / seconds).toFixed(1)} a second, ` +
          `${Math.round(bytes / Math.max(1, frames) / 1024)} KB a frame, ${Math.round(bytes / seconds / 1024)} KB a second`,
      );
      expect(live.enabled).toBe(true);
      expect(live.workers).toHaveLength(1);
      expect(frames).toBeGreaterThan(1);
      expect(frames / seconds).toBeLessThanOrEqual(4.5);

      // The test ends: so does its view.
      fs.writeFileSync(join(run.folder, 'watched'), '');
      await expect(view.getByTestId('live-status')).toHaveText('The test ended.', { timeout: 20_000 });
      await page.keyboard.press('Escape');
      await expect(view).toBeHidden();

      // The next test stops at page.pause(): its row says it is paused, at that call.
      const paused = page.getByTestId('live-paused');
      await expect(paused).toBeVisible({ timeout: 60_000 });
      // On the stopped test's row, not on the row of the test before it, whose end may stream in later.
      const row = paused.locator(
        'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " border-b ")][1]',
      );
      await expect(row).toContainText('stops to look');
      await expect(paused).toContainText('Paused');
      await expect(paused).toContainText('live.spec.cjs:10');
      await page.screenshot({ path: testInfo.outputPath('live-view-paused.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath('live-view-paused-narrow.png') });
      await page.setViewportSize(wide);
      await run.resume();
      await expect(paused).toBeHidden({ timeout: 30_000 });

      expect(await run.exited, run.output()).toBe(0);
      expect(run.output()).toContain('Live view on');
    } finally {
      await endRun(run);
    }
  });

  test('a project with the live view off: no Watch, and its run sends nothing', async ({ page, request }) => {
    test.setTimeout(240_000);
    const project = await projectId(request, PROJECT.LIVE_VIEW_OFF);
    const before = ((await (await request.get(`/api/projects/${project}/latest-run`)).json()) as { id: number }).id;
    const run = await startRun(PROJECT.LIVE_VIEW_OFF);
    try {
      const runId = await liveRunId(request, project, before);
      await page.goto(`/test-runs/${runId}`);
      await expect(page.getByTestId('live-step').or(page.getByText('In progress…')).first()).toBeVisible({
        timeout: 60_000,
      });
      // While the test runs on its slow page, nothing offers to watch it, and nothing reached this server.
      await page.waitForTimeout(3000);
      await expect(page.getByRole('button', { name: /^Watch worker/ })).toHaveCount(0);
      expect(await (await request.get(`/api/test-runs/${runId}/live-view/workers`)).json()).toEqual({
        enabled: false,
        workers: [],
        received: { requests: 0, frames: 0, bytes: 0 },
      });
      const refused = await request.get(`/api/test-runs/${runId}/live-view/watch?worker=0`);
      expect(refused.status()).toBe(404);

      fs.writeFileSync(join(run.folder, 'watched'), '');
      await run.resume();
      expect(await run.exited, run.output()).toBe(0);
      expect(run.output()).not.toContain('Live view on');
      const after = (await (await request.get(`/api/test-runs/${runId}/live-view/workers`)).json()) as {
        received: { requests: number };
      };
      expect(after.received.requests).toBe(0);
    } finally {
      await endRun(run);
    }
  });
});
