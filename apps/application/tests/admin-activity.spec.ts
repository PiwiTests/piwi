import { test, expect } from './fixtures';
import { retryPost, waitForHydration } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * What the instance is doing now, for an administrator deciding when to restart it: the runs in progress across every
 * project, answered by the admin activity route and shown on Settings → About.
 */

interface Activity {
  runsInProgress: Array<{ status: string; lastActivityAt: string }>;
  uploadsInProgress: number;
  openEventStreams: number;
}

test.describe('Instance activity', () => {
  test('counts a run until it ends, and Settings → About shows it', async ({ page, request }) => {
    const setup = await (
      await retryPost(request, '/api/test-runs/setup', {
        data: { projectName: PROJECT.ADMIN_ACTIVITY, startTime: new Date().toISOString() },
      })
    ).json();
    try {
      const response = await request.get('/api/admin/activity');
      expect(response.ok()).toBeTruthy();
      const activity = (await response.json()) as Activity;
      expect(activity.runsInProgress.map((run) => run.status)).toContain('initializing');
      expect(activity.uploadsInProgress).toEqual(expect.any(Number));
      expect(activity.openEventStreams).toEqual(expect.any(Number));

      await page.goto('/settings/about');
      await waitForHydration(page);
      const tile = page.getByTestId('about-activity');
      await expect(tile).toContainText(/^Runs in progress\s*[1-9]\d*/);
    } finally {
      const begun = await (
        await retryPost(request, `/api/test-runs/${setup.runId}/begin`, {
          data: { setupToken: setup.setupToken, totalTests: 0 },
        })
      ).json();
      await retryPost(request, `/api/test-runs/${setup.runId}/finish`, {
        data: { streamToken: begun.streamToken, status: 'passed', totalTests: 0 },
      });
    }
  });
});
