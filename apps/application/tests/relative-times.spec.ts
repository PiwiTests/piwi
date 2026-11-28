import { test, expect } from './fixtures';
import { retryPost, waitForHydration } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * A relative time ("5 minutes ago") reads the browser's clock, so the server never renders one: a browser whose clock
 * is hours ahead of the server's hydrates Home, its project health and its recent activity, without a mismatch.
 */

test.describe('Relative times', () => {
  test('Home hydrates without a mismatch when the clocks disagree', async ({ page, request }) => {
    const submitted = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.RELATIVE_TIMES,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title: 'opens', status: 'passed', duration: 1000, location: 'tests/home.spec.ts:1:1' }],
      },
    });
    expect(submitted.ok()).toBeTruthy();

    // A production build logs the summary line alone, a dev build each mismatch too.
    const hydrationErrors: string[] = [];
    page.on('console', (msg) => {
      if (/Hydration (completed but contains mismatches|text content mismatch|text mismatch)/.test(msg.text())) {
        hydrationErrors.push(msg.text());
      }
    });
    await page.clock.install({ time: Date.now() + 3 * 60 * 60 * 1000 });

    await page.goto('/');
    await waitForHydration(page);

    await expect(
      page
        .locator('#recent-activity')
        .getByText(/Run #\d+ · about 3 hours ago/)
        .first(),
    ).toBeVisible();
    expect(hydrationErrors).toEqual([]);
  });
});
