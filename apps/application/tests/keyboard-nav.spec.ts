import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * Regression guards for keyboard navigation:
 *  - the global `g h` / `g p` "go to" chords,
 *  - the skip link being the first Tab stop,
 *  - project tabs reflecting `?tab=` in the URL via replace() (no history growth),
 *  - a project tab picked in the command palette opening on the project page.
 */
test.describe('Keyboard navigation & tab URL sync', () => {
  test.setTimeout(60000);

  test.beforeEach(async ({ request }) => {
    await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.KEYBOARD_NAV,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 5000,
        totalTests: 2,
        passedTests: 2,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          { title: 'kbd case 1', status: 'passed', duration: 1000, location: 'tests/kbd.spec.ts:1:1', retries: 0 },
          { title: 'kbd case 2', status: 'passed', duration: 1000, location: 'tests/kbd.spec.ts:2:1', retries: 0 },
        ],
      },
      timeout: 20000,
    });
  });

  async function findProjectId(request: APIRequestContext) {
    const { items: projects } = await (await request.get('/api/projects')).json();
    const project = projects.find((p: { name: string }) => p.name === PROJECT.KEYBOARD_NAV);
    return project.id as number;
  }

  test('the g-h and g-p chords navigate', async ({ page }) => {
    await page.goto('/projects');
    await waitForHydration(page);

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('g');
    await page.keyboard.press('h');
    await expect(page).toHaveURL(/\/$/);

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('g');
    await page.keyboard.press('p');
    await expect(page).toHaveURL(/\/projects$/);
  });

  test('the skip link is the first Tab stop', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: /skip to main content/i })).toBeFocused();
  });

  test('switching project tabs updates ?tab= via replace (no history growth)', async ({ page, request }) => {
    const projectId = await findProjectId(request);
    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);

    const startLen = await page.evaluate(() => history.length);

    await page.getByRole('button', { name: 'Performance' }).click();
    await expect(page).toHaveURL(/[?&]tab=performance/);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/[?&]tab=settings/);

    const endLen = await page.evaluate(() => history.length);
    expect(endLen, 'switching tabs must use replace(), not push()').toBe(startLen);
  });

  test('a project tab picked in the command palette opens on the project page', async ({ page, request }) => {
    const projectId = await findProjectId(request);
    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);
    await expect(page.getByRole('button', { name: /^Runs/ })).toHaveAttribute('aria-current', 'true');

    await page.getByRole('button', { name: /^Search…/ }).click();
    await page.getByRole('group', { name: 'This project' }).getByRole('option', { name: 'Performance' }).click();
    await expect(page).toHaveURL(/[?&]tab=performance/);
    await expect(page.getByRole('button', { name: 'Performance', exact: true })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });
});
