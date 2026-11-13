import { test, expect, type Page, type APIRequestContext } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * Mobile responsiveness regression suite.
 *
 * Guards the fixes made across the audit: no page should ever scroll
 * horizontally, wide tables must scroll in place instead of stretching the
 * page, the detail-page tab strip must offer a mobile select below `sm`, and
 * the breadcrumb must collapse into a dropdown below `sm`.
 *
 * Runs the same navigation pass at two viewports: a phone (375x812) and a
 * small tablet (768x1024) to catch both the `max-sm` and `sm`-and-up
 * behaviors.
 */

const VIEWPORTS = {
  phone: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
} as const;

let projectId = 0;
let runId = 0;
let clusterId = 0;
let testCaseId = 0;
let testRunCaseId = 0;

const sharedError = (frame: string) =>
  `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Place order' })\n    at ${frame}`;

async function seedData(request: APIRequestContext) {
  await retryPost(request, '/api/test-runs/submit', {
    data: {
      projectName: PROJECT.MOBILE_RESPONSIVENESS,
      status: 'failed',
      startTime: new Date().toISOString(),
      duration: 60000,
      totalTests: 4,
      passedTests: 2,
      failedTests: 2,
      skippedTests: 0,
      isFullRun: true,
      environment: 'staging',
      metadata: {
        ci: { provider: 'github', buildUrl: 'https://example.com/build/1' },
        scm: { branch: 'main', commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
      },
      testCases: [
        {
          title: 'checkout completes payment',
          status: 'failed',
          duration: 1200,
          location: 'tests/checkout.spec.ts:9:1',
          error: sharedError('tests/checkout.spec.ts:9:1'),
          workerIndex: 0,
          startedAt: Date.now(),
        },
        {
          title: 'cart persists across navigation',
          status: 'failed',
          duration: 1500,
          location: 'tests/cart.spec.ts:14:3',
          error: sharedError('tests/cart.spec.ts:14:3'),
          workerIndex: 1,
          startedAt: Date.now(),
        },
        {
          title: 'login form validates email',
          status: 'passed',
          duration: 800,
          location: 'tests/auth.spec.ts:5:3',
          workerIndex: 0,
          startedAt: Date.now(),
        },
        {
          title: 'search returns matching products',
          status: 'passed',
          duration: 600,
          location: 'tests/search.spec.ts:3:1',
          workerIndex: 1,
          startedAt: Date.now(),
        },
      ],
    },
    timeout: 20000,
  });

  const { items: projects } = await (await request.get('/api/projects')).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT.MOBILE_RESPONSIVENESS);
  expect(project).toBeTruthy();
  projectId = project.id;

  const detail = await (await request.get(`/api/projects/${projectId}`)).json();
  runId = detail.testRuns[0].id;

  const run = await (await request.get(`/api/test-runs/${runId}`)).json();
  const cases = run.testCases as Array<{ executionId: number; status: string; failureClusterId?: number }>;
  const failed = cases.find((c) => c.status === 'failed' && c.failureClusterId);
  expect(failed?.failureClusterId).toBeTruthy();
  clusterId = failed!.failureClusterId!;
  testRunCaseId = failed!.executionId;

  const execDetails = await (await request.get(`/api/test-run-cases/${testRunCaseId}`)).json();
  testCaseId = execDetails.testCaseId;
}

/** No page should ever be wider than its own viewport (horizontal page scroll). */
async function expectNoHorizontalOverflow(page: Page, label: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    scrollWidth,
    `${label}: page scrolls horizontally (scrollWidth ${scrollWidth} > clientWidth ${clientWidth})`,
  ).toBeLessThanOrEqual(
    clientWidth + 1, // 1px tolerance for subpixel rounding
  );
}

test.describe('Mobile responsiveness', () => {
  // fullyParallel can schedule these tests across multiple workers; beforeAll
  // is scoped per-worker, so without serial mode two workers could each submit
  // the seed run, doubling the shared data these tests assert against.
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  test.beforeAll(async ({ request }) => {
    await seedData(request);
  });

  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    test.describe(`at ${name} (${viewport.width}x${viewport.height})`, () => {
      test.use({ viewport });

      test('core pages have no horizontal overflow', async ({ page }) => {
        const pages: [string, string][] = [
          ['home', '/'],
          ['projects list', '/projects'],
          ['project detail', `/projects/${projectId}`],
          ['run detail', `/test-runs/${runId}`],
          ['test-case detail', `/test-cases/${testCaseId}`],
          ['test-run-case detail', `/test-run-cases/${testRunCaseId}`],
          ['failure cluster detail', `/failure-clusters/${clusterId}`],
          ['settings', '/settings'],
          ['settings users', '/settings/users'],
          ['settings tags', '/settings/tags'],
          ['settings notifications', '/settings/notifications'],
        ];

        for (const [label, path] of pages) {
          await page.goto(path);
          await waitForHydration(page);
          await expectNoHorizontalOverflow(page, label);
        }
      });

      test('run detail: every tab has no horizontal overflow', async ({ page }) => {
        await page.goto(`/test-runs/${runId}`);
        await waitForHydration(page);

        const tabLabels = [/Tests/, /Changes/, /Timeline/];

        for (const label of tabLabels) {
          if (viewport.width < 640) {
            // Below `sm` the tab strip is replaced by a full-width select.
            await page.getByRole('combobox').first().click();
            await page.getByRole('option', { name: label }).click();
          } else {
            await page.getByRole('button', { name: label }).first().click();
          }
          await expectNoHorizontalOverflow(page, `run detail tab ${label}`);
        }
      });

      test('run detail: summary is reachable and collapsible', async ({ page }) => {
        await page.goto(`/test-runs/${runId}`);
        await waitForHydration(page);

        // The summary + everything below it must be visible without any content
        // being clipped by a fixed-height, overflow-hidden ancestor. Scoped to the
        // run header heading (not `getByText`, which also matches the breadcrumb's
        // same-text label rendered — CSS-hidden but still in the DOM — for the
        // desktop breadcrumb variant).
        await expect(page.locator('h1').filter({ hasText: /Run #/ })).toBeVisible();

        if (viewport.width < 1024) {
          // Below `lg` the mobile "Hide summary" toggle folds the summary away.
          const hideButton = page.getByRole('button', { name: 'Hide summary' });
          await expect(hideButton).toBeVisible();
          await hideButton.click();
          await expect(page.getByRole('button', { name: 'Show summary' })).toBeVisible();
          await expectNoHorizontalOverflow(page, 'run detail with summary collapsed');
        }
      });

      test('wide tables scroll horizontally in place, not the page', async ({ page }) => {
        await page.goto(`/projects/${projectId}?tab=performance`);
        await waitForHydration(page);

        // The slowest-tests table is wider than the viewport and scrolls inside
        // its own container.
        const table = page.locator('table').first();
        await expect(table).toBeVisible();
        await expectNoHorizontalOverflow(page, 'project detail performance tab');

        // The table itself may be wider than the viewport — that's fine as
        // long as it scrolls inside its own container.
        const tableWidth = await table.evaluate((el) => el.getBoundingClientRect().width);
        expect(tableWidth).toBeGreaterThan(0);
      });

      test('breadcrumb collapses into a dropdown below sm', async ({ page }) => {
        await page.goto(`/test-runs/${runId}`);
        await waitForHydration(page);

        if (viewport.width < 640) {
          // Ancestor levels collapse behind a dropdown trigger; only the
          // current page label is shown inline.
          await expect(page.getByRole('button', { name: 'Show navigation path' })).toBeVisible();
          await page.getByRole('button', { name: 'Show navigation path' }).click();
          await expect(page.getByRole('menuitem', { name: 'Projects' })).toBeVisible();
        } else {
          await expect(page.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
        }
        await expectNoHorizontalOverflow(page, 'run detail breadcrumb');
      });

      // Non-baseline screenshot (attached to the report) for a quick visual
      // sanity check of the highest-traffic and the two reworked failure pages
      // at this viewport.
      test('screenshot: home and run detail', async ({ page }, testInfo) => {
        await page.goto('/');
        await waitForHydration(page);
        await testInfo.attach(`home-${name}`, { body: await page.screenshot(), contentType: 'image/png' });

        await page.goto(`/test-runs/${runId}`);
        await waitForHydration(page);
        await testInfo.attach(`run-detail-${name}`, { body: await page.screenshot(), contentType: 'image/png' });
      });

      test('screenshot: the failure pages', async ({ page }, testInfo) => {
        await page.goto(`/test-run-cases/${testRunCaseId}`);
        await waitForHydration(page);
        await expectNoHorizontalOverflow(page, 'execution detail (situation block)');
        await testInfo.attach(`execution-detail-${name}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });

        await page.goto(`/failure-clusters/${clusterId}`);
        await waitForHydration(page);
        await expectNoHorizontalOverflow(page, 'failure cluster detail (situation block)');
        await testInfo.attach(`failure-cluster-detail-${name}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });
      });
    });
  }
});
