import { test, expect, type APIRequestContext } from './fixtures';
import type { LiveStop } from '@piwitests/core/live-view';
import { PROJECT } from '#shared/test-project-names';
import { resolveE2ETarget } from './desktop-target';
import { holdWorkerStream } from './utils/live-view';

/**
 * A CI test paused for the people who may control its run, on the run page, its worker played by this spec: a worker
 * that can pause hears beside the project's hold that its controllers may pause; the lane panel offers **Pause** while
 * its test runs, which reaches the worker's stream; its paused stop reads on the test's row and in the lane panel
 * (`Paused`, until when, the CI job's own timeout), with **Resume** and **End the test**, each reaching the worker's
 * stream, and the pause goes as the worker says it went on.
 */

const target = resolveE2ETarget();

/** The project's id, made by a run submitted to it. */
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
  return ((await (await request.get(`/api/test-runs/${runId}`)).json()) as { projectId: number }).projectId;
}

test.describe('Pause a CI test', () => {
  test('Pause, Resume and End the test reach the worker, and its pause reads on its row and in the lane panel', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    const project = await projectId(request, PROJECT.LIVE_VIEW_PAUSE);
    const settings = { liveView: true, liveViewHold: true, liveViewHoldMinutes: 3, liveViewPause: true };
    expect((await request.patch(`/api/projects/${project}`, { data: settings })).ok()).toBeTruthy();

    const setup = await request.post('/api/test-runs/setup', {
      data: { projectName: PROJECT.LIVE_VIEW_PAUSE, startTime: new Date().toISOString(), liveView: true },
    });
    expect(setup.ok()).toBeTruthy();
    const { runId, setupToken, liveView } = (await setup.json()) as {
      runId: number;
      setupToken: string;
      liveView: { key: string };
    };
    const begun = await request.post(`/api/test-runs/${runId}/begin`, { data: { setupToken, totalTests: 1 } });
    const { streamToken } = (await begun.json()) as { streamToken: string };
    const title = 'pays with a saved card';
    await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: [
          {
            type: 'begin',
            title,
            location: 'tests/checkout.spec.ts:24:3',
            workerIndex: 0,
            parallelIndex: 0,
            startedAt: Date.now() - 5_000,
          },
        ],
      },
    });
    const id = { shard: null, worker: 0, slot: 0 };
    const worker = holdWorkerStream(target.baseUrl, runId, liveView.key, {
      worker: 0,
      slot: 0,
      features: 'hold,pause',
    });
    const post = async (message: Record<string, unknown>) => {
      const response = await request.post(`/api/test-runs/${runId}/live-view`, {
        headers: { Authorization: `Bearer ${liveView.key}` },
        data: { ...id, ...message },
      });
      return response.ok();
    };
    const commands = () =>
      worker.heard().filter((message) => ['pause', 'resume', 'end-test'].includes(String(message.type)));
    const shot = (await page.screenshot({ type: 'jpeg', quality: 40 })).toString('base64');
    const call = { title: "Click getByRole('button', { name: 'Pay' })", file: 'tests/checkout.spec.ts', line: 31 };
    const stop: LiveStop = { reason: 'pause', call, test: title, until: Date.now() + 3 * 60_000 };
    let sending: ReturnType<typeof setInterval> | undefined;
    try {
      await expect
        .poll(() => worker.heard().find((message) => message.type === 'hold'))
        .toEqual({ type: 'hold', ms: 180_000, pause: true });
      await page.goto(`/test-runs/${runId}`);
      // The worker sends its page twice a second, as a watched worker does.
      sending = setInterval(() => void post({ type: 'frame', data: shot, call, test: title }), 500);
      await page.getByRole('button', { name: /^Watch worker \d+ live$/ }).click({ timeout: 30_000 });
      const panel = page.getByTestId('lane-panel');
      await expect(panel.getByTestId('live-frame')).toBeVisible({ timeout: 30_000 });

      // Authentication is off on this server: whoever watches may control the run.
      await panel.getByTestId('live-control-pause').click({ timeout: 15_000 });
      await expect.poll(commands).toEqual([{ type: 'pause' }]);
      expect(await post({ type: 'stop', stop })).toBe(true);
      const row = page.getByTestId('live-paused');
      await expect(row).toHaveAttribute('data-reason', 'pause', { timeout: 15_000 });
      await expect(row).toContainText(/Paused · until \d/);
      const paused = panel.getByTestId('live-paused-panel');
      await expect(paused.getByTestId('live-paused-by')).toHaveText(/^Paused · until \d/);
      await expect(paused).toContainText(call.title);
      await expect(paused).toContainText('The CI job’s own timeout still runs.');
      await expect(panel.getByTestId('live-control-pause')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('live-view-paused.png') });
      const wide = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath('live-view-paused-narrow.png') });
      await page.setViewportSize(wide);

      await paused.getByRole('button', { name: 'Resume' }).click();
      await expect.poll(commands).toEqual([{ type: 'pause' }, { type: 'resume' }]);
      // The worker went on: the pause leaves the panel and the row, and Pause is offered again.
      expect(await post({ type: 'stop', stop: null })).toBe(true);
      await expect(paused).toBeHidden({ timeout: 10_000 });
      await expect(row).toBeHidden({ timeout: 10_000 });
      await panel.getByTestId('live-control-pause').click({ timeout: 15_000 });
      expect(await post({ type: 'stop', stop })).toBe(true);
      await paused.getByRole('button', { name: 'End the test' }).click({ timeout: 15_000 });
      await expect
        .poll(commands)
        .toEqual([{ type: 'pause' }, { type: 'resume' }, { type: 'pause' }, { type: 'end-test' }]);
      expect(await post({ type: 'stop', stop: null })).toBe(true);
      await expect(paused).toBeHidden({ timeout: 10_000 });
    } finally {
      clearInterval(sending);
      worker.close();
      await request.patch(`/api/projects/${project}`, { data: { liveViewHold: false } });
      await request.post(`/api/test-runs/${runId}/finish`, { data: { streamToken, status: 'passed', totalTests: 1 } });
    }
  });

  test('a project with the setting off offers no Pause, and refuses one asked anyway', async ({ page, request }) => {
    test.setTimeout(120_000);
    const project = await projectId(request, PROJECT.LIVE_VIEW_PAUSE_OFF);
    const settings = { liveView: true, liveViewHold: true, liveViewHoldMinutes: 3, liveViewPause: false };
    expect((await request.patch(`/api/projects/${project}`, { data: settings })).ok()).toBeTruthy();
    const setup = await request.post('/api/test-runs/setup', {
      data: { projectName: PROJECT.LIVE_VIEW_PAUSE_OFF, startTime: new Date().toISOString(), liveView: true },
    });
    const { runId, setupToken, liveView } = (await setup.json()) as {
      runId: number;
      setupToken: string;
      liveView: { key: string };
    };
    const begun = await request.post(`/api/test-runs/${runId}/begin`, { data: { setupToken, totalTests: 1 } });
    const { streamToken } = (await begun.json()) as { streamToken: string };
    await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: [
          {
            type: 'begin',
            title: 'pays',
            location: 'tests/checkout.spec.ts:24:3',
            workerIndex: 0,
            parallelIndex: 0,
            startedAt: Date.now() - 5_000,
          },
        ],
      },
    });
    const worker = holdWorkerStream(target.baseUrl, runId, liveView.key, {
      worker: 0,
      slot: 0,
      features: 'hold,pause',
    });
    const shot = (await page.screenshot({ type: 'jpeg', quality: 40 })).toString('base64');
    const post = () =>
      request.post(`/api/test-runs/${runId}/live-view`, {
        headers: { Authorization: `Bearer ${liveView.key}` },
        data: { shard: null, worker: 0, slot: 0, type: 'frame', data: shot, call: null, test: 'pays' },
      });
    let sending: ReturnType<typeof setInterval> | undefined;
    try {
      await expect
        .poll(() => worker.heard().find((message) => message.type === 'hold'))
        .toEqual({ type: 'hold', ms: 180_000 });
      await page.goto(`/test-runs/${runId}`);
      sending = setInterval(() => void post(), 500);
      await page.getByRole('button', { name: /^Watch worker \d+ live$/ }).click({ timeout: 30_000 });
      const panel = page.getByTestId('lane-panel');
      await expect(panel.getByTestId('live-frame')).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByTestId('live-control-pause')).toHaveCount(0);
      const hello = worker.heard();
      expect(hello.some((message) => message.type === 'pause')).toBe(false);
      const refused = await request.post(`/api/test-runs/${runId}/live-view/control`, {
        data: { watch: 'any', worker: 0, slot: 0, command: 'pause' },
      });
      expect(refused.status()).toBe(409);
      expect(((await refused.json()) as { message: string }).message).toMatch(/^The project's setting is off/);
    } finally {
      clearInterval(sending);
      worker.close();
      await request.patch(`/api/projects/${project}`, { data: { liveViewHold: false } });
      await request.post(`/api/test-runs/${runId}/finish`, { data: { streamToken, status: 'passed', totalTests: 1 } });
    }
  });
});
