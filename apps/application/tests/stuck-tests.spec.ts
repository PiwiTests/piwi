import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

/**
 * Stuck? on the run page: a test of a live run that has run far longer than its passing runs took (`#shared/stuck-
 * tests`) is marked on its row, with how long it has run against the longest of its passes, within the server's next
 * check; a page opened later shows it too, and the mark leaves as the attempt completes.
 */

const TITLE = 'pays with PayPal';
const LOCATION = 'tests/checkout.spec.ts:12:3';
const BROWSER = { projectName: 'chromium' };

test.describe('Stuck tests', () => {
  test('a running test far past its passing runs is marked Stuck? until it completes', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    // Two runs where the test passed in 6 s at most.
    for (const duration of [5000, 6000]) {
      const submitted = await request.post('/api/test-runs/submit', {
        data: {
          projectName: PROJECT.STUCK_TESTS,
          status: 'passed',
          startTime: new Date(Date.now() - 86_400_000).toISOString(),
          duration,
          totalTests: 1,
          passedTests: 1,
          failedTests: 0,
          skippedTests: 0,
          testCases: [{ title: TITLE, status: 'passed', duration, location: LOCATION, browser: BROWSER }],
        },
      });
      expect(submitted.ok()).toBeTruthy();
    }

    // A live run whose test began five minutes ago.
    const started = await request.post('/api/test-runs/start', {
      data: { projectName: PROJECT.STUCK_TESTS, startTime: new Date().toISOString(), totalTests: 1 },
    });
    expect(started.ok()).toBeTruthy();
    const { runId, streamToken } = (await started.json()) as { runId: number; streamToken: string };
    const startedAt = Date.now() - 5 * 60_000;
    const begun = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: [{ type: 'begin', title: TITLE, location: LOCATION, workerIndex: 0, startedAt, browser: BROWSER }],
      },
    });
    expect(begun.ok()).toBeTruthy();

    try {
      await page.goto(`/test-runs/${runId}`);
      const row = page.locator('[data-testid="stuck-time"]:visible').first();
      // The server checks its live runs every 15 seconds.
      await expect(row).toBeVisible({ timeout: 45_000 });
      await expect(row).toHaveText(/Running for 5 minutes( \d+ seconds?)?, usually 6s at most/);
      await expect(page.getByText('Stuck?', { exact: true }).first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('stuck-row.png') });
      const wide = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath('stuck-row-narrow.png') });
      await page.setViewportSize(wide);

      // A page opened later shows it too.
      await page.reload();
      await expect(page.locator('[data-testid="stuck-time"]:visible').first()).toBeVisible({ timeout: 30_000 });

      // The attempt completes: the mark leaves its row.
      const completed = await request.post(`/api/test-runs/${runId}/events`, {
        data: {
          streamToken,
          testCases: [
            {
              type: 'complete',
              title: TITLE,
              location: LOCATION,
              status: 'passed',
              duration: Date.now() - startedAt,
              workerIndex: 0,
              startedAt,
              browser: BROWSER,
            },
          ],
        },
      });
      expect(completed.ok()).toBeTruthy();
      await expect(page.locator('[data-testid="stuck-time"]:visible')).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByText('Stuck?', { exact: true })).toHaveCount(0);
    } finally {
      await request.post(`/api/test-runs/${runId}/finish`, { data: { streamToken, status: 'passed', totalTests: 1 } });
    }
  });
});
