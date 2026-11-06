import { test, expect, type APIRequestContext } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

/**
 * Stuck? on the run page: a test of a live run that has run far longer than its passing runs took (`#shared/stuck-
 * tests`) is marked on its row, with how long it has run against the longest of its passes, within the server's next
 * check; a page opened later shows it too, and the mark leaves as the attempt completes. A test of a run outside CI
 * that its reporter says stands stopped shows where, as text, in place of the mark, which the server's check never
 * gives it while it stands stopped.
 */

const TITLE = 'pays with PayPal';
const LOCATION = 'tests/checkout.spec.ts:12:3';
const BROWSER = { projectName: 'chromium' };

/** Two runs where the test passed in 6 s at most. */
async function passedTwice(request: APIRequestContext): Promise<void> {
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
}

test.describe('Stuck tests', () => {
  test('a running test far past its passing runs is marked Stuck? until it completes', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    await passedTwice(request);

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

  test('a test its reporter says stands stopped shows where, never Stuck?, on a page open or opened later', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    await passedTwice(request);

    // A run an editor started, steered in VS Code, whose test began five minutes ago.
    const started = await request.post('/api/test-runs/start', {
      data: {
        projectName: PROJECT.STUCK_TESTS,
        startTime: new Date().toISOString(),
        totalTests: 1,
        metadata: {
          piwiOrigin: { kind: 'editor' },
          piwiRunRef: 'terminal-4242-1762400000000',
          piwiInteractive: { client: 'VS Code', ref: 'terminal-4242-1762400000000' },
        },
      },
    });
    expect(started.ok()).toBeTruthy();
    const { runId, streamToken } = (await started.json()) as { runId: number; streamToken: string };
    const startedAt = Date.now() - 5 * 60_000;
    const of = { title: TITLE, location: LOCATION, workerIndex: 0, browser: BROWSER };
    const send = async (testCases: Array<Record<string, unknown>>) =>
      expect((await request.post(`/api/test-runs/${runId}/events`, { data: { streamToken, testCases } })).ok()).toBe(
        true,
      );
    // It stood stopped at a breakpoint for four of its five minutes, and stands stopped again now.
    await send([
      { type: 'begin', ...of, startedAt },
      { type: 'test-resumed', ...of, pausedMs: 4 * 60_000 },
    ]);
    const stop = {
      reason: 'breakpoint',
      title: "Click getByRole('button', { name: 'Pay' })",
      file: 'tests/checkout.spec.ts',
      line: 18,
      bar: true,
      since: Date.now() - 2 * 60_000,
      pausedMs: 4 * 60_000,
    };

    try {
      await page.goto(`/test-runs/${runId}`);
      await expect(page.getByTestId('run-started-from')).toHaveText('from VS Code');
      // Its row shows as the page's stream catches up; the stop then reaches it live.
      await expect(page.getByText(TITLE).first()).toBeVisible({ timeout: 45_000 });
      await send([{ type: 'test-stopped', ...of, stop }]);
      const paused = page.getByTestId('live-paused');
      await expect(paused).toBeVisible({ timeout: 15_000 });
      await expect(paused).toHaveAttribute('data-reason', 'breakpoint');
      await expect(paused).toContainText('Stopped at a breakpoint');
      await expect(paused).toContainText("Click getByRole('button', { name: 'Pay' })");
      await expect(paused.getByText('tests/checkout.spec.ts:18', { exact: true })).toBeVisible();
      await expect(paused).toContainText('for 2 minutes');
      await page.screenshot({ path: testInfo.outputPath('told-stop-row.png') });
      const wide = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath('told-stop-row-narrow.png') });
      await page.setViewportSize(wide);

      // A page opened later shows it too; the server's check, every 15 seconds, never marks it while it stands stopped.
      await page.reload();
      await expect(page.getByTestId('live-paused')).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(16_000);
      await expect(page.getByText('Stuck?', { exact: true })).toHaveCount(0);

      // It goes on: the stop leaves its row.
      await send([{ type: 'test-resumed', ...of, pausedMs: 6 * 60_000 }]);
      await expect(page.getByTestId('live-paused')).toBeHidden({ timeout: 15_000 });
    } finally {
      await request.post(`/api/test-runs/${runId}/finish`, { data: { streamToken, status: 'passed', totalTests: 1 } });
    }
  });
});
