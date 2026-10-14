import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

test.describe('Run timeline hooks and gaps', () => {
  let runId = 0;
  const t0 = Date.now() - 60_000;

  test.beforeAll(async ({ request }) => {
    const response = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.RUN_TIMELINE_HOOKS,
        status: 'failed',
        startTime: new Date(t0).toISOString(),
        duration: 4000,
        totalTests: 3,
        passedTests: 2,
        failedTests: 1,
        skippedTests: 0,
        testCases: [
          {
            title: 'seeds the catalog',
            status: 'passed',
            // Playwright leaves the beforeAll out of the duration; the hook sections below span 2.3s.
            duration: 800,
            location: 'tests/catalog.spec.ts:10:5',
            workerIndex: 0,
            startedAt: t0,
            stepEvents: [
              {
                title: 'Before Hooks',
                category: 'hook',
                startedAt: t0,
                duration: 1500,
                status: 'passed',
                hooks: [
                  { title: 'beforeAll hook', category: 'hook', duration: 1300 },
                  { title: 'beforeEach hook', category: 'hook', duration: 200 },
                ],
              },
              { title: 'After Hooks', category: 'hook', startedAt: t0 + 2200, duration: 100, status: 'passed' },
            ],
          },
          {
            title: 'removes the catalog',
            status: 'failed',
            duration: 600,
            location: 'tests/catalog.spec.ts:20:5',
            error: 'Error: afterAll: catalog still has 3 items',
            workerIndex: 0,
            startedAt: t0 + 2400,
            stepEvents: [
              { title: 'Before Hooks', category: 'hook', startedAt: t0 + 2400, duration: 100, status: 'passed' },
              {
                title: 'After Hooks',
                category: 'hook',
                startedAt: t0 + 2900,
                duration: 50,
                status: 'failed',
                error: 'Error: afterAll: catalog still has 3 items',
                hooks: [{ title: 'afterAll hook', category: 'hook', duration: 50, failed: true }],
              },
            ],
          },
          {
            // Playwright replaced the worker after the failure: the retry runs in process 1, on the same lane.
            title: 'removes the catalog',
            status: 'passed',
            duration: 500,
            retries: 1,
            location: 'tests/catalog.spec.ts:20:5',
            workerIndex: 1,
            startedAt: t0 + 3700,
          },
        ],
      },
      timeout: 20000,
    });
    expect(response.ok()).toBeTruthy();
    runId = ((await response.json()) as { runId: number }).runId;
  });

  test('draws hooks by default, names the failed hook and explains hook time and worker restarts', async ({ page }) => {
    await page.goto(`/test-runs/${runId}?tab=workers`);
    await waitForHydration(page);

    const hookBars = page.locator('[data-timeline-hook]');
    await expect(hookBars).toHaveCount(4);
    await expect(page.getByTestId('timeline-hook-failures')).toHaveText('1 hook failure');

    // The replacement process continues worker 0's lane, and the stretch before it says so.
    const timeline = page.locator('[data-shot="run-timeline"]');
    await expect(timeline.getByText('1 worker restart')).toBeVisible();
    await expect(timeline.locator('svg text', { hasText: /^Worker 1$/ })).toHaveCount(0);
    const restartBox = (await page.locator('[data-timeline-gap][data-kind="restart"]').boundingBox())!;
    await page.mouse.move(restartBox.x + restartBox.width / 2, restartBox.y + restartBox.height / 2);
    await expect(page.getByText('Process 0 ended after “removes the catalog” failed')).toBeVisible();
    await page.mouse.move(0, 0);

    // The failed teardown names the hook that broke and its error.
    const failedBox = (await page.locator('[data-timeline-hook][data-status="failed"]').boundingBox())!;
    await page.mouse.move(failedBox.x + failedBox.width / 2, failedBox.y + failedBox.height / 2);
    await expect(page.getByTestId('timeline-tooltip-hooks')).toContainText('afterAll');
    await expect(page.getByText('Error: afterAll: catalog still has 3 items').last()).toBeVisible();
    // The hovered section is lifted above a wash over the rest, and the wash goes with the pointer.
    await expect(page.locator('[data-timeline-focus] [data-timeline-hook][data-status="failed"]')).toHaveCount(1);
    await page.mouse.move(0, 0);
    await expect(page.locator('[data-timeline-focus]')).toHaveCount(0);

    // With hooks off only the failed one stays drawn.
    const setupBox = (await hookBars.first().boundingBox())!;
    await page.mouse.move(0, 0);
    await page.getByRole('switch', { name: 'Show hooks' }).click();
    await expect(hookBars).toHaveCount(1);

    // The first test's bar spans its beforeAll, and says what Playwright reported.
    await page.mouse.move(setupBox.x + setupBox.width / 2, setupBox.y + setupBox.height / 2);
    await expect(page.getByText('Playwright reports 800ms')).toBeVisible();
  });

  test('draws a retried attempt apart and joins the attempts of a test on hover', async ({ page }) => {
    await page.goto(`/test-runs/${runId}?tab=workers`);
    await waitForHydration(page);

    // Three bars, two tests: the failed attempt Playwright retried is not another test.
    const timeline = page.locator('[data-shot="run-timeline"]');
    await expect(timeline).toContainText('2 tests · 1 retry');
    const attempts = timeline.locator('[data-timeline-test][data-title="removes the catalog"]');
    await expect(attempts).toHaveCount(2);
    const retried = timeline.locator('[data-timeline-test][data-retried]');
    await expect(retried).toHaveCount(1);
    await expect(retried).toHaveAttribute('data-attempt', '1');

    // Hovering the passing retry lifts the failed attempt with it, joined by an arrow, and lists both.
    const retryBox = (await timeline.locator('[data-timeline-test][data-attempt="2"]').first().boundingBox())!;
    await page.mouse.move(retryBox.x + retryBox.width / 2, retryBox.y + retryBox.height / 2);
    const focus = page.locator('[data-timeline-focus]');
    await expect(focus.locator('[data-timeline-test]')).toHaveCount(2);
    await expect(focus.locator('[data-timeline-retry-arrow]')).toHaveCount(1);
    const list = page.getByTestId('timeline-tooltip-attempts');
    await expect(list).toContainText('Passed on attempt 2');
    await expect(list.locator('li')).toHaveText([/Attempt 1\s*failed/, /Attempt 2\s*passed/]);
    await expect(list.locator('li[data-current]')).toContainText('Attempt 2');

    // A test that ran once lifts alone (hovered past its beforeAll, on the test body).
    const onceBox = (await timeline.locator('[data-timeline-test]:not([data-title])').first().boundingBox())!;
    await page.mouse.move(onceBox.x + onceBox.width * 0.8, onceBox.y + onceBox.height / 2);
    await expect(focus.locator('[data-timeline-test]')).toHaveCount(1);
    await expect(page.getByTestId('timeline-tooltip-attempts')).toHaveCount(0);
  });
});
