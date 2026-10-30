import { test, expect, type APIRequestContext } from './fixtures';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import type { LiveStop } from '@piwitests/core/live-view';
import { parseRunToHub, type RunToHub } from '@piwitests/core/run-channel';
import { detectCi } from '../../../packages/reporter/src/internal/support/ci';
import { PROJECT } from '#shared/test-project-names';
import { resolveE2ETarget } from './desktop-target';
import { holdWorkerStream } from './utils/live-view';

/**
 * The run page's live view against this server. A real CI run through the built reporter, in a project with the live
 * view on, shows **Watch** beside its running test; Watch shows the test's page, with the call each image was taken
 * at. In a project with the live view off, and for a run outside CI nobody shared, the run's workers send this server
 * nothing; a run outside CI its editor shares (Share live, played by this spec on the run channel) shows Watch, and
 * its view ends, saying why, as the sharing stops. A worker of the run's live view, played by this spec, shows
 * **Paused** on the row of the test it stopped, at its call, and Watch on the test it runs alone; both leave every row
 * as the project turns the live view off.
 */

const target = resolveE2ETarget();
const reporter = resolve(process.cwd(), '..', '..', 'packages', 'reporter', 'dist', 'index.js');
const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');

/** A slow page: a spinner that never stops, a heading the test clicks, and a Pay button that stays disabled. */
const SLOW_PAGE = `<style>body { font: 16px sans-serif; padding: 24px } #spin { width: 96px; height: 96px; border: 12px solid #ddd; border-top-color: #7c3aed; border-radius: 50%; animation: s 1s linear infinite } @keyframes s { to { transform: rotate(360deg) } }</style><h1>Checkout</h1><p>Paying…</p><div id="spin"></div><button disabled>Pay</button>`;

/**
 * The suite the run executes: a test that waits on its slow page until told, trying meanwhile to click its disabled
 * Pay button, so the live view's call log says why the click waits.
 */
const SPEC = (folder: string) => `const fs = require('node:fs');
const { test, expect } = require('./fixture.cjs');
test('pays on a slow page', async ({ page }) => {
  await page.setContent(${JSON.stringify(SLOW_PAGE)});
  await page.getByRole('heading', { name: 'Checkout' }).click();
  const released = () => fs.existsSync(${JSON.stringify(join(folder, 'watched'))});
  const until = Date.now() + 90000;
  while (!released() && Date.now() < until) {
    await page.getByRole('button', { name: 'Pay' }).click({ timeout: 2500 }).catch(() => {});
  }
  expect(released()).toBe(true);
});
`;

interface Run {
  folder: string;
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
  /** Let the test go on, past its slow page. */
  release: () => void;
}

/** Start the suite as a project's run against this server, in a CI job or outside one, `extra` in its environment. */
async function startRun(projectName: string, ci: boolean, extra: NodeJS.ProcessEnv = {}): Promise<Run> {
  fs.mkdirSync(join(process.cwd(), '.test-temp'), { recursive: true });
  const folder = fs.mkdtempSync(join(process.cwd(), '.test-temp', 'live-view-'));
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
  // The run reports where the config says; it is a CI run, or no variable a CI provider sets is left.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_API_KEY', 'PIWI_PROJECT_NAME', 'PIWI_LIVE_VIEW']) {
    delete env[name];
  }
  for (const name of Object.keys(env)) if (detectCi({ [name]: env[name] })) delete env[name];
  if (ci) env.CI = 'true';
  Object.assign(env, extra);
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
    release: () => fs.writeFileSync(join(folder, 'watched'), ''),
  };
}

async function endRun(run: Run): Promise<void> {
  if (run.child.exitCode === null) run.child.kill();
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

async function latestRunId(request: APIRequestContext, project: number): Promise<number> {
  return ((await (await request.get(`/api/projects/${project}/latest-run`)).json()) as { id: number }).id;
}

type Workers = { enabled: boolean; workers: Array<{ worker: number }>; received: Record<string, number> };

async function liveWorkers(request: APIRequestContext, runId: number): Promise<Workers> {
  return (await (await request.get(`/api/test-runs/${runId}/live-view/workers`)).json()) as Workers;
}

/**
 * The editor's side of a run channel, as Share live drives it: it shares the run as each worker attaches, and keeps
 * how each worker says the run stands on the instance (`live`).
 */
async function startShareHub(): Promise<{
  env: NodeJS.ProcessEnv;
  heard: () => Array<Extract<RunToHub, { type: 'live' }>>;
  share: (on: boolean) => void;
  close: () => Promise<void>;
}> {
  const folder = fs.mkdtempSync(join(os.tmpdir(), 'piwi-share-'));
  const path = join(folder, 'channel.sock');
  const sockets: net.Socket[] = [];
  const lives: Array<Extract<RunToHub, { type: 'live' }>> = [];
  const send = (socket: net.Socket, message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on(
      'data',
      lineReader(
        (line) => {
          const message = parseRunToHub(line);
          if (message?.type === 'run-attach') send(socket, { type: 'share', on: true });
          if (message?.type === 'live') lives.push(message);
        },
        () => socket.destroy(),
      ),
    );
  });
  await new Promise<void>((done) => server.listen(path, done));
  return {
    env: {
      PIWI_RUN_CHANNEL: formatRecordChannel({ path, token: 'share-live-token-0123456789' }),
      PIWI_RUN_REF: 'ed-share',
    },
    heard: () => lives,
    share: (on) => sockets.forEach((socket) => send(socket, { type: 'share', on })),
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((done) => server.close(() => done()));
      fs.rmSync(folder, { recursive: true, force: true });
    },
  };
}

test.describe('Live view of a run', () => {
  test.skip(target.desktop, 'the desktop app guards every route with its token, which a test worker does not hold');
  test.describe.configure({ mode: 'serial' });

  test('Watch shows the page of a running CI test with its call', async ({ page, request }, testInfo) => {
    test.setTimeout(240_000);
    const project = await projectId(request, PROJECT.LIVE_VIEW_ON);
    const patched = await request.patch(`/api/projects/${project}`, { data: { liveView: true } });
    expect(patched.ok()).toBeTruthy();
    const before = await latestRunId(request, project);

    const run = await startRun(PROJECT.LIVE_VIEW_ON, true);
    try {
      const runId = await liveRunId(request, project, before);
      await page.goto(`/test-runs/${runId}`);

      const watch = page.getByRole('button', { name: /^Watch worker \d+ live$/ });
      await expect(watch).toBeVisible({ timeout: 60_000 });
      // A CI run's workers join at once: nothing says it is not shared.
      await expect(page.getByTestId('live-unshared')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('live-view-row.png') });
      await watch.click();
      const view = page.getByRole('dialog');
      await expect(view).toContainText('pays on a slow page');
      await expect(view.getByRole('heading', { name: /^Worker \d+ · live$/ })).toBeVisible();
      const frame = view.getByTestId('live-frame');
      await expect(frame).toBeVisible({ timeout: 20_000 });
      await expect(frame).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
      // The call's place opens in the editor.
      await expect(view.getByTestId('live-call').getByText(/^live\.spec\.cjs:\d+$/)).toBeVisible();
      // A CI run's call log says why the click waits, and the element it waits on is outlined on the image.
      await expect(view.getByTestId('live-call')).toContainText("Click getByRole('button', { name: 'Pay' })", {
        timeout: 20_000,
      });
      await expect(view.getByTestId('live-call-log')).toContainText('element is not enabled', { timeout: 20_000 });
      await expect(view.getByTestId('live-call-target')).toHaveText('Its element is not enabled', { timeout: 20_000 });
      await expect(view.getByTestId('live-call-state')).toContainText('Running for');
      await expect(view.getByTestId('live-target-box')).toBeAttached();
      // The status region stays in the page, empty while images show.
      await expect(view.getByRole('status')).toHaveText('');
      // The image is the page as it paints: a spinner turns, so the image changes.
      const first = await frame.getAttribute('src');
      await expect.poll(() => frame.getAttribute('src'), { timeout: 10_000 }).not.toBe(first);
      await page.screenshot({ path: testInfo.outputPath('live-view-watch.png') });
      const wide = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath('live-view-watch-narrow.png') });
      await page.setViewportSize(wide);

      const from = await liveWorkers(request, runId);
      const startedAt = Date.now();
      await page.waitForTimeout(3000);
      const live = await liveWorkers(request, runId);
      const seconds = (Date.now() - startedAt) / 1000;
      const frames = live.received.frames! - from.received.frames!;
      const bytes = live.received.bytes! - from.received.bytes!;
      console.log(
        `[live view] ${frames} frames in ${seconds.toFixed(1)} s: ${(frames / seconds).toFixed(1)} a second, ` +
          `${Math.round(bytes / Math.max(1, frames) / 1024)} KB a frame, ${Math.round(bytes / seconds / 1024)} KB a second`,
      );
      expect(live.enabled).toBe(true);
      expect(live.workers).toHaveLength(1);
      expect(frames).toBeGreaterThan(1);
      expect(frames / seconds).toBeLessThanOrEqual(4.5);

      // The test ends: so does its view.
      run.release();
      await expect(view.getByTestId('live-status')).toHaveText('The test ended.', { timeout: 20_000 });
      await page.keyboard.press('Escape');
      await expect(view).toBeHidden();

      expect(await run.exited, run.output()).toBe(0);
      expect(run.output()).toContain('Live view on');
    } finally {
      await endRun(run);
    }
  });

  test('a project with the live view off: no Watch, and its CI run sends nothing', async ({ page, request }) => {
    test.setTimeout(240_000);
    const project = await projectId(request, PROJECT.LIVE_VIEW_OFF);
    const before = await latestRunId(request, project);
    const run = await startRun(PROJECT.LIVE_VIEW_OFF, true);
    try {
      const runId = await liveRunId(request, project, before);
      await page.goto(`/test-runs/${runId}`);
      await expect(page.getByTestId('live-step').or(page.getByText('In progress…')).first()).toBeVisible({
        timeout: 60_000,
      });
      // While the test runs on its slow page, nothing offers to watch it, and nothing reached this server.
      await page.waitForTimeout(3000);
      await expect(page.getByRole('button', { name: /^Watch worker/ })).toHaveCount(0);
      await expect(page.getByTestId('live-unshared')).toHaveCount(0);
      expect(await liveWorkers(request, runId)).toEqual({
        enabled: false,
        workers: [],
        received: { requests: 0, frames: 0, bytes: 0 },
      });
      const refused = await request.get(`/api/test-runs/${runId}/live-view/watch?worker=0`);
      expect(refused.status()).toBe(404);

      run.release();
      expect(await run.exited, run.output()).toBe(0);
      expect(run.output()).not.toContain('Live view on');
      expect((await liveWorkers(request, runId)).received.requests).toBe(0);
    } finally {
      await endRun(run);
    }
  });

  test('a run outside CI nobody shares, in a project with the live view on, says how to share it and sends nothing', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(240_000);
    const project = await projectId(request, PROJECT.LIVE_VIEW_ON);
    expect((await request.patch(`/api/projects/${project}`, { data: { liveView: true } })).ok()).toBeTruthy();
    const before = await latestRunId(request, project);
    const run = await startRun(PROJECT.LIVE_VIEW_ON, false);
    try {
      const runId = await liveRunId(request, project, before);
      await page.goto(`/test-runs/${runId}`);
      await expect(page.getByTestId('live-step').or(page.getByText('In progress…')).first()).toBeVisible({
        timeout: 60_000,
      });
      await page.waitForTimeout(3000);
      await expect(page.getByRole('button', { name: /^Watch worker/ })).toHaveCount(0);
      // Its running row says it is not shared, where Watch would be, and how to share it.
      const unshared = page.getByTestId('live-unshared');
      await expect(unshared).toHaveText('Not shared live');
      await page.screenshot({ path: testInfo.outputPath('live-view-unshared.png') });
      const wide = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(unshared).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('live-view-unshared-narrow.png') });
      await page.setViewportSize(wide);
      await unshared.getByRole('button').click();
      const hint = page.getByRole('dialog');
      await expect(hint).toContainText('Tools → Piwi → Share the Run Live');
      await expect(hint).toContainText('Piwi: Share the run live on the team instance');
      await page.screenshot({ path: testInfo.outputPath('live-view-unshared-hint.png') });
      await page.keyboard.press('Escape');
      expect(await liveWorkers(request, runId)).toMatchObject({
        enabled: true,
        workers: [],
        received: { requests: 0, frames: 0, bytes: 0 },
      });
      // Turned off, the project's live view no longer applies to the run: nothing says to share it.
      expect((await request.patch(`/api/projects/${project}`, { data: { liveView: false } })).ok()).toBeTruthy();
      await expect(unshared).toHaveCount(0, { timeout: 10_000 });

      run.release();
      expect(await run.exited, run.output()).toBe(0);
      expect(run.output()).not.toContain('Live view on');
      expect((await liveWorkers(request, runId)).received.requests).toBe(0);
    } finally {
      await request.patch(`/api/projects/${project}`, { data: { liveView: true } });
      await endRun(run);
    }
  });

  test('a run outside CI its editor shares shows Watch, and its view ends, saying why, as the sharing stops', async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const project = await projectId(request, PROJECT.LIVE_VIEW_ON);
    expect((await request.patch(`/api/projects/${project}`, { data: { liveView: true } })).ok()).toBeTruthy();
    const before = await latestRunId(request, project);
    const hub = await startShareHub();
    const run = await startRun(PROJECT.LIVE_VIEW_ON, false, hub.env);
    try {
      const runId = await liveRunId(request, project, before);
      // Its worker says the run can be shared, with its page on this server, and shares it as the editor asks.
      await expect.poll(() => hub.heard().some((live) => live.on), { timeout: 60_000 }).toBe(true);
      expect(hub.heard().at(-1)).toMatchObject({
        can: true,
        page: expect.stringMatching(new RegExp(`/test-runs/${runId}$`)),
      });
      await page.goto(`/test-runs/${runId}`);
      const watch = page.getByRole('button', { name: /^Watch worker \d+ live$/ });
      await expect(watch).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('live-unshared')).toHaveCount(0);
      await watch.click();
      const view = page.getByRole('dialog');
      await expect(view.getByTestId('live-frame')).toBeVisible({ timeout: 20_000 });
      // The editor hears someone watches.
      await expect.poll(() => hub.heard().at(-1)?.viewers, { timeout: 10_000 }).toBe(1);

      hub.share(false);
      await expect(view.getByTestId('live-status')).toHaveText(
        'The developer stopped sharing this run from their machine.',
        { timeout: 20_000 },
      );
      await page.keyboard.press('Escape');
      await expect(watch).toHaveCount(0, { timeout: 10_000 });
      // No longer shared, its running row says so again.
      await expect(page.getByTestId('live-unshared')).toHaveText('Not shared live');
      await expect.poll(async () => (await liveWorkers(request, runId)).workers.length).toBe(0);

      run.release();
      expect(await run.exited, run.output()).toBe(0);
      expect(run.output()).toContain('Live view ready');
    } finally {
      await endRun(run);
      await hub.close();
    }
  });

  test('a run outside CI its editor shares hears its sharing stopped as the project turns its live view off', async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const project = await projectId(request, PROJECT.LIVE_VIEW_ON);
    expect((await request.patch(`/api/projects/${project}`, { data: { liveView: true } })).ok()).toBeTruthy();
    const before = await latestRunId(request, project);
    const hub = await startShareHub();
    const run = await startRun(PROJECT.LIVE_VIEW_ON, false, hub.env);
    try {
      const runId = await liveRunId(request, project, before);
      await expect.poll(() => hub.heard().some((live) => live.on), { timeout: 60_000 }).toBe(true);
      await expect.poll(async () => (await liveWorkers(request, runId)).workers.length, { timeout: 20_000 }).toBe(1);
      expect((await request.patch(`/api/projects/${project}`, { data: { liveView: false } })).ok()).toBeTruthy();
      // Its worker opens its stream again and hears the setting is off: not that its key is unknown.
      await expect
        .poll(() => hub.heard().at(-1), { timeout: 20_000 })
        .toMatchObject({
          can: false,
          on: false,
          why: "Sharing stopped: the project's live view was turned off on the instance.",
        });
      run.release();
      expect(await run.exited, run.output()).toBe(0);
    } finally {
      await request.patch(`/api/projects/${project}`, { data: { liveView: true } });
      await endRun(run);
      await hub.close();
    }
  });

  test('Paused shows on the stopped test’s row at its call, and leaves every row as the setting turns off', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    const project = await projectId(request, PROJECT.LIVE_VIEW_ON);
    expect((await request.patch(`/api/projects/${project}`, { data: { liveView: true } })).ok()).toBeTruthy();

    // A CI run's setup, as the reporter's global setup asks for it, and its begin.
    const setup = await request.post('/api/test-runs/setup', {
      data: { projectName: PROJECT.LIVE_VIEW_ON, startTime: new Date().toISOString(), liveView: true },
    });
    expect(setup.ok()).toBeTruthy();
    const { runId, setupToken, liveView } = (await setup.json()) as {
      runId: number;
      setupToken: string;
      liveView: { key: string };
    };
    const begun = await request.post(`/api/test-runs/${runId}/begin`, { data: { setupToken, totalTests: 2 } });
    expect(begun.ok()).toBeTruthy();
    const { streamToken } = (await begun.json()) as { streamToken: string };
    // Worker 0 ran a test whose end has not streamed in yet, and runs the next one now.
    const now = Date.now();
    const events = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: [
          {
            type: 'begin',
            title: 'pays on a slow page',
            location: 'tests/live.spec.ts:3:1',
            workerIndex: 0,
            startedAt: now - 2000,
          },
          {
            type: 'begin',
            title: 'stops to look',
            location: 'tests/live.spec.ts:8:1',
            workerIndex: 0,
            startedAt: now - 1000,
          },
        ],
      },
    });
    expect(events.ok()).toBeTruthy();

    const worker = holdWorkerStream(target.baseUrl, runId, liveView.key);
    const post = (message: Record<string, unknown>) =>
      request.post(`/api/test-runs/${runId}/live-view`, {
        headers: { Authorization: `Bearer ${liveView.key}` },
        data: { shard: null, worker: 0, ...message },
      });
    const stop: LiveStop = {
      reason: 'page-pause',
      call: { title: 'Pause', file: 'tests/live.spec.ts', line: 10 },
      test: 'stops to look',
    };
    try {
      await expect.poll(async () => (await liveWorkers(request, runId)).workers.length).toBe(1);
      expect((await post({ type: 'stop', stop })).ok()).toBeTruthy();
      await page.goto(`/test-runs/${runId}`);

      const paused = page.getByTestId('live-paused');
      await expect(paused).toBeVisible({ timeout: 30_000 });
      // On the stopped test's row, which alone offers Watch: the row of the test before is not the worker's now.
      const rowOf = (inner: ReturnType<typeof page.getByTestId>) =>
        inner.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " border-b ")][1]');
      await expect(rowOf(paused)).toContainText('stops to look');
      const watch = page.getByRole('button', { name: 'Watch worker 0 live' });
      await expect(watch).toHaveCount(1);
      await expect(rowOf(page.getByTestId('live-watch'))).toContainText('stops to look');
      await expect(paused).toContainText('Paused');
      // The call's place opens in the editor.
      await expect(paused.getByText('tests/live.spec.ts:10', { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('live-view-paused.png') });
      const wide = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath('live-view-paused-narrow.png') });
      await page.setViewportSize(wide);

      // The test goes on.
      expect((await post({ type: 'stop', stop: null })).ok()).toBeTruthy();
      await expect(paused).toBeHidden({ timeout: 10_000 });
      expect((await post({ type: 'stop', stop })).ok()).toBeTruthy();
      await expect(paused).toBeVisible({ timeout: 10_000 });

      // The setting turns off: Paused and Watch leave the open page, and the worker's stream closes.
      expect((await request.patch(`/api/projects/${project}`, { data: { liveView: false } })).ok()).toBeTruthy();
      await expect(paused).toBeHidden({ timeout: 10_000 });
      await expect(watch).toHaveCount(0);
      await expect.poll(() => worker.open()).toBe(false);
    } finally {
      worker.close();
      await request.patch(`/api/projects/${project}`, { data: { liveView: true } });
      await request.post(`/api/test-runs/${runId}/finish`, { data: { streamToken, status: 'passed', totalTests: 0 } });
    }
  });
});
