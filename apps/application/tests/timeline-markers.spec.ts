import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { PROJECT } from '#shared/test-project-names';
import { waitForHydration } from './utils';

const HOUR = 3_600_000;

/** Submit a one-test run started `hoursAgo` hours ago; returns the project id. */
async function submitRun(request: APIRequestContext, hoursAgo: number): Promise<number> {
  const response = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.MARKERS_PANEL,
      status: 'passed',
      startTime: new Date(Date.now() - hoursAgo * HOUR).toISOString(),
      duration: 1000,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      skippedTests: 0,
      testCases: [{ title: 'marks', status: 'passed', duration: 10, location: 'tests/marks.spec.ts:1:1' }],
    },
  });
  expect(response.ok()).toBeTruthy();
  const { runId } = await response.json();
  return (await (await request.get(`/api/test-runs/${runId}`)).json()).projectId;
}

test.describe.serial('Timeline markers', () => {
  let projectId: number;

  test.beforeAll(async ({ request }) => {
    await submitRun(request, 3);
    projectId = await submitRun(request, 0);
    const created = await request.post(`/api/projects/${projectId}/markers`, {
      data: {
        label: 'Moved CI to ARM runners',
        category: 'infra',
        occurredAt: new Date(Date.now() - 2 * HOUR).toISOString(),
        environment: 'staging',
        description: 'New runner pool, same images.',
      },
    });
    expect(created.ok()).toBeTruthy();
  });

  test('hovering a marker line on the run trend shows its details', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);

    await page.locator('[data-shot="run-trend"]').getByTestId('chart-marker').first().hover();
    const tooltip = page.getByTestId('chart-marker-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('Infrastructure');
    await expect(tooltip).toContainText('Moved CI to ARM runners');
    await expect(tooltip).toContainText('staging');
    await expect(tooltip).toContainText('New runner pool, same images.');
    await expect(tooltip).toContainText('Click to open it in the markers panel');
  });

  test('the markers panel adds, edits and deletes markers in place, without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: /Markers \(1\)/ }).click();
    const panel = page.locator('[data-shot="markers-panel"]');
    await expect(panel.getByTestId('marker-list')).toContainText('Moved CI to ARM runners');
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    // Add: an empty label is refused in the form itself.
    await panel.getByRole('button', { name: 'Add marker' }).click();
    const form = panel.getByTestId('marker-form');
    await form.getByRole('button', { name: 'Add marker' }).click();
    await expect(form).toContainText('Give the marker a label');
    await form.getByRole('textbox').first().fill('Bumped Playwright');
    // The error leaves as soon as the label is filled (and the cards below move up).
    await expect(form).not.toContainText('Give the marker a label');
    await form.getByText('Config change', { exact: true }).click();
    await expect(form.getByRole('radio', { name: 'Config change' })).toBeChecked();
    await form.getByRole('button', { name: 'Add marker' }).click();
    await expect(panel.getByTestId('marker-list')).toContainText('Bumped Playwright');

    // Edit.
    await panel.getByRole('button', { name: 'Edit Bumped Playwright' }).click();
    await form.getByRole('textbox').first().fill('Bumped Playwright to 1.60');
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(panel.getByTestId('marker-list')).toContainText('Bumped Playwright to 1.60');

    // Delete from the edit form.
    await panel.getByRole('button', { name: 'Edit Bumped Playwright to 1.60' }).click();
    await form.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog', { name: 'Delete marker' }).getByRole('button', { name: 'Delete' }).click();
    await expect(panel.getByTestId('marker-list')).not.toContainText('Bumped Playwright');
    await expect(panel.getByTestId('marker-list')).toContainText('Moved CI to ARM runners');
  });

  test('clicking a marker on the chart opens it in the panel form', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);

    await page.locator('[data-shot="run-trend"]').getByTestId('chart-marker').first().click();
    await expect(page.getByRole('heading', { name: 'Edit marker' })).toBeVisible();
    await expect(page.getByTestId('marker-form').getByRole('textbox').first()).toHaveValue('Moved CI to ARM runners');
  });
});
