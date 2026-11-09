import { test, expect, type APIRequestContext } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * Declining the Test Map must hold on a project that already has graph data.
 *
 * Ingest writes graph nodes on every run, so the Test Map's evidence arrives
 * passively — before the fix, that evidence overrode a decline and the Gaps tab
 * stayed on any project with history. This drives a run that reaches a route (so
 * graph rows exist), then declines the capability for the project and asserts
 * the tab is gone regardless.
 *
 * The tab is project-scoped, so this decline is project-level and never touches
 * instance-wide state — the instance-gated surfaces (the Home inbox card and the
 * MCP tool list) resolve from the same passive-data rule, covered without a
 * cross-file race in tests/unit/capabilities-handlers.test.ts and
 * tests/unit/mcp-tool-filter.test.ts.
 */
async function seedGraphRun(request: APIRequestContext): Promise<number> {
  await retryPost(request, '/api/test-runs/submit', {
    data: {
      projectName: PROJECT.SCENARIO_GAPS_DECLINE,
      status: 'passed',
      startTime: new Date().toISOString(),
      duration: 2000,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      skippedTests: 0,
      testCases: [
        {
          title: 'places an order',
          status: 'passed',
          duration: 1200,
          location: 'tests/orders.spec.ts:10:5',
          retries: 0,
          networkRequests: [{ method: 'POST', url: 'https://app.test/api/orders-decline', status: 201 }],
        },
      ],
    },
    timeout: 20000,
  });

  const menu = await (await request.get('/api/projects/menu')).json();
  const project = (menu.items as Array<{ id: number; name: string }>).find(
    (p) => p.name === PROJECT.SCENARIO_GAPS_DECLINE,
  );
  expect(project).toBeTruthy();
  return project!.id;
}

test.describe.serial('Declining the Test Map with graph data', () => {
  test.setTimeout(90000);

  let projectId = 0;

  test.beforeAll(async ({ request }) => {
    projectId = await seedGraphRun(request);
    // Start undecided so the tab shows before the decline.
    await request.patch(`/api/projects/${projectId}/capabilities`, { data: { decisions: { 'test-map': null } } });
  });

  test.afterAll(async ({ request }) => {
    await request.patch(`/api/projects/${projectId}/capabilities`, { data: { decisions: { 'test-map': null } } });
  });

  test('a project decline hides the Gaps view even though graph nodes exist', async ({ page, request }) => {
    // The run reached a route, so the project has graph rows: the Test Map reads
    // active off that passive data until a decision is stored. The active state is
    // the evidence — before the fix it also survived a decline.
    const stateOf = (items: Array<{ id: string; state: string }>) => items.find((i) => i.id === 'test-map')?.state;
    const caps = await (await request.get(`/api/projects/${projectId}/capabilities`)).json();
    expect(stateOf(caps.items)).toBe('active');

    // The Coverage tab's switch names each view it has.
    const gapsView = page.getByRole('button', { name: 'Gaps', exact: true });

    await page.goto(`/projects/${projectId}?tab=coverage`);
    await waitForHydration(page);
    await expect(gapsView).toBeVisible();

    // Decline at project level → the view disappears, active passive data and all.
    await request.patch(`/api/projects/${projectId}/capabilities`, {
      data: { decisions: { 'test-map': 'declined' } },
    });
    const declined = await (await request.get(`/api/projects/${projectId}/capabilities`)).json();
    expect(stateOf(declined.items)).toBe('declined');

    await page.reload();
    await waitForHydration(page);
    await expect(gapsView).toHaveCount(0);

    // A stale ?tab=gaps deep link opens what the tab still has rather than the hidden view.
    await page.goto(`/projects/${projectId}?tab=gaps`);
    await waitForHydration(page);
    await expect(page.locator('[data-shot="gaps-panel"]')).toHaveCount(0);

    // Reconsider (clear the decision) → the view returns.
    await request.patch(`/api/projects/${projectId}/capabilities`, { data: { decisions: { 'test-map': null } } });
    await page.goto(`/projects/${projectId}?tab=coverage`);
    await waitForHydration(page);
    await expect(gapsView).toBeVisible();
  });
});
