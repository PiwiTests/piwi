import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { waitForHydration } from './utils';

/**
 * Home and a project's runs list show a running run's progress, "4 of 6 · 2 failed", and move its row on as results
 * come in, from the instance stream's `run-progress`: with every read of the list held, the row still moves on. The
 * run's end still reads the list.
 */

const TOTAL = 6;

/** `count` results of the run from its `from`-th test on: every second one fails. */
function results(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const n = from + i;
    const failed = n % 2 === 1;
    return {
      type: 'complete',
      title: `lists step ${n + 1}`,
      location: `tests/lists.spec.ts:${n * 6 + 3}:5`,
      status: failed ? 'failed' : 'passed',
      duration: 900,
      error: failed ? 'Error: expect(received).toBe(expected)' : null,
      retries: 0,
    };
  });
}

/** A run of the project, its tests planned and none reported yet. */
async function startRun(request: APIRequestContext) {
  const started = await request.post('/api/test-runs/start', {
    data: { projectName: PROJECT.LIVE_RUN_LISTS, startTime: new Date().toISOString(), totalTests: TOTAL },
  });
  expect(started.ok()).toBeTruthy();
  const { runId, streamToken } = (await started.json()) as { runId: number; streamToken: string };
  let reported = 0;
  return {
    runId,
    /** Stream the next `count` results, as the reporter does. */
    async report(count: number) {
      const events = await request.post(`/api/test-runs/${runId}/events`, {
        data: { streamToken, testCases: results(reported, count) },
      });
      expect(events.ok()).toBeTruthy();
      reported += count;
    },
    async finish() {
      await request.post(`/api/test-runs/${runId}/finish`, {
        data: { streamToken, status: 'failed', totalTests: TOTAL, passedTests: 3, failedTests: 3 },
      });
    },
  };
}

/**
 * Hold every read of `path` the page makes from now on, unanswered, so it keeps the list it has: a row that moves on
 * then moved on from the stream. Another spec's runs, which refresh the lists, change nothing. Returns the release.
 */
async function holdReads(page: Page, path: string): Promise<() => Promise<void>> {
  const reads = (url: URL) => url.pathname === path;
  await page.route(reads, () => {});
  return () => page.unroute(reads);
}

/** Open `path` and wait until its run stream listens. */
async function openListening(page: Page, path: string) {
  const stream = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/stream');
  await page.goto(path);
  await waitForHydration(page);
  await stream;
}

async function expectProgress(row: Locator, text: string) {
  await expect(row.locator('[data-live-progress]')).toContainText(text, { timeout: 15_000 });
}

test.describe.serial('Running runs in the lists', () => {
  test.setTimeout(90_000);

  test('Home’s Recent activity moves a running run’s row on as results come in, from the stream', async ({
    page,
    request,
  }) => {
    const run = await startRun(request);
    try {
      await run.report(2);
      await openListening(page, '/');
      const card = page.locator('[data-shot="recent-activity"]');
      const showAll = card.getByRole('button', { name: /^Show all/ });
      if (await showAll.isVisible()) await showAll.click();
      const row = card.locator(`a[href="/test-runs/${run.runId}"]`);
      await expectProgress(row, `2 of ${TOTAL} · 1 failed`);

      const release = await holdReads(page, '/api/test-runs/recent');
      await run.report(2);
      await expectProgress(row, `4 of ${TOTAL} · 2 failed`);

      // The run's end reads the list again: the row shows how it ended, its pass rate in place of its progress.
      await release();
      await run.report(2);
      await run.finish();
      await expect(row.locator('[data-live-progress]')).toHaveCount(0, { timeout: 15_000 });
      await expect(row).toContainText('50%');
    } finally {
      await run.finish();
    }
  });

  test('the project’s runs list moves a running run’s row on as results come in, from the stream', async ({
    page,
    request,
  }) => {
    const run = await startRun(request);
    try {
      await run.report(1);
      const { projectId } = (await (await request.get(`/api/test-runs/${run.runId}`)).json()) as {
        projectId: number;
      };
      await openListening(page, `/projects/${projectId}`);
      const row = page.locator('[data-shot="runs-table"] tr', { hasText: `Run #${run.runId}` });
      await expectProgress(row, `1 of ${TOTAL}`);
      await expect(row.locator('[data-live-progress]')).not.toContainText('failed');

      await holdReads(page, `/api/projects/${projectId}`);
      await run.report(4);
      await expectProgress(row, `5 of ${TOTAL} · 2 failed`);
    } finally {
      await run.finish();
    }
  });
});
