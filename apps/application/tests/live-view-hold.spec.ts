import { test, expect, type APIRequestContext } from './fixtures';
import type { LiveStop } from '@piwitests/core/live-view';
import { PROJECT } from '#shared/test-project-names';
import { resolveE2ETarget } from './desktop-target';
import { holdWorkerStream } from './utils/live-view';

/**
 * A failing CI test held for the people who may control its run, on the run page, its worker played by this spec: a
 * worker that can hold hears the project's hold as its stream opens, and that a controller watches it in full once
 * the lane panel shows it; its held stop reads on the test's row and in the lane panel (`Failed, held at its line`,
 * until when, the CI job's own timeout); **Let it go** reaches the worker's stream, and the panel's hold goes as the
 * worker says it went on.
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

test.describe('Hold a failing CI test', () => {
  test('a held failure reads on its row and in the lane panel, and Let it go reaches its worker', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    const project = await projectId(request, PROJECT.LIVE_VIEW_HOLD);
    const settings = { liveView: true, liveViewHold: true, liveViewHoldMinutes: 3 };
    expect((await request.patch(`/api/projects/${project}`, { data: settings })).ok()).toBeTruthy();

    const setup = await request.post('/api/test-runs/setup', {
      data: { projectName: PROJECT.LIVE_VIEW_HOLD, startTime: new Date().toISOString(), liveView: true },
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
    const worker = holdWorkerStream(target.baseUrl, runId, liveView.key, { worker: 0, slot: 0, features: 'hold' });
    const post = async (message: Record<string, unknown>) => {
      const response = await request.post(`/api/test-runs/${runId}/live-view`, {
        headers: { Authorization: `Bearer ${liveView.key}` },
        data: { ...id, ...message },
      });
      return response.ok();
    };
    const shot = (await page.screenshot({ type: 'jpeg', quality: 40 })).toString('base64');
    const failure = { title: 'Failed: expect(locator).toBeEnabled() failed', file: 'tests/checkout.spec.ts', line: 31 };
    const stop: LiveStop = { reason: 'held', call: failure, test: title, until: Date.now() + 3 * 60_000 };
    let sending: ReturnType<typeof setInterval> | undefined;
    try {
      await expect
        .poll(() => worker.heard().find((message) => message.type === 'hold'))
        .toEqual({
          type: 'hold',
          ms: 180_000,
        });
      await page.goto(`/test-runs/${runId}`);
      // The worker sends its page twice a second, as a watched worker does.
      sending = setInterval(() => void post({ type: 'frame', data: shot, call: failure, test: title }), 500);
      await page.getByRole('button', { name: /^Watch worker \d+ live$/ }).click({ timeout: 30_000 });
      const panel = page.getByTestId('lane-panel');
      await expect(panel.getByTestId('live-frame')).toBeVisible({ timeout: 30_000 });
      // Authentication is off on this server: whoever watches may control the run.
      await expect
        .poll(
          () =>
            worker
              .heard()
              .filter((message) => message.type === 'view')
              .at(-1),
          { timeout: 10_000 },
        )
        .toMatchObject({ full: true, controller: true });

      expect(await post({ type: 'stop', stop })).toBe(true);
      const row = page.getByTestId('live-paused');
      await expect(row).toHaveAttribute('data-reason', 'held', { timeout: 15_000 });
      await expect(row).toContainText('Failed, held at its line');
      await expect(row.getByTestId('live-held')).toContainText(/^· Held · until \d/);
      const held = panel.getByTestId('live-held-panel');
      await expect(held).toContainText('Failed, held at its line');
      await expect(held).toContainText(failure.title);
      await expect(held).toContainText('The CI job’s own timeout still runs.');
      await expect(panel.getByText('Failed, held at its line')).toHaveCount(1);
      await page.screenshot({ path: testInfo.outputPath('live-view-held.png') });
      const wide = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath('live-view-held-narrow.png') });
      await page.setViewportSize(wide);

      await held.getByRole('button', { name: 'Let it go' }).click();
      await expect.poll(() => worker.heard().filter((message) => message.type === 'let-go')).toHaveLength(1);
      // The worker went on: the hold leaves the panel and the row.
      expect(await post({ type: 'stop', stop: null })).toBe(true);
      await expect(held).toBeHidden({ timeout: 10_000 });
      await expect(row).toBeHidden({ timeout: 10_000 });
    } finally {
      clearInterval(sending);
      worker.close();
      await request.patch(`/api/projects/${project}`, { data: { liveViewHold: false } });
      await request.post(`/api/test-runs/${runId}/finish`, { data: { streamToken, status: 'failed', totalTests: 1 } });
    }
  });
});
