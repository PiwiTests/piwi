import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * The Coverage section of the execution page's Source tab: what the test ran,
 * server files by executed lines and browser files recorded by file by path; a
 * server file unfolds to its source at the blob its coverage names, marking the
 * lines the test ran and the executable lines it did not, or to the line numbers alone
 * when the repository cannot serve the source. A test with no coverage says so
 * in one line, and a project that records no coverage shows no section at all.
 */

const BLOB = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const ENDPOINTS = 'src/Orders/OrdersEndpoints.cs';
const SESSION = 'src/Auth/Session.cs';

/** The endpoints' source: `ListOrders` from line 8 to 20. */
const ENDPOINTS_SOURCE = [
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

async function executionIds(request: APIRequestContext, runId: number): Promise<Record<string, number>> {
  const run = await (await request.get(`/api/test-runs/${runId}`)).json();
  return Object.fromEntries(
    (run.testCases as Array<{ title: string; executionId: number }>).map((c) => [c.title, c.executionId]),
  );
}

const passed = (title: string, line: number, coverage?: unknown) => ({
  title,
  location: `tests/orders.spec.ts:${line}:3`,
  status: 'passed',
  duration: 1200,
  retries: 0,
  ...(coverage ? { coverage } : {}),
});

test.describe('Execution coverage', () => {
  test.describe.configure({ mode: 'serial' });

  let runId: number;
  let lists: number;
  let opens: number;
  let health: number;
  let uncovered: number;

  test.beforeAll(async ({ request }) => {
    runId = await submit(request, PROJECT.EXECUTION_COVERAGE, [
      passed('lists the orders', 3, {
        v: 1,
        files: [
          { path: SESSION, runtime: 'server', blob: BLOB, functions: [[2, 5]], lines: [[3, 3]] },
          {
            path: ENDPOINTS,
            runtime: 'server',
            blob: BLOB,
            functions: [[8, 17]],
            lines: [
              [10, 12],
              [15, 15],
            ],
          },
          { path: 'src/pages/orders.vue', runtime: 'browser' },
          { path: 'src/components/OrderTable.vue', runtime: 'browser' },
        ],
      }),
      passed('opens an order', 9, { v: 1, files: [{ path: 'src/pages/order.vue', runtime: 'browser' }] }),
      passed('checks the health', 15),
    ]);
    const put = await request.put(`/api/test-runs/${runId}/coverage`, {
      data: { v: 1, files: [{ path: ENDPOINTS, runtime: 'server', blob: BLOB, executable: [[10, 16]] }] },
    });
    expect(put.ok()).toBe(true);
    const ids = await executionIds(request, runId);
    lists = ids['lists the orders']!;
    opens = ids['opens an order']!;
    health = ids['checks the health']!;

    const offRun = await submit(request, PROJECT.EXECUTION_COVERAGE_OFF, [passed('lists the orders', 3)]);
    uncovered = (await executionIds(request, offRun))['lists the orders']!;
  });

  test('lists what the test ran: server files by executed lines, browser files by path', async ({ page }) => {
    await page.goto(`/test-run-cases/${lists}?evidence=source`);
    await waitForHydration(page);
    const section = page.locator('[data-shot="execution-coverage"]');
    await expect(section.getByTestId('coverage-summary')).toHaveText(
      'Ran 2 server files (5 lines) and 2 browser files.',
    );
    const server = section.locator('[data-coverage-group="server"] [data-coverage-file]');
    await expect(server).toHaveCount(2);
    expect(await server.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-coverage-file')))).toEqual([
      ENDPOINTS,
      SESSION,
    ]);
    await expect(server.first()).toContainText('by line · 4 lines, 1 function');
    await expect(server.first().getByRole('link', { name: 'tests' })).toHaveAttribute(
      'href',
      /\/projects\/\d+\/coverage\?file=src(%2F|\/)Orders(%2F|\/)OrdersEndpoints\.cs&line=10$/,
    );
    const browser = section.locator('[data-coverage-group="browser"] [data-coverage-file]');
    expect(await browser.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-coverage-file')))).toEqual([
      'src/components/OrderTable.vue',
      'src/pages/orders.vue',
    ]);
    await expect(browser.first()).toContainText('by file');
    // A browser file recorded by file has no line to show in its source, so it does not unfold.
    await expect(section.getByRole('button', { name: /^Show the source of src\/pages/ })).toHaveCount(0);
  });

  test('unfolds a server file to its source: what ran, and the executable lines that did not', async ({ page }) => {
    await page.route(
      (url) => url.pathname.endsWith('/source') && url.searchParams.get('blob') === BLOB,
      (route) => route.fulfill({ json: { path: ENDPOINTS, blob: BLOB, content: ENDPOINTS_SOURCE } }),
    );
    await page.goto(`/test-run-cases/${lists}?evidence=source`);
    await waitForHydration(page);
    const section = page.locator('[data-shot="execution-coverage"]');
    await section.getByRole('button', { name: `Show the source of ${ENDPOINTS}` }).click();
    const source = section.locator('[data-coverage-source]');
    await expect(source.locator('[data-line]')).toHaveCount(20);
    const marks = await source
      .locator('[data-line]')
      .evaluateAll((rows) =>
        rows.map((r) =>
          r.hasAttribute('data-executed') ? 'ran' : r.hasAttribute('data-not-executed') ? 'not run' : '',
        ),
      );
    expect(marks.slice(9, 16)).toEqual(['ran', 'ran', 'ran', 'not run', 'not run', 'ran', 'not run']);
    expect(marks.filter(Boolean)).toHaveLength(7);
    await expect(source).toContainText('Functions that ran: ListOrders');
    await expect(source).toContainText('Ran in this test');
    await expect(source).toContainText('Did not run in this test');
  });

  test('without the source, the line numbers say what ran and what did not', async ({ page }) => {
    await page.goto(`/test-run-cases/${lists}?evidence=source`);
    await waitForHydration(page);
    const section = page.locator('[data-shot="execution-coverage"]');
    await section.getByRole('button', { name: `Show the source of ${ENDPOINTS}` }).click();
    await expect(section.locator('[data-executed-lines]')).toHaveText('10 to 12, 15');
    await expect(section.locator('[data-not-executed-lines]')).toHaveText('13 to 14, 16');
  });

  test('a test of the run with browser files only: the backend recorded none for it', async ({ page }) => {
    await page.goto(`/test-run-cases/${opens}?evidence=source`);
    await waitForHydration(page);
    const section = page.locator('[data-shot="execution-coverage"]');
    await expect(section.getByTestId('coverage-summary')).toHaveText('Ran 1 browser file.');
    await expect(section.getByTestId('coverage-no-backend')).toHaveText(
      'The backend recorded no coverage for this test.',
    );
  });

  test('a test that recorded none says so in one line', async ({ page }) => {
    await page.goto(`/test-run-cases/${health}?evidence=source`);
    await waitForHydration(page);
    await expect(page.getByTestId('coverage-none')).toHaveText('This execution recorded no coverage.');
    await expect(page.locator('[data-coverage-group]')).toHaveCount(0);
  });

  test('a project that records no coverage shows no Coverage section', async ({ page }) => {
    await page.goto(`/test-run-cases/${uncovered}?evidence=source`);
    await waitForHydration(page);
    await expect(
      page.getByRole('heading', { name: 'Test source' }).or(page.getByText('No test source captured')),
    ).toBeVisible();
    await expect(page.locator('[data-shot="execution-coverage"]')).toHaveCount(0);
    await expect(page.locator('[data-shot="evidence-card"]')).not.toContainText('coverage');
  });
});
