import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { waitForHydration } from './utils';

test.describe('Connect wizard', () => {
  test('the choices rewrite every path, and each path ends in wrapConfig and the fixtures', async ({ page }) => {
    await page.goto('/setup');
    await waitForHydration(page);
    const wizard = page.locator('[data-tour="get-started-wizard"]');
    await expect(wizard.getByRole('heading', { name: 'Connect your Playwright suite' })).toBeVisible();

    await wizard.getByRole('textbox', { name: 'Project name' }).fill('checkout');
    await expect(wizard.locator('pre').first()).toContainText(
      /npx @piwitests\/reporter init --server-url http:\/\/localhost:\d+ --project checkout$/,
    );

    await wizard.getByRole('switch', { name: 'Local runs go to the desktop app' }).click();
    await expect(wizard.locator('pre').first()).toContainText('--project checkout --desktop-app prefer');

    await wizard.getByRole('button', { name: 'Coding agent' }).click();
    await expect(wizard.getByRole('button', { name: 'Coding agent' })).toHaveAttribute('aria-pressed', 'true');
    const prompt = wizard.locator('pre').first();
    await expect(prompt).toContainText('--project checkout --desktop-app prefer --json');
    await expect(prompt).toContainText('tests/fixtures.ts');

    await wizard.getByRole('button', { name: 'By hand' }).click();
    await expect(wizard.getByText('playwright.config.ts')).toBeVisible();
    const config = wizard.locator('pre').nth(1);
    await expect(config).toContainText('export default wrapConfig(');
    await expect(config).toContainText("projectName: 'checkout',");
    await expect(config).toContainText("desktopApp: 'prefer',");
    await expect(wizard.locator('pre').nth(2)).toContainText('base.extend(piwiFixtures)');

    // The reporter entry alone is the fallback, folded under the wrapped config.
    const fallback = wizard.getByRole('button', { name: "Can't wrap your config? Add the reporter entry instead" });
    await expect(fallback).toHaveAttribute('aria-expanded', 'false');
    await fallback.click();
    await expect(wizard.getByText("['@piwitests/reporter', {")).toBeVisible();
  });

  test('the status line names a run as soon as one reports', async ({ page, request }) => {
    // Only this test's project counts, so another worker's run never takes the line.
    await page.route('**/api/test-runs/recent*', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { items: Array<{ projectName?: string }> };
      await route.fulfill({
        response,
        json: { items: body.items.filter((run) => run.projectName === PROJECT.SETUP_CONNECT) },
      });
    });
    await page.goto('/setup');
    await waitForHydration(page);
    const status = page.locator('[data-shot="setup-run-status"]');
    await expect(status).toContainText('Waiting for the first run');

    const res = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.SETUP_CONNECT,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title: 'loads', status: 'passed', duration: 1000, location: 'tests/home.spec.ts:3:1' }],
      },
    });
    expect(res.ok()).toBeTruthy();

    await expect(status).toContainText(`Last run from ${PROJECT.SETUP_CONNECT}`, { timeout: 30_000 });
    await status.getByRole('link', { name: 'Open it' }).click();
    await expect(page).toHaveURL(/\/test-runs\/\d+$/);
  });
});
