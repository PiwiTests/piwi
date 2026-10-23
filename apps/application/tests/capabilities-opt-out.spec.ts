import { test, expect, type APIRequestContext } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * Declining a capability hides it, reconsidering brings it back. This drives the
 * execution page's evidence footer: a project with no captured fixtures names the
 * missing sources with a decline control, declining it removes the line and its
 * fixture-backed tabs, and clearing the decision restores them. Auth is disabled
 * on the default test server, so the virtual admin sees the controls.
 */

// A plain assertion failure — not a timeout and no network clue — so no nudge
// shows above the evidence, and no network evidence is captured.
const ASSERTION_ERROR =
  'Error: expect(received).toBe(expected)\n\nExpected: 3\nReceived: 2\n    at tests/cart.spec.ts:8:20';

async function seedExecution(request: APIRequestContext): Promise<{ projectId: number; executionId: number }> {
  await retryPost(request, '/api/test-runs/submit', {
    data: {
      projectName: PROJECT.CAPABILITY_OPT_OUT,
      status: 'failed',
      startTime: new Date().toISOString(),
      duration: 2000,
      totalTests: 1,
      passedTests: 0,
      failedTests: 1,
      skippedTests: 0,
      testCases: [
        {
          title: 'cart totals the line items',
          status: 'failed',
          duration: 800,
          location: 'tests/cart.spec.ts:8:3',
          error: ASSERTION_ERROR,
        },
      ],
    },
    timeout: 20000,
  });

  const { items: projects } = await (await request.get('/api/projects')).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT.CAPABILITY_OPT_OUT);
  expect(project).toBeTruthy();
  const detail = await (await request.get(`/api/projects/${project.id}`)).json();
  const runId = detail.testRuns[0].id as number;
  const run = await (await request.get(`/api/test-runs/${runId}`)).json();
  const failed = (run.testCases as Array<{ executionId: number; status: string }>).find((c) => c.status === 'failed');
  expect(failed?.executionId).toBeTruthy();
  return { projectId: project.id as number, executionId: failed!.executionId };
}

test.describe.serial('Capabilities opt-out', () => {
  test.setTimeout(90000);

  let projectId = 0;
  let executionId = 0;

  test.beforeAll(async ({ request }) => {
    ({ projectId, executionId } = await seedExecution(request));
    // Start each run from a clean, undecided state.
    await request.patch(`/api/projects/${projectId}/capabilities`, { data: { decisions: { fixtures: null } } });
  });

  test('an undecided project names the missing sources and offers to decline them', async ({ page }) => {
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);

    const footer = page.locator('[data-shot="evidence-fixtures-footer"]');
    await expect(footer).toBeVisible();
    await expect(footer).toContainText('not captured for this project');

    // The fixture-backed tabs are gone, not dimmed.
    await expect(page.getByRole('tab', { name: 'Network' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Console' })).toHaveCount(0);
    // Core evidence stays.
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible();

    // The admin decline control is present.
    await expect(footer.getByRole('button', { name: 'Not for this project' })).toBeVisible();
  });

  test('declining hides the footer, and it stays hidden across a reload', async ({ page }) => {
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);

    const footer = page.locator('[data-shot="evidence-fixtures-footer"]');
    await expect(footer).toBeVisible();
    await footer.getByRole('button', { name: 'Not for this project' }).click();
    await expect(footer).toHaveCount(0);

    await page.reload();
    await waitForHydration(page);
    await expect(page.locator('[data-shot="evidence-fixtures-footer"]')).toHaveCount(0);
  });

  test('reconsidering the decision restores the footer', async ({ page, request }) => {
    // Reconsider clears the stored decision, the same write the Setup and project
    // form controls make.
    await request.patch(`/api/projects/${projectId}/capabilities`, { data: { decisions: { fixtures: null } } });

    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);
    await expect(page.locator('[data-shot="evidence-fixtures-footer"]')).toBeVisible();
  });

  test('declining the Test Map hides the Gaps tab, reconsidering brings it back', async ({ page, request }) => {
    // The opt-out project reaches no routes, so no graph rows exist and the Test
    // Map is undecided — its Gaps tab shows. (A project with graph rows is covered
    // in scenario-gaps-decline.spec.ts: the Test Map's data is passive, so a
    // decline holds there too.)
    await request.patch(`/api/projects/${projectId}/capabilities`, { data: { decisions: { 'test-map': null } } });
    const caps = await (await request.get(`/api/projects/${projectId}/capabilities`)).json();
    const testMap = (caps.items as Array<{ id: string; state: string }>).find((i) => i.id === 'test-map');
    expect(testMap?.state).toBe('undecided');

    // The tab strip renders the item as a button (onSelect, no `to`); match a
    // link too in case Nuxt UI changes that, so the assertion tracks the tab.
    const gapsTab = page
      .getByRole('button', { name: 'Gaps', exact: true })
      .or(page.getByRole('link', { name: 'Gaps', exact: true }));

    await page.goto(`/projects/${projectId}?tab=runs`);
    await waitForHydration(page);
    await expect(gapsTab).toBeVisible();

    // Decline at project level → the tab disappears.
    await request.patch(`/api/projects/${projectId}/capabilities`, { data: { decisions: { 'test-map': 'declined' } } });
    await page.reload();
    await waitForHydration(page);
    await expect(gapsTab).toHaveCount(0);

    // Reconsider (clear the decision) → the tab returns.
    await request.patch(`/api/projects/${projectId}/capabilities`, { data: { decisions: { 'test-map': null } } });
    await page.reload();
    await waitForHydration(page);
    await expect(gapsTab).toBeVisible();
  });

  test('a stored project decision is preselected in the edit form', async ({ page, request }) => {
    // A stored decline must round-trip: the project payload carries it, so the
    // form's tri-state opens on it rather than the instance default.
    await request.patch(`/api/projects/${projectId}/capabilities`, { data: { decisions: { fixtures: 'declined' } } });

    await page.goto(`/projects/${projectId}?tab=settings&section=capabilities`);
    await waitForHydration(page);
    await expect(page.getByLabel('Capture fixtures for this project')).toContainText('Declined for this project');

    await request.patch(`/api/projects/${projectId}/capabilities`, { data: { decisions: { fixtures: null } } });
  });
});
