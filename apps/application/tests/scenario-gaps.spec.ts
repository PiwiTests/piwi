import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * The Gaps tab: its triage verbs and the feature-graph view. A run reaching a
 * route seeds a single-covering-test gap after a recompute. The tests share one
 * project but each owns a distinct route (and therefore a distinct gap), and run
 * serially, so mutating one test's gap never disturbs another's.
 */
test.describe('Scenario gaps tab', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90000);

  // One distinct route per test, so each test triages its own gap. The verb
  // buttons are matched exactly: the route key carries the verb, and the gap's
  // graph button names the route in its title, so a substring match would hit both.
  const ROUTE = {
    graph: 'POST /api/orders-graph',
    accept: 'POST /api/orders-accept',
    snooze: 'POST /api/orders-snooze',
  };

  let projectId: number;

  test.beforeEach(async ({ request }) => {
    await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.SCENARIO_GAPS,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 3000,
        totalTests: 3,
        passedTests: 3,
        failedTests: 0,
        skippedTests: 0,
        testCases: Object.entries(ROUTE).map(([name, routeKey]) => {
          const url = `https://app.test${routeKey.slice(routeKey.indexOf(' ') + 1)}`;
          return {
            title: `places an order (${name})`,
            status: 'passed',
            duration: 1200,
            location: `tests/orders-${name}.spec.ts:10:5`,
            retries: 0,
            networkRequests: [{ method: 'POST', url, status: 201 }],
          };
        }),
      },
      timeout: 20000,
    });

    // Resolve the project id and recompute gaps against the ingested graph.
    const menu = await (await request.get('/api/projects/menu')).json();
    projectId = (menu.items as Array<{ id: number; name: string }>).find((p) => p.name === PROJECT.SCENARIO_GAPS)!.id;
    await retryPost(request, `/api/projects/${projectId}/gaps/recompute`, { data: {}, timeout: 20000 });

    const gaps = await (await request.get(`/api/projects/${projectId}/gaps`)).json();
    expect(gaps.items.length).toBeGreaterThan(0);
  });

  /** The open gap whose subject is the given route key, or null. */
  async function gapIdForRoute(request: import('@playwright/test').APIRequestContext, routeKey: string) {
    const res = await (await request.get(`/api/projects/${projectId}/gaps`)).json();
    const gap = (res.items as Array<{ id: number; subject: { kind: string; key: string } }>).find(
      (g) => g.subject.kind === 'route' && g.subject.key === routeKey,
    );
    return gap?.id ?? null;
  }

  test('lists gaps and opens the feature-graph view', async ({ page, request }) => {
    const id = await gapIdForRoute(request, ROUTE.graph);
    expect(id).not.toBeNull();
    await page.goto(`/projects/${projectId}?tab=gaps`);
    await waitForHydration(page);

    await expect(page.locator('[data-shot="gaps-panel"]')).toBeVisible();
    const gap = page.locator(`[data-shot="gap-${id}"]`);
    await expect(gap).toBeVisible();

    // Open the graph view from the gap's graph button: the ego picture draws the
    // route in the middle and the reaching test beside it, over the inspector list.
    await gap.getByRole('button', { name: 'View', exact: false }).click();
    const graph = page.locator('[data-shot="feature-graph"]');
    await expect(graph.locator('svg').first()).toBeVisible();
    await expect(graph.locator('[data-shot="node-inspector"]')).toContainText(ROUTE.graph);
  });

  test('accepting a gap removes it from the open list', async ({ page, request }) => {
    const id = await gapIdForRoute(request, ROUTE.accept);
    expect(id).not.toBeNull();
    await page.goto(`/projects/${projectId}?tab=gaps`);
    await waitForHydration(page);

    const gap = page.locator(`[data-shot="gap-${id}"]`);
    await expect(gap).toBeVisible();
    await gap.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(gap).toBeHidden({ timeout: 10000 });
  });

  test('snoozing a gap removes it from the open list', async ({ page, request }) => {
    const id = await gapIdForRoute(request, ROUTE.snooze);
    expect(id).not.toBeNull();
    await page.goto(`/projects/${projectId}?tab=gaps`);
    await waitForHydration(page);

    const gap = page.locator(`[data-shot="gap-${id}"]`);
    await expect(gap).toBeVisible();
    await gap.getByRole('button', { name: 'Snooze', exact: true }).click();
    await page.getByRole('menuitem', { name: 'For 1 week' }).click();
    await expect(gap).toBeHidden({ timeout: 10000 });
  });
});

test.describe('Recomputing scenario gaps', () => {
  test.setTimeout(90000);

  test('computes the default branch’s gaps when the newest run is on another branch', async ({ request }) => {
    const run = (branch: string, title: string) =>
      retryPost(request, '/api/test-runs/submit', {
        data: {
          projectName: PROJECT.SCENARIO_GAPS_RECOMPUTE,
          status: 'passed',
          startTime: new Date().toISOString(),
          duration: 1000,
          totalTests: 1,
          passedTests: 1,
          failedTests: 0,
          skippedTests: 0,
          metadata: { scm: { branch } },
          testCases: [
            {
              title,
              status: 'passed',
              duration: 500,
              location: 'tests/orders.spec.ts:10:5',
              retries: 0,
              networkRequests: [{ method: 'POST', url: 'https://app.test/api/orders-recompute', status: 201 }],
            },
          ],
        },
        timeout: 20000,
      });

    await run('main', 'places an order');
    const menu = await (await request.get('/api/projects/menu')).json();
    const projectId = (menu.items as Array<{ id: number; name: string }>).find(
      (p) => p.name === PROJECT.SCENARIO_GAPS_RECOMPUTE,
    )!.id;
    await request.patch(`/api/projects/${projectId}`, { data: { defaultBranch: 'main' } });
    await run('feature/checkout', 'places an order');

    const res = await retryPost(request, `/api/projects/${projectId}/gaps/recompute`, { data: {}, timeout: 20000 });
    const body = await res.json();
    expect(body.gapsUpserted).toBeGreaterThan(0);
  });
});
