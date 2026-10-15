import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * The coverage insights in the dashboard, for a project that records coverage:
 * a failed execution compared with the test's last passing run in its Coverage
 * section, a test's Path variation card naming the earlier test its path
 * depends on, and what quarantining a test leaves to no other trusted test,
 * beside the flaky list's Quarantine button and under the execution page's
 * More menu. A project that records no coverage shows none of them.
 *
 * Eight runs of three tests: `totals the basket` runs the coupon branch of the
 * basket service and fails whenever `seeds a coupon` finished before it
 * started, and passes otherwise; `checks out` runs part of the same file.
 */

const BLOB = 'b1c2d3e4f5a60718293a4b5c6d7e8f9012345678';
const BASKET = 'src/Basket/BasketService.cs';
const COUPONS = 'src/Coupons/CouponStore.cs';
const RUNS = 8;

/** The basket service's source: 70 lines, the coupon branch from line 50 to 60. */
const BASKET_SOURCE = Array.from({ length: 70 }, (_, i) => `// line ${i + 1}`)
  .join('\n')
  .concat('\n');

const server = (path: string, lines: Array<[number, number]>, functions: Array<[number, number]>) => ({
  path,
  runtime: 'server',
  blob: BLOB,
  functions,
  lines,
});

/** Runs, oldest first; in each even one the coupon test finishes before the basket test starts. */
function runCases(index: number, start: number) {
  const before = index % 2 === 0;
  const location = (line: number) => `tests/basket.spec.ts:${line}:3`;
  return [
    {
      title: 'checks out',
      location: location(15),
      status: 'passed',
      duration: 500,
      retries: 0,
      workerIndex: 0,
      startedAt: start,
      coverage: { v: 1, files: [server(BASKET, [[40, 45]], [[38, 66]])] },
    },
    {
      title: 'seeds a coupon',
      location: location(3),
      status: 'passed',
      duration: 1000,
      retries: 0,
      workerIndex: 1,
      startedAt: before ? start + 100 : start + 5000,
      coverage: { v: 1, files: [server(COUPONS, [[10, 14]], [[8, 16]])] },
    },
    before
      ? {
          title: 'totals the basket',
          location: location(9),
          status: 'failed',
          error: 'Error: expect(received).toBe(expected)\n\nExpected: 100\nReceived: 90',
          duration: 1500,
          retries: 0,
          workerIndex: 2,
          startedAt: start + 2000,
          coverage: {
            v: 1,
            files: [
              server(
                BASKET,
                [
                  [40, 45],
                  [50, 60],
                ],
                [[38, 66]],
              ),
            ],
          },
        }
      : {
          title: 'totals the basket',
          location: location(9),
          status: 'passed',
          duration: 1500,
          retries: 0,
          workerIndex: 2,
          startedAt: start + 2000,
          coverage: {
            v: 1,
            files: [
              server(
                BASKET,
                [
                  [40, 45],
                  [62, 63],
                ],
                [[38, 66]],
              ),
            ],
          },
        },
  ];
}

async function submit(request: APIRequestContext, projectName: string, start: number, testCases: unknown[]) {
  const failed = testCases.filter((c) => (c as { status: string }).status === 'failed').length;
  const res = await retryPost(request, '/api/test-runs/submit', {
    data: {
      projectName,
      status: failed > 0 ? 'failed' : 'passed',
      startTime: new Date(start).toISOString(),
      duration: 10_000,
      totalTests: testCases.length,
      passedTests: testCases.length - failed,
      failedTests: failed,
      skippedTests: 0,
      testCases,
    },
  });
  return ((await res.json()) as { runId: number }).runId;
}

async function executions(request: APIRequestContext, runId: number) {
  const run = await (await request.get(`/api/test-runs/${runId}`)).json();
  return run.testCases as Array<{ title: string; executionId: number; testCaseId: number; status: string }>;
}

/** Open the project's flaky tests and hover the Quarantine button of a test's row. */
async function hoverQuarantine(page: Page, projectId: number, title: string) {
  await page.goto(`/projects/${projectId}?tab=flaky-tests`);
  await waitForHydration(page);
  const row = page.locator('[data-shot="flaky-table"] [data-tour="flaky-test-row"]').filter({ hasText: title });
  await row.getByRole('button', { name: 'Quarantine', exact: true }).hover();
}

test.describe('Coverage insights', () => {
  test.describe.configure({ mode: 'serial' });

  let projectId: number;
  let failedId: number;
  let passedId: number;
  let baselineId: number;
  let basketTest: number;
  let couponTest: number;
  let checkoutTest: number;
  let offProjectId: number;
  let offFailedId: number;
  let offBasketTest: number;

  test.beforeAll(async ({ request }) => {
    const first = Date.now() - RUNS * 3_600_000;
    const runs: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const start = first + i * 3_600_000;
      runs.push(await submit(request, PROJECT.COVERAGE_INSIGHTS, start, runCases(i, start)));
    }
    // The newest run is a pass of the basket test, the one before it a failure.
    const newest = await executions(request, runs[RUNS - 1]!);
    const previous = await executions(request, runs[RUNS - 2]!);
    const beforeThat = await executions(request, runs[RUNS - 3]!);
    const byTitle = (list: typeof newest, title: string) => list.find((c) => c.title === title)!;
    failedId = byTitle(previous, 'totals the basket').executionId;
    passedId = byTitle(newest, 'totals the basket').executionId;
    baselineId = byTitle(beforeThat, 'totals the basket').executionId;
    basketTest = byTitle(newest, 'totals the basket').testCaseId;
    couponTest = byTitle(newest, 'seeds a coupon').testCaseId;
    checkoutTest = byTitle(newest, 'checks out').testCaseId;
    const run = await (await request.get(`/api/test-runs/${runs[0]}`)).json();
    projectId = run.project?.id ?? run.projectId;

    const offRuns: number[] = [];
    for (let i = 0; i < 4; i++) {
      const start = first + i * 3_600_000;
      const cases = runCases(i, start).map(({ coverage: _coverage, ...rest }) => rest);
      offRuns.push(await submit(request, PROJECT.COVERAGE_INSIGHTS_OFF, start, cases));
    }
    const offFailing = await executions(request, offRuns[2]!);
    offFailedId = offFailing.find((c) => c.title === 'totals the basket')!.executionId;
    offBasketTest = offFailing.find((c) => c.title === 'totals the basket')!.testCaseId;
    const offRun = await (await request.get(`/api/test-runs/${offRuns[0]}`)).json();
    offProjectId = offRun.project?.id ?? offRun.projectId;
  });

  test('a failed execution names the code it ran apart from its last passing run', async ({ page }) => {
    await page.route(
      (url) => url.pathname.endsWith('/source') && url.searchParams.get('blob') === BLOB,
      (route) => route.fulfill({ json: { path: BASKET, blob: BLOB, content: BASKET_SOURCE } }),
    );
    await page.goto(`/test-run-cases/${failedId}?evidence=source`);
    await waitForHydration(page);
    const part = page.getByTestId('coverage-divergence');
    await expect(part).toContainText('Compared with the last passing run');
    await expect(part.getByTestId('coverage-divergence-baseline')).toContainText(`#${baselineId}`);
    const row = part.locator(`[data-divergence-file="${BASKET}"]`);
    await expect(row).toHaveAttribute('data-divergence-status', 'diverged');
    await expect(row).toContainText('here: lines 50 to 60 · in the pass: lines 62 to 63');
    // The coupon store ran in no basket execution, so it is no difference.
    await expect(part.locator(`[data-divergence-file="${COUPONS}"]`)).toHaveCount(0);

    await part.getByRole('button', { name: `Show what each run ran in ${BASKET}` }).click();
    const source = part.locator('[data-coverage-source]');
    await expect(source.locator('[data-line][data-executed]')).toHaveCount(11);
    await expect(source.locator('[data-line][data-not-executed]')).toHaveCount(2);
    await expect(source).toContainText('Ran only in this execution');
    await expect(source).toContainText('Ran only in the passing run');
  });

  test('a passing execution is compared with nothing', async ({ page }) => {
    await page.goto(`/test-run-cases/${passedId}?evidence=source`);
    await waitForHydration(page);
    await expect(page.getByTestId('coverage-summary')).toBeVisible();
    await expect(page.locator('[data-testid^="coverage-divergence"]')).toHaveCount(0);
  });

  test('the test page names the earlier test its path depends on', async ({ page }) => {
    await page.goto(`/test-cases/${basketTest}`);
    await waitForHydration(page);
    const card = page.getByTestId('path-variation');
    await expect(card.getByTestId('path-variation-headline')).toHaveText(
      `Takes a different path in ${RUNS / 2} of ${RUNS} recent executions.`,
    );
    const explanation = card.getByTestId('path-variation-explanation');
    await expect(explanation).toContainText(
      `In ${RUNS / 2} of ${RUNS / 2} executions where seeds a coupon finished earlier in the run, it ran this code`,
    );
    await expect(explanation).toContainText(`in 0 of ${RUNS / 2} otherwise:`);
    await expect(card.getByTestId('path-variation-explained-code')).toContainText(BASKET);
    await expect(explanation.getByRole('link', { name: 'seeds a coupon' })).toHaveAttribute(
      'href',
      `/test-cases/${couponTest}`,
    );
    await expect(card.getByTestId('path-variation-order')).toContainText('Its failures follow that difference');
    await expect(card.locator(`[data-varying-file="${BASKET}"]`).first()).toBeVisible();
  });

  test('a test whose path never varies shows no card', async ({ page }) => {
    await page.goto(`/test-cases/${checkoutTest}`);
    await waitForHydration(page);
    await expect(page.getByRole('heading', { name: /Recent executions/ })).toBeVisible();
    await expect(page.getByTestId('path-variation')).toHaveCount(0);
  });

  test('the Quarantine button says what quarantining the test leaves uncovered', async ({ page }) => {
    await hoverQuarantine(page, projectId, 'totals the basket');
    const preview = page.getByTestId('coverage-loss-preview');
    await expect(preview).toContainText('Leaves 2 lines in 1 file run by no other trusted test');
    await expect(preview.locator(`[data-loss-file="${BASKET}"]`)).toContainText('lines 62 to 63');
  });

  test('the execution page’s More menu says it under Quarantine this test', async ({ page }) => {
    await page.goto(`/test-run-cases/${failedId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: /Quarantine this test/ })).toContainText(
      'Leaves 2 lines in 1 file run by no other trusted test',
    );
  });

  test('a project that records no coverage shows none of it', async ({ page }) => {
    await page.goto(`/test-run-cases/${offFailedId}?evidence=source`);
    await waitForHydration(page);
    await expect(page.locator('[data-shot="evidence-card"]')).toBeVisible();
    await expect(page.locator('[data-testid^="coverage-divergence"]')).toHaveCount(0);

    await page.goto(`/test-cases/${offBasketTest}`);
    await waitForHydration(page);
    await expect(page.getByRole('heading', { name: /Recent executions/ })).toBeVisible();
    await expect(page.getByTestId('path-variation')).toHaveCount(0);

    await hoverQuarantine(page, offProjectId, 'totals the basket');
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('coverage-loss-preview')).toHaveCount(0);
  });
});
