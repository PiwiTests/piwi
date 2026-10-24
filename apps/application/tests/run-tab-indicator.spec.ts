import { test, expect, type APIRequestContext, type Page } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { resolveE2ETarget } from './desktop-target';
import { waitForHydration } from './utils';

/**
 * The browser tab of a run in flight: its progress leads the page title and a
 * badge is drawn over the favicon; when the run ends the outcome shows for a
 * moment, then the tab is restored.
 */
const favicon = (page: Page) => page.locator('head link[rel="icon"][type="image/svg+xml"]');

async function startRun(request: APIRequestContext, data: Record<string, unknown>) {
  const start = await request.post('/api/test-runs/start', {
    data: { projectName: PROJECT.RUN_TAB_INDICATOR, startTime: new Date().toISOString(), ...data },
  });
  expect(start.ok()).toBeTruthy();
  const { runId, streamToken } = (await start.json()) as { runId: number; streamToken: string };
  const push = async (title: string, line: number, status: string) => {
    const res = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: [{ type: 'complete', title, status, duration: 100, location: `tests/tab.spec.ts:${line}:1` }],
      },
    });
    expect(res.ok()).toBeTruthy();
  };
  return { runId, streamToken, push };
}

test.describe('run progress on the browser tab', () => {
  test.skip(
    resolveE2ETarget().desktop,
    'the desktop window has no tab: the shell shows runs on its own title and tray',
  );

  test('a running run shows its progress on the tab title and favicon', async ({ page, request }) => {
    // It waits out the finished run's outcome on the tab.
    test.slow();
    const { runId, streamToken, push } = await startRun(request, { totalTests: 3 });

    await push('first test', 5, 'passed');
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await expect(page).toHaveTitle(new RegExp(`^▶ Running 1/3… · Test run #${runId} — `));
    await expect(favicon(page)).toHaveCount(1);
    await expect(favicon(page)).toHaveAttribute('href', /^data:image\/svg\+xml,/);

    await push('second test', 12, 'failed');
    await expect(page).toHaveTitle(new RegExp(`^▶ Running 2/3 · 1 failed · Test run #${runId} — `));

    const finish = await request.post(`/api/test-runs/${runId}/finish`, {
      data: { streamToken, status: 'failed', duration: 300, totalTests: 2, passedTests: 1, failedTests: 1 },
    });
    expect(finish.ok()).toBeTruthy();
    await expect(page).toHaveTitle(new RegExp(`^▶ Run failed · Test run #${runId} — `));
    await expect(favicon(page)).toHaveAttribute('href', /^data:image\/svg\+xml,/);

    // The outcome clears after its flash, back to the plain title and logo.
    await expect(page).toHaveTitle(new RegExp(`^Test run #${runId} — `), { timeout: 15_000 });
    await expect(favicon(page)).toHaveAttribute('href', '/logo.svg');
  });

  test('a run that never reported its size shows no share done', async ({ page, request }) => {
    const { runId, streamToken, push } = await startRun(request, {});

    await push('first test', 5, 'passed');
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await expect(page).toHaveTitle(new RegExp(`^▶ Running… · Test run #${runId} — `));

    await request.post(`/api/test-runs/${runId}/finish`, { data: { streamToken, status: 'passed', duration: 100 } });
  });

  test('a run cancelled by a newer one restores the tab', async ({ page, request }) => {
    const instanceId = 'run-tab-indicator-instance';
    const { runId, push } = await startRun(request, { totalTests: 2, instanceId });

    await push('first test', 5, 'passed');
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await expect(page).toHaveTitle(new RegExp(`^▶ Running 1/2… · Test run #${runId} — `));

    // The same reporter instance starting again cancels the run this page watches.
    const next = await startRun(request, { totalTests: 2, instanceId });
    await expect(page).toHaveTitle(new RegExp(`^Test run #${runId} — `));
    await expect(favicon(page)).toHaveAttribute('href', '/logo.svg');

    await request.post(`/api/test-runs/${next.runId}/finish`, {
      data: { streamToken: next.streamToken, status: 'passed', duration: 100 },
    });
  });
});
