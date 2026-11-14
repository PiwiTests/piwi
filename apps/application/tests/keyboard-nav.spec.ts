import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';
import { PROJECT_TABS } from '#shared/app-places';

/**
 * Regression guards for keyboard navigation:
 *  - the global `g h` / `g p` "go to" chords,
 *  - the skip link being the first Tab stop,
 *  - project tabs reflecting `?tab=` in the URL via replace() (no history growth),
 *  - a project tab picked in the command palette opening on the project page,
 *  - the command palette listing the tabs the project page shows, by the project's own capabilities.
 */
test.describe('Keyboard navigation & tab URL sync', () => {
  test.setTimeout(60000);

  /** Reports a run for `projectName` and answers the project's id. */
  async function reportProject(request: APIRequestContext, projectName: string) {
    await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName,
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
    const { items: projects } = await (await request.get('/api/projects')).json();
    const project = projects.find((p: { name: string }) => p.name === projectName);
    return project.id as number;
  }

  const findProjectId = (request: APIRequestContext) => reportProject(request, PROJECT.KEYBOARD_NAV);

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
    const projectTabs = page.getByRole('group', { name: 'This project' }).getByRole('option');
    await expect(projectTabs).toHaveText(PROJECT_TABS.map((tab) => tab.label));
    await projectTabs.filter({ hasText: 'Flake Lab' }).click();
    await expect(page).toHaveURL(/[?&]tab=flake-lab/);
    await expect(page.getByRole('button', { name: 'Flake Lab', exact: true })).toHaveAttribute('aria-current', 'true');
  });

  test('the command palette follows the capabilities of the project the page shows', async ({ page, request }) => {
    const projectId = await reportProject(request, PROJECT.KEYBOARD_NAV_HIDDEN_TAB);
    const decide = (decision: 'declined' | null) =>
      request.patch(`/api/projects/${projectId}/capabilities`, { data: { decisions: { 'flake-lab': decision } } });
    const allTabs = PROJECT_TABS.map((tab) => tab.label);
    const withoutFlakeLab = PROJECT_TABS.filter((tab) => tab.value !== 'flake-lab').map((tab) => tab.label);
    /** Opens the command palette, checks the project's entries and closes it again. */
    async function expectPaletteTabs(labels: string[]) {
      await page.getByRole('button', { name: /^Search…/ }).click();
      await expect(page.getByRole('group', { name: 'This project' }).getByRole('option')).toHaveText(labels);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('group', { name: 'This project' })).toHaveCount(0);
    }
    /** Checks the project page's strip shows the same tabs; a label may carry a count, `Runs (1)`. */
    async function expectStripTabs(labels: string[]) {
      const strip = page.getByRole('navigation').filter({ has: page.getByRole('button', { name: /^Runs/ }) });
      await expect(strip.getByRole('button')).toHaveText(labels.map((label) => new RegExp(`^${label}`)));
    }

    // The instance leaves Flake Lab on; the project declines it.
    await decide('declined');
    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);
    await expectStripTabs(withoutFlakeLab);
    await expectPaletteTabs(withoutFlakeLab);

    // A sub-page opened directly, which reads no capability states itself.
    await page.goto(`/projects/${projectId}/locators`);
    await waitForHydration(page);
    await expectPaletteTabs(withoutFlakeLab);

    // A decision changed while the browser is away from the project shows on coming back to a sub-page.
    await decide(null);
    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);
    await expectStripTabs(allTabs);
    await expectPaletteTabs(allTabs);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Locators' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/locators`));
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('g');
    await page.keyboard.press('p');
    await expect(page).toHaveURL(/\/projects$/);
    await decide('declined');
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/locators`));
    await expectPaletteTabs(withoutFlakeLab);

    // A decision changed on the project's Settings tab reaches the palette without a reload.
    await page.goto(`/projects/${projectId}?tab=settings&section=capabilities`);
    await waitForHydration(page);
    await expectPaletteTabs(withoutFlakeLab);
    await page.getByLabel('Flake suspects for this project').click();
    await page.getByRole('option', { name: 'Instance default' }).click();
    await expect(page.getByText('Capability updated', { exact: true })).toBeVisible();
    await expectStripTabs(allTabs);
    await expectPaletteTabs(allTabs);
  });
});
