/**
 * Nudges on a running instance. A test that timed out, in a project that
 * captures no fixtures, gets the nudge offering the capture fixtures guide:
 * **Show me** starts the guide; **Don't show again** hides it, and it stays
 * hidden in a new browser context, since the dismissal is kept on the server;
 * declining the assistant hides it too.
 */
import { test, expect } from './fixtures';
import type { Browser, Page } from '@playwright/test';
import { PROJECT } from '#shared/test-project-names';
import type { AssistantNudgeDismissal } from '#shared/assistant-nudges';
import { retryPost, waitForHydration } from './utils';

// One test declines the assistant, which every nudge reads.
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const NUDGE = 'failure-without-fixtures';

let executionId = 0;

/** The nudge on the execution page, once the page has read the dismissals and placed it. */
function nudge(page: Page) {
  return page.locator(`[data-nudge="${NUDGE}"]`);
}

/** Opens the execution and waits for its read of the dismissed nudges, and the render after it. */
async function openExecution(page: Page, readsDismissals = true) {
  const dismissals = readsDismissals
    ? page.waitForResponse((r) => r.url().includes('/api/assistant/nudge-dismissals'))
    : null;
  await page.goto(`/test-run-cases/${executionId}`);
  await waitForHydration(page);
  if (dismissals) expect((await dismissals).ok()).toBeTruthy();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** A page in a browser context of its own: no storage shared with the test's page. */
async function freshPage(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  return { page: await context.newPage(), close: () => context.close() };
}

test.describe('Nudges', () => {
  test.beforeAll(async ({ request }) => {
    await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.ASSISTANT_NUDGES,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 31_000,
        totalTests: 1,
        passedTests: 0,
        failedTests: 0,
        timedOutTests: 1,
        skippedTests: 0,
        testCases: [
          {
            title: 'checkout waits for the payment provider',
            status: 'timedOut',
            duration: 30_000,
            location: 'tests/checkout.spec.ts:12:3',
            error: 'Test timeout of 30000ms exceeded.',
          },
        ],
      },
      timeout: 20_000,
    });
    const { items: projects } = await (await request.get('/api/projects')).json();
    const project = projects.find((p: { name: string }) => p.name === PROJECT.ASSISTANT_NUDGES);
    const detail = await (await request.get(`/api/projects/${project.id}`)).json();
    const run = await (await request.get(`/api/test-runs/${detail.testRuns[0].id}`)).json();
    executionId = (run.testCases as Array<{ executionId: number }>)[0]!.executionId;
    // Start from a nudge no one dismissed, on an instance whose assistant is not declined.
    await request.patch('/api/capabilities', { data: { decisions: { assistant: null } } });
    await request.delete(`/api/assistant/nudge-dismissals/${NUDGE}`);
  });

  test('a timed-out failure without capture fixtures offers their guide, and Show me starts it', async ({ page }) => {
    await openExecution(page);
    const card = nudge(page);
    await expect(card).toBeVisible();
    await expect(card).toContainText('Record the requests behind failures like this one');
    await expect(card.getByRole('button', { name: "Don't show again" })).toBeVisible();

    await card.getByRole('button', { name: 'Show me' }).click();
    const popover = page.locator(
      '.driver-popover.piwi-guide[data-guide="guide-add-capture-fixtures"][data-guide-settled]',
    );
    await expect(popover).toBeVisible({ timeout: 30_000 });
    await expect(popover).toHaveAttribute('data-guide-stop', 'network');
  });

  test("Don't show again hides it, and it stays hidden in another browser", async ({ page, browser, baseURL }) => {
    await openExecution(page);
    await nudge(page).getByRole('button', { name: "Don't show again" }).click();
    await expect(nudge(page)).toHaveCount(0);

    const dismissed = (await (await page.request.get('/api/assistant/nudge-dismissals')).json()) as {
      items: AssistantNudgeDismissal[];
    };
    expect(dismissed.items.map((item) => item.nudgeId)).toContain(NUDGE);

    // Another browser, with a budget of its own, reads the dismissal from the server.
    const other = await freshPage(browser, baseURL);
    try {
      const dismissals = other.page.waitForResponse((r) => r.url().includes('/api/assistant/nudge-dismissals'));
      await other.page.goto(`/test-run-cases/${executionId}`);
      await waitForHydration(other.page);
      expect((await dismissals).ok()).toBeTruthy();
      await expect(other.page.getByRole('heading', { level: 1 })).toBeVisible();
      await other.page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await expect(nudge(other.page)).toHaveCount(0);
    } finally {
      await other.close();
    }
  });

  test('declining the assistant hides it', async ({ page, request }) => {
    // Shown again once the dismissal is undone.
    expect((await request.delete(`/api/assistant/nudge-dismissals/${NUDGE}`)).ok()).toBeTruthy();
    await openExecution(page);
    await expect(nudge(page)).toBeVisible();

    const declined = await request.patch('/api/capabilities', { data: { decisions: { assistant: 'declined' } } });
    expect(declined.ok()).toBeTruthy();
    try {
      expect((await request.get('/api/assistant/nudge-dismissals')).status()).toBe(403);
      await openExecution(page, false);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(nudge(page)).toHaveCount(0);
    } finally {
      await request.patch('/api/capabilities', { data: { decisions: { assistant: null } } });
    }
  });
});
