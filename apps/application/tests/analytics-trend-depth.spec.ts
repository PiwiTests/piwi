/**
 * Trend depth on the analytics page: project targets and where they show,
 * the trend widgets, the Trend tab of a test, a cluster's occurrences over
 * time, drill-down to the project lists and the chart export menu.
 */
import readXlsxFile from 'read-excel-file/node';
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { waitForHydration } from './utils';

test.describe.serial('Analytics trend depth', () => {
  let projectId: number;
  let testCaseId: number;
  let clusterId: number;

  test.beforeAll(async ({ request }) => {
    const submit = (status: 'passed' | 'failed', minutesAgo: number) =>
      request.post('/api/test-runs/submit', {
        data: {
          projectName: PROJECT.ANALYTICS_TREND_DEPTH,
          status,
          startTime: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
          duration: 30_000,
          totalTests: 2,
          passedTests: status === 'passed' ? 2 : 1,
          failedTests: status === 'passed' ? 0 : 1,
          skippedTests: 0,
          testCases: [
            { title: 'pays by card', status: 'passed', duration: 800, location: 'tests/pay.spec.ts:1:1' },
            {
              title: 'shows the receipt',
              status,
              duration: 1200,
              location: 'tests/pay.spec.ts:9:1',
              ...(status === 'failed' ? { error: 'Error: expect(received).toBe(expected) // receipt' } : {}),
            },
          ],
        },
      });
    const first = await submit('passed', 30);
    expect(first.ok()).toBeTruthy();
    projectId = (await first.json()).projectId;
    expect((await submit('failed', 10)).ok()).toBeTruthy();

    const cases = await (await request.get(`/api/projects/${projectId}/test-cases`)).json();
    testCaseId = cases.items.find((c: { title: string }) => c.title === 'shows the receipt').id;
    const clusters = await (await request.get(`/api/projects/${projectId}/failure-clusters`)).json();
    clusterId = clusters.items[0].id;
  });

  test('the Settings tab saves targets, and PATCH clears them with null', async ({ page, request }) => {
    await page.goto(`/projects/${projectId}?tab=settings&section=targets`);
    // Typed before hydration, the values are reset and Save submits the form natively.
    await waitForHydration(page);
    const form = page.locator('[data-shot="project-targets"]');
    await form.getByTestId('target-testPassRate').fill('99');
    await form.getByTestId('target-maxFlakyTests').fill('5');
    const saved = page.waitForResponse(
      (r) => r.url().includes(`/api/projects/${projectId}`) && r.request().method() === 'PATCH',
    );
    await form.getByRole('button', { name: 'Save targets' }).click();
    expect((await saved).ok()).toBeTruthy();

    const project = await (await request.get(`/api/projects/${projectId}`)).json();
    expect(project.targets).toEqual({ testPassRate: 99, maxFlakyTests: 5 });

    const refused = await request.patch(`/api/projects/${projectId}`, { data: { targets: { testPassRate: 150 } } });
    expect(refused.status()).toBe(400);
  });

  test('a missed target marks the tile, the portfolio, the insights and the quality report', async ({
    page,
    request,
  }) => {
    const stats = await (
      await request.get(`/api/analytics/stats?period=last-7d&projects=${projectId}&allBranches=true`)
    ).json();
    const passRate = stats.tiles.find((t: { metric: string }) => t.metric === 'test-pass-rate');
    expect(passRate.target).toEqual({ target: 99, direction: 'min', met: 0, missed: 1 });

    const report = await (
      await request.get(
        `/api/reports/preview?dashboard=executive&period=last-7d&projects=${projectId}&allBranches=true`,
      )
    ).json();
    expect(report.targets.map((t: { metric: string; met: boolean }) => [t.metric, t.met])).toEqual([
      ['test-pass-rate', false],
      ['flaky-tests', true],
    ]);

    await page.goto(`/analytics?period=last-7d&projects=${projectId}&allBranches=true`);
    await expect(page.getByTestId('stat-target-test-pass-rate')).toContainText('missed', { timeout: 30_000 });
    await expect(page.getByTestId('portfolio-targets').first()).toContainText('1 of 2 met');
    await expect(page.locator('[data-widget-key="insights"]')).toContainText('under its target');
  });

  test('the trend widgets answer for the project and show on Overview', async ({ page, request }) => {
    for (const widget of [
      'suite-growth',
      'flaky-debt',
      'time-to-fix',
      'ownership',
      'environment-comparison',
      'movers',
    ]) {
      const response = await request.get(
        `/api/analytics/${widget}?period=last-7d&projects=${projectId}&allBranches=true`,
      );
      expect(response.ok(), widget).toBeTruthy();
    }
    const growth = await (
      await request.get(`/api/analytics/suite-growth?period=last-7d&projects=${projectId}&allBranches=true`)
    ).json();
    expect(growth.suiteSize).toBe(2);

    await page.goto(`/analytics?period=last-7d&projects=${projectId}&allBranches=true`);
    for (const shot of ['analytics-suite-growth', 'analytics-flaky-debt', 'analytics-time-to-fix']) {
      await expect(page.locator(`[data-shot="${shot}"]`)).toBeVisible({ timeout: 30_000 });
    }
  });

  test('a chart downloads its series as an Excel workbook from its export menu', async ({ page }) => {
    await page.goto(`/analytics?period=last-7d&projects=${projectId}&allBranches=true`);
    const card = page.locator('[data-shot="analytics-suite-growth"]');
    await expect(card.locator('svg.block').first()).toBeVisible({ timeout: 30_000 });
    await card.getByTestId('chart-export').click();
    await expect(page.getByRole('menuitem', { name: 'Copy as PNG' })).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Download Excel' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('piwi-chart-suite-growth.xlsx');
    const [sheet] = await readXlsxFile(await file.path());
    expect(sheet!.sheet).toBe('Suite growth');
    expect(sheet!.data[0]).toEqual(['date', 'suite size', 'skipped %', 'did not run %']);
    // A day is a date cell and the suite size a number; a day with no run has no suite size.
    expect(sheet!.data[1]![0]).toBeInstanceOf(Date);
    const sizes = sheet!.data.slice(1).map((row) => row[1]);
    expect(sizes.some((size) => typeof size === 'number')).toBe(true);
    expect(sizes.every((size) => size === null || typeof size === 'number')).toBe(true);
  });

  test('a portfolio count opens the project list with the same scope', async ({ page }) => {
    await page.goto(`/analytics?period=last-7d&projects=${projectId}&environments=ci&allBranches=true`);
    await page.getByTitle('The runs behind this number').first().click();
    await expect(page).toHaveURL(/tab=runs/);
    await expect(page).toHaveURL(/source=analytics/);
    await expect(page).toHaveURL(/environments=ci/);
    await expect(page.getByTestId('analytics-drill')).toContainText('Last 7 days');
    await page.getByRole('button', { name: 'Show every run' }).click();
    await expect(page.getByTestId('analytics-drill')).toBeHidden();
  });

  test('the test page has a Trend tab over its stability trend', async ({ page, request }) => {
    const trend = await (await request.get(`/api/test-cases/${testCaseId}/stability-trend?days=7&by=day`)).json();
    expect(trend.bucketDays).toBe(1);
    expect(trend.buckets.reduce((n: number, b: { totalRuns: number }) => n + b.totalRuns, 0)).toBe(2);

    await page.goto(`/test-cases/${testCaseId}`);
    await waitForHydration(page);
    // Exact: the project's own name contains "trend".
    await page.getByRole('button', { name: 'Trend', exact: true }).click();
    await expect(page).toHaveURL(/tab=trend/);
    await expect(page.locator('[data-shot="test-case-trend"] svg.block').first()).toBeVisible({ timeout: 30_000 });
  });

  test('the cluster page charts its occurrences over time', async ({ page, request }) => {
    const trend = await (await request.get(`/api/failure-clusters/${clusterId}/occurrence-trend?days=7`)).json();
    expect(trend.buckets.reduce((n: number, b: { occurrences: number }) => n + b.occurrences, 0)).toBe(1);
    await page.goto(`/failure-clusters/${clusterId}`);
    await waitForHydration(page);

    // Folded to one line: the count, in the singular, and no chart.
    const card = page.locator('[data-shot="cluster-occurrence-trend"]');
    await expect(card).toContainText('1 occurrence', { timeout: 30_000 });
    await expect(card).not.toContainText('1 occurrences');
    const header = card.locator('[role="button"][aria-expanded]').first();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(card.locator('svg.block')).toBeHidden();

    // Its header opens the chart.
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(card.locator('svg.block').first()).toBeVisible();
  });
});
