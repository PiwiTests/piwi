import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * A file's coverage page (`/projects/:id/coverage?file=`): the source at the
 * version the most tests recorded, each line with how many tests ran it and
 * the executable lines no test runs marked; a click on a line, or a
 * Shift-click for a range, lists the tests that ran it, and on a line no test
 * runs the nearest test to copy. A selector picks among the versions the tests
 * recorded; without the source the lines show as numbers grouped by their
 * tests. The execution page, the cluster's suspect lines and the Test Map
 * link it, and a project that records no coverage shows none of it.
 */

const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const B = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';
const ENDPOINTS = 'src/Orders/OrdersEndpoints.cs';
const ROUTE_URL = 'https://app.test/api/orders-file-coverage';

/** The endpoints' source at `A`: `ListOrders` from line 8 to 17. */
const SOURCE = [
  'using Shop.Data;',
  '',
  'namespace Shop.Orders;',
  '',
  'public static class OrdersEndpoints',
  '{',
  '    // Lists the orders of the signed-in customer.',
  '    public static async Task<IResult> ListOrders(ShopDb db, int page = 1)',
  '    {',
  '        var query = db.Orders.AsNoTracking();',
  '        var size = 25;',
  '        var rows = await query.Skip((page - 1) * size).Take(size).ToListAsync();',
  '        if (rows.Count == 0)',
  '            return Results.NoContent();',
  '        return Results.Ok(rows);',
  '        throw new InvalidOperationException();',
  '    }',
  '',
  '    public static void Unused() { }',
  '}',
]
  .join('\n')
  .concat('\n');

const at = (blob: string, lines: Array<[number, number]>) => ({
  v: 1,
  files: [{ path: ENDPOINTS, runtime: 'server', blob, functions: [[8, 17]], lines }],
});

async function submit(request: APIRequestContext, projectName: string, testCases: unknown[]): Promise<number> {
  const res = await retryPost(request, '/api/test-runs/submit', {
    data: {
      projectName,
      status: 'passed',
      startTime: new Date().toISOString(),
      duration: 10_000,
      totalTests: testCases.length,
      passedTests: testCases.length,
      failedTests: 0,
      skippedTests: 0,
      testCases,
    },
  });
  return ((await res.json()) as { runId: number }).runId;
}

const passed = (title: string, line: number, extra: Record<string, unknown> = {}) => ({
  title,
  location: `tests/orders.spec.ts:${line}:3`,
  status: 'passed',
  duration: 1200,
  retries: 0,
  ...extra,
});

async function projectIdOf(request: APIRequestContext, name: string): Promise<number> {
  const menu = await (await request.get('/api/projects/menu')).json();
  return (menu.items as Array<{ id: number; name: string }>).find((p) => p.name === name)!.id;
}

/** Serve the endpoints' source at `A`, the one version a repository would hold. */
async function serveSource(page: Page) {
  await page.route(
    (url) => url.pathname.endsWith('/source') && url.searchParams.get('blob') === A,
    (route) => route.fulfill({ json: { path: ENDPOINTS, blob: A, content: SOURCE } }),
  );
}

/** Open a node of the Test Map's graph, from the gap on the route the tests reach to the file. */
async function openFileNode(page: Page, projectId: number, request: APIRequestContext) {
  const gaps = await (await request.get(`/api/projects/${projectId}/gaps`)).json();
  const gap = (gaps.items as Array<{ id: number; subject: { kind: string; key: string } }>).find(
    (g) => g.subject.kind === 'route' && g.subject.key === 'POST /api/orders-file-coverage',
  )!;
  await page.goto(`/projects/${projectId}?tab=gaps`);
  await waitForHydration(page);
  await page.locator(`[data-shot="gap-${gap.id}"]`).getByRole('button', { name: 'View', exact: false }).click();
  const graph = page.locator('[data-shot="feature-graph"]');
  const inspector = graph.locator('[data-shot="node-inspector"]');
  await inspector.locator('button[title^="Open test:"]').first().click();
  await inspector.locator(`button[title="Open file:${ENDPOINTS} in the graph"]`).click();
  await expect(graph.locator('[data-shot="feature-graph-seed"]')).toContainText(`file:${ENDPOINTS}`);
  return graph;
}

/** Submit a run reaching the route, then recompute the Test Map once the run's graph is in. */
async function recomputeGaps(request: APIRequestContext, projectId: number) {
  await expect
    .poll(async () => {
      const graph = await (
        await request.get(`/api/projects/${projectId}/graph`, { params: { node: `file:${ENDPOINTS}`, depth: 1 } })
      ).json();
      return (graph.nodes ?? []).length;
    })
    .toBeGreaterThan(1);
  await retryPost(request, `/api/projects/${projectId}/gaps/recompute`, { data: {}, timeout: 20000 });
}

test.describe('File coverage', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  let projectId: number;
  let listsExecution: number;
  let offProjectId: number;

  test.beforeAll(async ({ request }) => {
    const runId = await submit(request, PROJECT.FILE_COVERAGE, [
      passed('lists the orders', 3, {
        coverage: at(A, [
          [10, 12],
          [15, 15],
        ]),
        networkRequests: [{ method: 'POST', url: ROUTE_URL, status: 201 }],
      }),
      passed('pages the orders', 9, { coverage: at(A, [[10, 11]]) }),
      passed('counts the orders', 15, { coverage: at(A, [[10, 10]]) }),
      passed('exports the orders', 21, { coverage: at(B, [[20, 21]]) }),
    ]);
    const put = await request.put(`/api/test-runs/${runId}/coverage`, {
      data: { v: 1, files: [{ path: ENDPOINTS, runtime: 'server', blob: A, executable: [[10, 16]] }] },
    });
    expect(put.ok()).toBe(true);
    const run = await (await request.get(`/api/test-runs/${runId}`)).json();
    listsExecution = (run.testCases as Array<{ title: string; executionId: number }>).find(
      (c) => c.title === 'lists the orders',
    )!.executionId;
    projectId = await projectIdOf(request, PROJECT.FILE_COVERAGE);
    await recomputeGaps(request, projectId);

    // Reach without coverage: the file is a node of the Test Map, but no test recorded its coverage.
    await submit(request, PROJECT.FILE_COVERAGE_OFF, [
      passed('lists the orders', 3, {
        codeReach: [ENDPOINTS],
        networkRequests: [{ method: 'POST', url: ROUTE_URL, status: 201 }],
      }),
    ]);
    offProjectId = await projectIdOf(request, PROJECT.FILE_COVERAGE_OFF);
    await recomputeGaps(request, offProjectId);
  });

  test('marks each line with how many tests ran it, and the executable lines no test runs', async ({ page }) => {
    await serveSource(page);
    await page.goto(`/projects/${projectId}/coverage?file=${ENDPOINTS}`);
    await waitForHydration(page);
    const view = page.locator('[data-shot="coverage-file"]');
    await expect(view.getByTestId('coverage-file-summary')).toHaveText(/^3 tests run 4 of its 7 executable lines on /);
    const source = view.locator('[data-coverage-source]');
    await expect(source.locator('[data-line]')).toHaveCount(20);
    const counts = await source
      .locator('[data-line]')
      .evaluateAll((rows) => rows.map((r) => r.querySelector('[data-tests]')?.getAttribute('data-tests') ?? ''));
    expect(counts.slice(9, 16)).toEqual(['3', '2', '1', '0', '0', '1', '0']);
    expect(counts.filter(Boolean)).toHaveLength(7);
    await expect(source.locator('[data-line="13"]')).toHaveAttribute('data-not-executed', '');
    await expect(view.locator('[data-coverage-test]')).toHaveCount(3);
  });

  test('a click on a line lists the tests that ran it; a Shift-click, those of a range', async ({ page }) => {
    await serveSource(page);
    await page.goto(`/projects/${projectId}/coverage?file=${ENDPOINTS}`);
    await waitForHydration(page);
    const view = page.locator('[data-shot="coverage-file"]');
    const selection = view.getByTestId('coverage-file-selection');
    const tests = view.locator('[data-coverage-test]');

    await view.locator('[data-line="12"]').click();
    await expect(selection).toHaveText('Line 12: 1 of the 3 tests ran it.');
    await expect(tests).toHaveCount(1);
    await expect(tests.first()).toHaveAttribute('data-coverage-test', 'lists the orders');
    await expect(tests.first()).toContainText('Last run passed');
    await expect(page).toHaveURL(/[?&]line=12(&|$)/);

    await view.locator('[data-line="11"]').click({ modifiers: ['Shift'] });
    await expect(selection).toHaveText('Lines 11 to 12: 2 of the 3 tests ran at least one of them.');
    await expect(view.locator('[data-line][data-selected]')).toHaveCount(2);

    // A line no test runs: the nearest test to copy runs the most of the function around it.
    await view.getByRole('button', { name: 'Line 13: 0 tests' }).click();
    await expect(selection).toHaveText('No test runs line 13.');
    await expect(view.locator('[data-nearest-test]')).toContainText('lists the orders');
    await expect(view.locator('[data-nearest-test]')).toContainText(
      'It runs 4 lines of ListOrders, the function around line 13.',
    );

    await view.getByRole('button', { name: 'All tests' }).click();
    await expect(tests).toHaveCount(3);
    await expect(page).not.toHaveURL(/[?&]line=/);
  });

  test('a version selector when the tests recorded several; a version without its source shows numbers', async ({
    page,
  }) => {
    await serveSource(page);
    await page.goto(`/projects/${projectId}/coverage?file=${ENDPOINTS}`);
    await waitForHydration(page);
    const view = page.locator('[data-shot="coverage-file"]');
    const version = view.getByTestId('coverage-file-version');
    await expect(version).toContainText('a1b2c3d · 3 tests');
    await version.click();
    await page.getByRole('option', { name: '9f8e7d6 · 1 test' }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]blob=${B}`));
    await expect(view.getByTestId('coverage-file-summary')).toHaveText(/^1 test runs 2 lines of this file on /);
    await expect(view.getByTestId('coverage-file-no-source')).toBeVisible();
    await view.locator('[data-line-group="20 to 21"]').click();
    await expect(view.locator('[data-coverage-test]')).toHaveCount(1);
    await expect(view.locator('[data-coverage-test]').first()).toHaveAttribute(
      'data-coverage-test',
      'exports the orders',
    );
  });

  test('the execution page links a covered file at its first executed line', async ({ page }) => {
    await serveSource(page);
    await page.goto(`/test-run-cases/${listsExecution}?evidence=source`);
    await waitForHydration(page);
    const row = page.locator(`[data-shot="execution-coverage"] [data-coverage-file="${ENDPOINTS}"]`);
    await row.getByRole('link', { name: 'tests' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/coverage\\?file=.+&line=10$`));
    const view = page.locator('[data-shot="coverage-file"]');
    await expect(view.getByTestId('coverage-file-selection')).toHaveText('Line 10: All 3 tests ran it.');
    await expect(view.locator('[data-line="10"]')).toHaveAttribute('data-selected', '');
  });

  test('the Test Map links a file its tests recorded coverage of', async ({ page, request }) => {
    const graph = await openFileNode(page, projectId, request);
    const link = graph.locator('[data-coverage-link]');
    await expect(link).toHaveText('the lines they run');
    await expect(link).toHaveAttribute(
      'href',
      new RegExp(`/projects/${projectId}/coverage\\?file=src(%2F|/)Orders(%2F|/)OrdersEndpoints\\.cs$`),
    );
  });

  test('a project that records no coverage shows no entry point, and its page one sentence', async ({
    page,
    request,
  }) => {
    const graph = await openFileNode(page, offProjectId, request);
    await expect(graph.locator('[data-shot="feature-graph-seed"]')).toContainText('reached by 1 test');
    await expect(graph.locator('[data-coverage-link]')).toHaveCount(0);
    await expect(page.locator('a[href*="/coverage?file="]')).toHaveCount(0);

    await page.goto(`/projects/${offProjectId}/coverage?file=${ENDPOINTS}`);
    await waitForHydration(page);
    const view = page.locator('[data-shot="coverage-file"]');
    await expect(view).toHaveText('This project records no coverage.');
  });
});
