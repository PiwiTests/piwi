import { test, expect, type Page } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { resolveE2ETarget } from './desktop-target';
import { waitForHydration } from './utils';

/**
 * The browser tab of a run in flight: its progress leads the page title and a
 * badge is drawn over the favicon; when the run ends the outcome shows for a
 * moment, then the tab is restored.
 */
const favicon = (page: Page) => page.locator('head link[rel="icon"][type="image/svg+xml"]');

test('a running run shows its progress on the tab title and favicon', async ({ page, request }) => {
  test.skip(
    resolveE2ETarget().desktop,
    'the desktop window has no tab: the shell shows runs on its own title and tray',
  );
  const start = await request.post('/api/test-runs/start', {
    data: { projectName: PROJECT.RUN_TAB_INDICATOR, startTime: new Date().toISOString(), totalTests: 3 },
  });
  expect(start.ok()).toBeTruthy();
  const { runId, streamToken } = await start.json();

  const push = async (title: string, status: string) => {
    const res = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: [
          { type: 'complete', title, status, duration: 100, location: `tests/tab.spec.ts:${title.length}:1` },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
  };

  await push('first test', 'passed');
  await page.goto(`/test-runs/${runId}`);
  await waitForHydration(page);
  await expect(page).toHaveTitle(new RegExp(`^▶ Running 1/3… · Test run #${runId} — `));
  await expect(favicon(page)).toHaveCount(1);
  await expect(favicon(page)).toHaveAttribute('href', /^data:image\/svg\+xml,/);

  await push('second test', 'failed');
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
