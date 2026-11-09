import { test, expect } from './fixtures';
import { waitForHydration } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * Starred projects with sign-in off, the suite's server: the star in Home's
 * Project health puts the project first there, under a Starred divider, and in
 * a Starred group of the sidebar; the browser keeps it across a reload, and
 * unstarring puts the project back in its place. One test: each test opens a
 * new browser context, which holds no star.
 */
test.describe('Starred projects', () => {
  let projectId = 0;

  test.beforeAll(async ({ request }) => {
    const response = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.STARRED_PROJECTS,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title: 'homepage loads', status: 'passed', duration: 900, location: 'tests/home.spec.ts:5:5' }],
      },
    });
    expect(response.ok()).toBeTruthy();
    const { runId } = (await response.json()) as { runId: number };
    const run = (await (await request.get(`/api/test-runs/${runId}`)).json()) as { projectId: number };
    projectId = run.projectId;
  });

  /** Home's Project health, every row shown: a project with one run is listed last, where the preview may cut it. */
  async function expandedHealth(page: import('@playwright/test').Page) {
    const health = page.locator('[data-tour="project-health"]');
    const showAll = health.getByRole('button', { name: /^Show all/ });
    if (await showAll.count()) await showAll.click();
    return health;
  }

  /** The sidebar's text, in reading order. */
  async function sidebarText(page: import('@playwright/test').Page): Promise<string> {
    return page.locator('#dashboard-sidebar-default').innerText();
  }

  test('a star leads Project health and the sidebar, stays after a reload, and goes when unstarred', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForHydration(page);
    let health = await expandedHealth(page);
    const star = health.getByRole('button', { name: `Star ${PROJECT.STARRED_PROJECTS}`, exact: true }).first();
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();

    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(health.getByTestId('project-health-starred-divider')).toBeVisible();
    await expect(health.locator('tbody tr').nth(1)).toContainText(PROJECT.STARRED_PROJECTS);

    await expect.poll(() => sidebarText(page)).toContain('Starred (1)');
    const text = await sidebarText(page);
    expect(text.indexOf('Starred (1)')).toBeLessThan(text.indexOf(PROJECT.STARRED_PROJECTS));

    await page.reload();
    await waitForHydration(page);
    await expect(page.locator(`[data-testid="project-star-${projectId}"]`).first()).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('#dashboard-sidebar-default')).toContainText('Starred (1)');

    // Unstarring puts the project back in its place.
    health = await expandedHealth(page);
    const starAgain = health.getByRole('button', { name: `Star ${PROJECT.STARRED_PROJECTS}`, exact: true }).first();
    await starAgain.click();
    await expect(starAgain).toHaveAttribute('aria-pressed', 'false');
    await expect(health.getByTestId('project-health-starred-divider')).toHaveCount(0);
    await expect.poll(() => sidebarText(page)).not.toContain('Starred (');
  });
});
