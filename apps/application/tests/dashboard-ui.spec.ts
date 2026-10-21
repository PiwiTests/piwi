import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

test.describe('Dashboard UI Tests', () => {
  test.setTimeout(90000);

  test.beforeEach(async ({ request }) => {
    // Create test data before each UI test
    await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.UI_TEST,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 90000,
        totalTests: 5,
        passedTests: 5,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'UI test case 1',
            status: 'passed',
            duration: 1000,
            location: 'tests/ui.spec.ts:10:5',
            retries: 0,
          },
        ],
      },
      timeout: 20000,
    });
  });

  test('should display dashboard home page', async ({ page }) => {
    await page.goto('/');

    // Check page title
    await expect(page).toHaveTitle(/Piwi Dashboard/);

    // Check for stat strip
    await expect(page.getByText('failing now')).toBeVisible();
    await expect(page.getByText('runs today')).toBeVisible();

    // Check for projects section
    await expect(page.getByText('Project health')).toBeVisible();
  });

  test('should display projects list page', async ({ page }) => {
    await page.goto('/projects');

    // Check for at least one project - scope to page content
    await expect(page.getByRole('link', { name: PROJECT.UI_TEST }).first()).toBeVisible();

    // Check for test run count
    await expect(page.getByText(/\d+ runs/).first()).toBeVisible(); // There may be multiple projects
  });

  test('should navigate to project details page', async ({ page }) => {
    await page.goto('/projects');
    await waitForHydration(page);

    // Click on a project - scope to page content to avoid sidebar duplicate
    await page.getByRole('link', { name: PROJECT.UI_TEST }).first().click();

    await page.waitForURL(/\/projects\/\d+/);

    // Wait for main content to confirm page loaded
    await expect(page.getByRole('heading', { name: 'Run trend' })).toBeVisible({ timeout: 30000 });

    // Project name should be visible in the breadcrumb
    await expect(page.locator('#main-content').getByText(PROJECT.UI_TEST).first()).toBeVisible({ timeout: 15000 });
  });

  test('should navigate to test run details page', async ({ page }) => {
    await page.goto('/projects');
    await waitForHydration(page);

    // Click on a project - scope to page content to avoid sidebar duplicate
    await page.getByRole('link', { name: PROJECT.UI_TEST }).first().click();
    await page.waitForURL(/\/projects\/\d+/);
    await waitForHydration(page);

    // Click on first test run. Under heavy parallel load the click has been
    // observed to land without navigating (passes deterministically solo);
    // the mechanism is unverified — retry rather than asserting a cause.
    const viewButton = page
      .locator('table')
      .getByRole('link', { name: /^Run #/ })
      .first();
    await expect(viewButton).toBeVisible({ timeout: 10000 });
    await expect(async () => {
      await viewButton.click();
      await page.waitForURL(/\/test-runs\/\d+/, { timeout: 5000 });
    }).toPass({ timeout: 30000 });

    // Check test run details are displayed
    await expect(page.getByRole('heading', { name: /Run #/ })).toBeVisible();
  });

  test('should switch between tabs on test run detail page', async ({ page }) => {
    await page.goto('/projects');
    await waitForHydration(page);
    await page.getByRole('link', { name: PROJECT.UI_TEST }).first().click();
    await page.waitForURL(/\/projects\/\d+/);
    await waitForHydration(page);
    const viewButton = page
      .locator('table')
      .getByRole('link', { name: /^Run #/ })
      .first();
    await expect(viewButton).toBeVisible({ timeout: 10000 });
    await expect(async () => {
      await viewButton.click();
      await page.waitForURL(/\/test-runs\/\d+/, { timeout: 5000 });
    }).toPass({ timeout: 30000 });
    await waitForHydration(page);

    await expect(page.getByRole('combobox', { name: 'Group tests by' })).toBeVisible();

    await page.getByRole('button', { name: /^Timeline/ }).click();
    await page.getByRole('button', { name: /^Changes$/ }).click();
    // Either the baseline selector (a baseline exists) or the no-baseline empty
    // state renders — the two are mutually exclusive, so matching just them
    // proves the tab switched and loaded without a strict-mode clash with the
    // "no changes" note that can sit below the selector.
    await expect(page.getByText(/Compared with|No baseline run found/).first()).toBeVisible({
      timeout: 15000,
    });
  });

  test('the sidebar logo leads home', async ({ page }) => {
    await page.goto('/settings/about');
    await waitForHydration(page);

    await page.locator('#dashboard-sidebar-default').getByRole('link', { name: 'Piwi', exact: true }).click();

    await expect(page).toHaveURL(/\/$/);
  });

  test('should navigate using sidebar', async ({ page }) => {
    await page.goto('/');

    // Click on Projects in sidebar (Home's stat strip also links to /projects)
    await page.locator('#dashboard-sidebar-default').getByRole('link', { name: 'Projects' }).click();

    // Check navigation
    await page.waitForURL('/projects');

    // Click on Home in sidebar
    await page.locator('#dashboard-sidebar-default').getByRole('link', { name: 'Home' }).click();

    // Check navigation
    await page.waitForURL('/');
    await expect(page.getByText('Project health')).toBeVisible();
  });

  test('should display test status badges correctly', async ({ page }) => {
    await page.goto('/projects');

    // Check for status badge
    const statusBadge = page.locator('[class*="passed"]').or(page.locator('[class*="success"]')).first();
    await expect(statusBadge).toBeVisible();
  });

  test('should handle empty state gracefully', async ({ page }) => {
    await page.goto('/');

    // The dashboard should still load without errors
    await expect(page.getByText('Project health')).toBeVisible();
  });

  test('should be responsive', async ({ page }) => {
    // Test desktop view
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/');
    await expect(page.getByText('Project health')).toBeVisible();

    // Test mobile view
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await expect(page.getByText('Project health')).toBeVisible();
  });

  test('should refresh data when clicking refresh button', async ({ page }) => {
    await page.goto('/projects');

    // Click refresh button
    const refreshButton = page.getByRole('button', { name: 'Refresh' });
    await expect(refreshButton).toBeVisible();
    await refreshButton.click();

    // Data should still be visible after refresh - use link to target table
    await expect(page.getByRole('link', { name: PROJECT.UI_TEST }).first()).toBeVisible();
  });

  test('should display storage settings page', async ({ page }) => {
    await page.goto('/settings/storage');
    await waitForHydration(page);

    // Storage analysis dashboard header (always rendered, before its data loads)
    // and the cleanup section below it.
    await expect(page.getByText('Storage usage')).toBeVisible();
    await expect(page.getByText('Cleanup old test runs')).toBeVisible();

    // Verify the cleanup button exists
    await expect(page.getByRole('button', { name: 'Run cleanup' })).toBeVisible();
  });

  test('should show delete confirmation modal on test run page', async ({ page, request }) => {
    // Ensure there is a test run
    const submitRes = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.UI_TEST,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 5000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title: 'delete-ui-test', status: 'passed', duration: 500, location: 'tests/x.spec.ts:1:1' }],
      },
    });
    const { runId } = await submitRes.json();

    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    // Delete lives in the navbar's More menu; opening it and choosing Delete run
    // brings up the confirmation modal.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete run' }).click();
    await expect(page.getByText(`Delete run #${runId}`, { exact: true })).toBeVisible({ timeout: 10000 });

    // Close the modal
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText(`Delete run #${runId}`, { exact: true })).not.toBeVisible();
  });

  test('run metadata renders in the facts line and the Details popover', async ({ page, request }) => {
    // Submit a run with CI, SCM, tags and environment so every fact group renders
    const submitRes = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.BLOCK_LAYOUT,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 60000,
        totalTests: 2,
        passedTests: 0,
        failedTests: 2,
        skippedTests: 0,
        environment: 'staging',
        testCases: [
          {
            title: 'block-layout-test-a',
            status: 'failed',
            duration: 1000,
            location: 'tests/a.spec.ts:1:1',
            error: 'Error: failure',
          },
          { title: 'block-layout-test-b', status: 'passed', duration: 500, location: 'tests/b.spec.ts:1:1' },
        ],
        metadata: {
          ci: { provider: 'GitHub Actions', buildNumber: '42' },
          scm: { commit: 'abc123def456', branch: 'main', author: 'test' },
          tags: ['smoke', 'regression'],
          projectDescription: 'Block layout verification',
        },
      },
    });
    const { runId } = await submitRes.json();

    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    // The facts line carries environment, branch, commit and the CI build link.
    await expect(page.getByText('staging', { exact: true })).toBeVisible();
    await expect(page.getByText('main', { exact: true })).toBeVisible();
    await expect(page.getByText('abc123de')).toBeVisible();
    await expect(page.getByText('Build #42')).toBeVisible();

    // Tags live in the Details popover.
    await page.getByRole('button', { name: 'Details' }).click();
    await expect(page.getByText('smoke', { exact: true })).toBeVisible();
    await expect(page.getByText('regression', { exact: true })).toBeVisible();
  });

  test('tooling versions render in the Details popover without CI metadata', async ({ page, request }) => {
    // A run with no ci/environment but with Playwright/reporter versions still
    // shows them in the Details popover.
    const submitRes = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.BLOCK_LAYOUT_VERSIONS,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 30000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        playwrightVersion: '1.51.0',
        reporterVersion: '0.7.0',
        testCases: [{ title: 'versions-only-case', status: 'passed', duration: 500, location: 'tests/v.spec.ts:1:1' }],
        metadata: {
          scm: { commit: 'abc123def456', branch: 'main', author: 'test' },
          tags: ['smoke'],
        },
      },
    });
    const { runId } = await submitRes.json();

    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    // Branch is on the facts line; versions and tags are in the Details popover.
    await expect(page.getByText('main', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Details' }).click();
    await expect(page.getByText('Playwright v1.51.0')).toBeVisible();
    await expect(page.getByText('Piwi v0.7.0')).toBeVisible();
    await expect(page.getByText('smoke', { exact: true })).toBeVisible();
  });
});

test.describe('Run Label', () => {
  // These tests edit the label of the run they seed. `fullyParallel` spreads
  // them over several workers, so "the newest run of PROJECT.RUN_LABEL" can be
  // another worker's run and two tests then fight over one label — take the id
  // the submit returned instead.
  let runId = 0;

  test.beforeEach(async ({ page, request }) => {
    const submitRes = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.RUN_LABEL,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 90000,
        totalTests: 3,
        passedTests: 3,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'label test case',
            status: 'passed',
            duration: 500,
            location: 'tests/label.spec.ts:1:1',
            retries: 0,
          },
        ],
      },
      timeout: 20000,
    });
    runId = (await submitRes.json()).runId;
    await page.context().clearCookies();
  });

  test('shows + label button when no label exists', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await page.waitForURL(/\/test-runs\/\d+/);
    await waitForHydration(page);

    // The header carries the + label button beside the title.
    const addLabelBtn = page.getByTitle('Add a label');
    await expect(addLabelBtn).toBeVisible();
    await expect(addLabelBtn).toHaveText('+ label');
  });

  test('clicking + label shows an inline input', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await page.waitForURL(/\/test-runs\/\d+/);
    await waitForHydration(page);

    await page.getByTitle('Add a label').click();
    const input = page.getByPlaceholder('Add a label...');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test('pressing Enter saves the label and displays it', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await page.waitForURL(/\/test-runs\/\d+/);
    await waitForHydration(page);

    await page.getByTitle('Add a label').click();
    const input = page.getByPlaceholder('Add a label...');
    await input.fill('v1.0');
    await input.press('Enter');

    // The label now renders as an editable button beside the title.
    await expect(page.getByRole('button', { name: 'v1.0' })).toBeVisible();
  });

  test('label persists after page reload', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await page.waitForURL(/\/test-runs\/\d+/);
    await waitForHydration(page);

    await page.getByTitle('Add a label').click();
    const input = page.getByPlaceholder('Add a label...');
    await input.fill('persistent-label');
    await input.press('Enter');
    await expect(page.getByRole('button', { name: 'persistent-label' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('button', { name: 'persistent-label' })).toBeVisible();
  });

  test('clicking label text re-enters edit mode', async ({ page, request }) => {
    // Submit a run with a label via API
    await request.patch(`/api/test-runs/${runId}`, {
      data: { label: 'edit-me' },
    });

    await page.goto(`/test-runs/${runId}`);
    await page.waitForURL(/\/test-runs\/\d+/);
    await waitForHydration(page);

    const labelBtn = page.getByRole('button', { name: 'edit-me' });
    await expect(labelBtn).toBeVisible();

    // Click the label text to start editing
    await labelBtn.click();
    const input = page.getByPlaceholder('Add a label...');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('edit-me');
  });

  test('pressing Escape cancels label edit', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await page.waitForURL(/\/test-runs\/\d+/);
    await waitForHydration(page);

    await page.getByTitle('Add a label').click();
    const input = page.getByPlaceholder('Add a label...');
    await input.fill('cancel-this');
    await input.press('Escape');

    // Label should not appear (no save was triggered)
    await expect(page.getByTitle('Add a label')).toBeVisible();
  });

  test('saving an empty label clears it', async ({ page, request }) => {
    // Set a label first via API
    await request.patch(`/api/test-runs/${runId}`, {
      data: { label: 'will-be-cleared' },
    });

    await page.goto(`/test-runs/${runId}`);
    await page.waitForURL(/\/test-runs\/\d+/);
    await waitForHydration(page);

    // Click the label
    await page.getByRole('button', { name: 'will-be-cleared' }).click();
    const input = page.getByPlaceholder('Add a label...');
    await expect(input).toHaveValue('will-be-cleared');

    // Clear and save
    await input.fill('');
    await input.press('Enter');
    await waitForHydration(page);

    // + label button should return
    await expect(page.getByTitle('Add a label')).toBeVisible();
  });

  test('label appears in breadcrumb on test run page', async ({ page, request }) => {
    await request.patch(`/api/test-runs/${runId}`, {
      data: { label: 'breadcrumb-label' },
    });

    await page.goto(`/test-runs/${runId}`);
    await page.waitForURL(/\/test-runs\/\d+/);
    await waitForHydration(page);

    // The header shows the label beside the title, and the breadcrumb repeats it.
    await expect(page.getByRole('heading', { name: /Run #/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'breadcrumb-label' })).toBeVisible();
    await expect(page.getByText('breadcrumb-label').first()).toBeVisible();
  });
});
