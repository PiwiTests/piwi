import { test, expect, type APIRequestContext } from './fixtures';
import { waitForHydration } from './utils';
import { PROJECT } from '#shared/test-project-names';

test.describe.serial('Run Comparison', () => {
  let projectId: number;
  let run1Id: number;
  let run2Id: number;
  let run3Id: number;

  test('submit three runs with overlapping test cases', async ({ request }) => {
    // Run 1 — 3 tests, all passed
    const res1 = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.RUN_COMPARE,
        status: 'passed',
        startTime: new Date(Date.now() - 180000).toISOString(),
        duration: 30000,
        totalTests: 3,
        passedTests: 3,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'login works',
            status: 'passed',
            duration: 500,
            location: 'tests/auth.spec.ts:10:5',
            retries: 0,
          },
          {
            title: 'dashboard loads',
            status: 'passed',
            duration: 1200,
            location: 'tests/dashboard.spec.ts:5:3',
            retries: 0,
          },
          {
            title: 'profile page',
            status: 'passed',
            duration: 800,
            location: 'tests/profile.spec.ts:15:7',
            retries: 0,
          },
        ],
      },
    });
    expect(res1.ok()).toBeTruthy();
    const data1 = await res1.json();
    run1Id = data1.runId;
    projectId = data1.projectId;

    // Run 2 — same 3 tests, different durations, one failure
    const res2 = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.RUN_COMPARE,
        status: 'failed',
        startTime: new Date(Date.now() - 120000).toISOString(),
        duration: 35000,
        totalTests: 3,
        passedTests: 2,
        failedTests: 1,
        skippedTests: 0,
        testCases: [
          {
            title: 'login works',
            status: 'passed',
            duration: 300,
            location: 'tests/auth.spec.ts:10:5',
            retries: 0,
            webVitals: { navigation: { url: 'http://localhost:3000/login', ttfb: 40, loadComplete: 280 } },
          },
          {
            title: 'dashboard loads',
            status: 'failed',
            duration: 5000,
            location: 'tests/dashboard.spec.ts:5:3',
            error: 'Element not found',
            retries: 1,
          },
          {
            title: 'profile page',
            status: 'passed',
            duration: 750,
            location: 'tests/profile.spec.ts:15:7',
            retries: 0,
          },
        ],
      },
    });
    expect(res2.ok()).toBeTruthy();
    const data2 = await res2.json();
    run2Id = data2.runId;

    // Run 3 — 2 tests (subset), new test added, one removed
    const res3 = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.RUN_COMPARE,
        status: 'passed',
        startTime: new Date(Date.now() - 60000).toISOString(),
        duration: 25000,
        totalTests: 2,
        passedTests: 2,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'login works',
            status: 'passed',
            duration: 550,
            location: 'tests/auth.spec.ts:10:5',
            retries: 0,
          },
          {
            title: 'settings page',
            status: 'passed',
            duration: 900,
            location: 'tests/settings.spec.ts:20:9',
            retries: 0,
          },
        ],
      },
    });
    expect(res3.ok()).toBeTruthy();
    const data3 = await res3.json();
    run3Id = data3.runId;
  });

  test('project should list all three runs', async ({ request }) => {
    const res = await request.get(`/api/projects/${projectId}`);
    expect(res.ok()).toBeTruthy();
    const project = await res.json();
    expect(Array.isArray(project.testRuns)).toBe(true);
    const ourRuns = project.testRuns.filter((r: { id: number }) => [run1Id, run2Id, run3Id].includes(r.id));
    expect(ourRuns.length).toBe(3);
  });

  test('each run should contain test cases', async ({ request }) => {
    for (const runId of [run1Id, run2Id, run3Id]) {
      const res = await request.get(`/api/test-runs/${runId}`);
      expect(res.ok()).toBeTruthy();
      const run = await res.json();
      expect(Array.isArray(run.testCases)).toBe(true);
      expect(run.testCases.length).toBeGreaterThan(0);
    }
  });

  test('selecting two runs and comparing opens the newer run’s Changes tab', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=runs`);
    await waitForHydration(page);

    await page.getByRole('checkbox', { name: `Select run #${run1Id}` }).check();
    await page.getByRole('checkbox', { name: `Select run #${run2Id}` }).check();

    await page.getByRole('button', { name: 'Compare', exact: true }).click();

    const newer = Math.max(run1Id, run2Id);
    const older = Math.min(run1Id, run2Id);
    await page.waitForURL(new RegExp(`/test-runs/${newer}\\?tab=changes&baseline=${older}`));
  });

  test('the retired compare tab and route both land on the Runs tab', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=compare`);
    await waitForHydration(page);
    await expect(page).toHaveURL(/[?&]tab=runs/);

    await page.goto(`/projects/${projectId}/compare`);
    await page.waitForURL(new RegExp(`/projects/${projectId}\\?tab=runs`));
  });

  test('run detail Changes tab compares against a baseline', async ({ page }) => {
    await page.goto(`/test-runs/${run2Id}?tab=changes`);
    await waitForHydration(page);

    // The Changes tab reads run 2 against one baseline (run 1, the last passing run).
    await expect(page.getByText('Compared with')).toBeVisible({ timeout: 15000 });

    // "dashboard loads" passed in run 1 and failed in run 2, so it is a new failure.
    await expect(page.getByText('New failures')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('dashboard loads')).toBeVisible();
  });

  test('a test under Slower / faster opens its execution on the Performance tab', async ({ page }) => {
    await page.goto(`/test-runs/${run2Id}?tab=changes`);
    await waitForHydration(page);

    // "login works" took 500 ms in run 1 and 300 ms in run 2.
    await page.getByRole('link', { name: /login works/ }).click();
    await page.waitForURL(/\/test-run-cases\/\d+\?evidence=performance$/);
    await expect(page.getByRole('tab', { name: /^Performance/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('TTFB', { exact: true })).toBeVisible();
  });
});

/**
 * A project whose runs never passed: the first run has nothing to compare
 * with, a run whose only earlier run was interrupted offers that run to pick,
 * and a later run is compared with the last failed run, which the note says.
 */
test.describe.serial('Changes tab without a passing run', () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const testCase = (title: string, status: 'passed' | 'failed', line: number) => ({
    title,
    status,
    duration: 400,
    location: `tests/cart.spec.ts:${line}:3`,
    retries: 0,
    ...(status === 'failed' ? { error: 'Error: expect(received).toBe(expected)' } : {}),
  });

  async function submit(
    request: APIRequestContext,
    status: string,
    minutes: number,
    cases: ReturnType<typeof testCase>[],
  ): Promise<number> {
    const failed = cases.filter((c) => c.status === 'failed').length;
    const res = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.RUN_CHANGES_FALLBACK,
        status,
        startTime: minutesAgo(minutes),
        duration: 1000,
        totalTests: cases.length,
        passedTests: cases.length - failed,
        failedTests: failed,
        skippedTests: 0,
        metadata: { scm: { branch: 'main' } },
        testCases: cases,
      },
    });
    expect(res.ok()).toBeTruthy();
    return (await res.json()).runId;
  }

  let interrupted = 0;
  let firstFailed = 0;
  let latest = 0;

  test('seeds an interrupted run, then two failed runs', async ({ request }) => {
    interrupted = await submit(request, 'interrupted', 30, [testCase('cart total', 'passed', 5)]);
    firstFailed = await submit(request, 'failed', 20, [
      testCase('cart total', 'passed', 5),
      testCase('coupon applies', 'failed', 12),
    ]);
    latest = await submit(request, 'failed', 10, [
      testCase('cart total', 'failed', 5),
      testCase('coupon applies', 'passed', 12),
    ]);
  });

  test('the first run has no earlier run to compare with', async ({ page }) => {
    await page.goto(`/test-runs/${interrupted}?tab=changes`);
    await waitForHydration(page);
    await expect(page.getByText('No earlier run to compare with')).toBeVisible({ timeout: 15000 });
  });

  test('with only an interrupted run before it, a run offers that run to pick', async ({ page }) => {
    await page.goto(`/test-runs/${firstFailed}?tab=changes`);
    await waitForHydration(page);
    await expect(page.getByText('No baseline run found')).toBeVisible({ timeout: 15000 });

    await page.getByTitle('Compare against one earlier run').click();
    const option = page.getByRole('option', { name: new RegExp(`Run #${interrupted}\\b`) });
    await expect(option).toContainText('interrupted');
    await option.click();

    await page.waitForURL(new RegExp(`[?&]baseline=${interrupted}\\b`));
    await expect(page.getByText('The run you picked.')).toBeVisible({ timeout: 15000 });
  });

  test('a later run is compared with the last failed run, and the note says so', async ({ page }) => {
    await page.goto(`/test-runs/${latest}?tab=changes`);
    await waitForHydration(page);

    await expect(page.getByRole('link', { name: `Run #${firstFailed}` })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('No earlier full run passed; the last failed run on')).toBeVisible();
    await expect(page.getByText('Passed in the baseline, failing here')).toBeVisible();
    await expect(page.getByText('cart total')).toBeVisible();
    await expect(page.getByText('Failed in the baseline, passing here')).toBeVisible();
    await expect(page.getByText('coupon applies')).toBeVisible();
  });
});
