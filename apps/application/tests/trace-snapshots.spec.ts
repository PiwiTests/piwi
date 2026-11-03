import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * The trace aria/screen snapshots a Playwright 1.63 run records
 * (`trace: { snapshots: { dom, aria, screen } }`): the Screen tab's "Before the
 * failing action" screenshots and in-execution page diff, and the Timeline tab's
 * filmstrip. Driven by a real 1.63 trace fixture uploaded for a failing case.
 */
const TRACE = readFileSync(fileURLToPath(new URL('./fixtures/trace-aria-screen-1.63.zip', import.meta.url)));
const TRACE_HASH = createHash('sha256').update(TRACE).digest('hex');

const CASE = {
  title: 'checkout — cancel is gone after paying',
  location: 'tests/checkout.spec.ts:12:3',
  retries: 0,
};

test.describe('Trace aria/screen snapshots', () => {
  test.describe.configure({ mode: 'serial' });

  let runId: number;
  let streamToken: string;
  let executionId: number;

  test.beforeAll(async ({ request }) => {
    const start = await retryPost(request, '/api/test-runs/start', {
      data: { projectName: PROJECT.TRACE_SNAPSHOTS, startTime: new Date().toISOString() },
    });
    ({ runId, streamToken } = await start.json());

    await retryPost(request, `/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: [
          {
            type: 'complete',
            ...CASE,
            status: 'failed',
            duration: 2000,
            error:
              "TimeoutError: locator.click: Timeout 1500ms exceeded.\n  - waiting for getByRole('button', { name: 'Cancel' })",
            steps: [
              { title: 'Navigate to "data:text/html"', category: 'navigation', duration: 40, startTime: 0 },
              { title: 'Fill "a@b.test"', category: 'input', duration: 20, startTime: 50 },
              { title: 'Click "Pay now"', category: 'click', duration: 30, startTime: 80 },
              { title: 'Click "Cancel"', category: 'click', duration: 1500, startTime: 120, failed: true },
            ],
          },
        ],
      },
    });

    const form = new FormData();
    form.set('streamToken', streamToken);
    form.set('testCase', JSON.stringify(CASE));
    form.set('trace_hash', TRACE_HASH);
    form.append('trace', new Blob([TRACE], { type: 'application/zip' }), 'trace.zip');
    const upload = await request.post(`/api/test-runs/${runId}/case-files`, { multipart: form });
    expect(upload.ok()).toBeTruthy();
    executionId = (await upload.json()).executionId;
  });

  test('the trace-snapshots endpoint lists steps, marks the failure and diffs before→failure', async ({ request }) => {
    const res = await request.get(`/api/test-run-cases/${executionId}/trace-snapshots`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();

    expect(data.status).toBe('ok');
    expect(data.hasAria).toBe(true);
    expect(data.hasScreen).toBe(true);
    expect(data.steps.length).toBeGreaterThanOrEqual(3);
    expect(data.steps.some((s: { failed: boolean }) => s.failed)).toBe(true);

    const s = data.pageDiff.summary;
    expect(s.added + s.removed + s.changed + s.renamed + s.moved).toBeGreaterThan(0);

    // The single-resource endpoint serves a step's before screenshot as a PNG.
    const withScreen = data.steps.find((step: { screen: { before: boolean } }) => step.screen.before);
    const png = await request.get(
      `/api/test-run-cases/${executionId}/trace-snapshot?callId=${encodeURIComponent(withScreen.callId)}&kind=screen&phase=before`,
    );
    expect(png.ok()).toBeTruthy();
    expect(png.headers()['content-type']).toContain('image/png');
  });

  test('the Screen tab shows the before-action pair and toggles to the in-execution page diff', async ({ page }) => {
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);

    await page
      .getByRole('tablist', { name: 'Evidence sections' })
      .getByRole('tab', { name: 'Screen', exact: true })
      .click();

    await expect(page.getByText('Before the failing action').first()).toBeVisible();

    const toggle = page.getByRole('tablist', { name: 'Screen view' }).getByRole('tab', { name: 'Page diff' });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByText('before the failing action → at the failure')).toBeVisible();
  });

  test('an enlarged screenshot names the test, the failing step and the error raised on the page', async ({ page }) => {
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);

    await page
      .getByRole('tablist', { name: 'Evidence sections' })
      .getByRole('tab', { name: 'Screen', exact: true })
      .click();
    await page.getByRole('button', { name: 'Enlarge At the failure' }).click();

    const viewer = page.getByRole('dialog', { name: 'At the failure' });
    const details = viewer.getByRole('complementary', { name: 'Screenshot details' });
    await expect(details).toContainText(CASE.title);
    await expect(details.getByText('Step', { exact: true })).toBeVisible();
    await expect(details).toContainText('locator.click: Timeout 1500ms exceeded.');

    // The page before the action raised no error yet: its details name the step only.
    await page.keyboard.press('ArrowLeft');
    const before = page.getByRole('dialog', { name: 'Before the failing action' });
    await expect(before.getByRole('complementary', { name: 'Screenshot details' })).not.toContainText('Timeout 1500ms');

    await before.getByRole('button', { name: 'Hide details' }).click();
    await expect(before.getByRole('complementary', { name: 'Screenshot details' })).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(before).toBeHidden();
  });

  test('the Timeline tab shows a filmstrip of the page before each step', async ({ page }) => {
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);

    await page
      .getByRole('tablist', { name: 'Evidence sections' })
      .getByRole('tab', { name: 'Timeline', exact: true })
      .click();

    const filmstrip = page.getByRole('region', { name: 'Filmstrip of the page before each step' });
    await expect(filmstrip).toBeVisible();
    await expect(filmstrip.locator('[aria-label="failed"]')).toHaveCount(1);
  });

  test("the Timeline tab shows the failing step's page as views and picks from the DOM of that moment", async ({
    page,
  }) => {
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);

    await page
      .getByRole('tablist', { name: 'Evidence sections' })
      .getByRole('tab', { name: 'Timeline', exact: true })
      .click();

    // The page captured at the failing step sits inline on that step, one view
    // at a time. The table is the desktop layout; the phone card copy carries
    // the same views (role queries resolve the visible desktop copy).
    const block = page.locator('table');
    await expect(block.getByText('Page at the failing step')).toBeVisible();
    const views = block.getByRole('tablist', { name: 'Page at the failing step' });
    await expect(views.getByRole('tab', { name: 'Screenshot', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(block.getByText('Before the failing action')).toBeVisible();

    await views.getByRole('tab', { name: 'Accessibility tree', exact: true }).click();
    await expect(block.getByText('dialog "Confirm payment"')).toBeVisible();

    await views.getByRole('tab', { name: 'DOM', exact: true }).click();
    await expect(block.locator('iframe[title="DOM at the failure"]')).toBeVisible();

    // The picker opens on the DOM the view renders: the failing action's
    // after-phase snapshot, named by its call id.
    const snapshotRequest = page.waitForRequest(
      (req) =>
        req.url().includes('/dom-snapshot?') && req.url().includes('callId=') && req.url().includes('phase=after'),
    );
    await block.getByRole('button', { name: 'Open in picker' }).click();
    await snapshotRequest;
    await expect(page.getByRole('dialog').locator('iframe[title="DOM snapshot"]')).toBeVisible();
  });
});

test.describe('Trace screen snapshots of a passing test', () => {
  test.describe.configure({ mode: 'serial' });

  const PASSING = { title: 'checkout — pay and confirm', location: 'tests/checkout.spec.ts:30:3', retries: 0 };
  let executionId: number;

  test.beforeAll(async ({ request }) => {
    const start = await retryPost(request, '/api/test-runs/start', {
      data: { projectName: PROJECT.TRACE_SNAPSHOTS, startTime: new Date().toISOString() },
    });
    const { runId, streamToken } = await start.json();

    await retryPost(request, `/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: [
          {
            type: 'complete',
            ...PASSING,
            status: 'passed',
            duration: 2000,
            // The Timeline tab lists a passing execution's steps, and shows its filmstrip with them.
            steps: [
              { title: 'Navigate to "data:text/html"', category: 'navigation', duration: 40, startTime: 0 },
              { title: 'Fill "a@b.test"', category: 'input', duration: 20, startTime: 50 },
              { title: 'Click "Pay now"', category: 'click', duration: 30, startTime: 80 },
            ],
          },
        ],
      },
    });

    const form = new FormData();
    form.set('streamToken', streamToken);
    form.set('testCase', JSON.stringify(PASSING));
    form.set('trace_hash', TRACE_HASH);
    form.append('trace', new Blob([TRACE], { type: 'application/zip' }), 'trace.zip');
    const upload = await request.post(`/api/test-runs/${runId}/case-files`, { multipart: form });
    expect(upload.ok()).toBeTruthy();
    executionId = (await upload.json()).executionId;
  });

  test('the Screen tab shows no page at the failure, failing-action pair or failing-action diff', async ({ page }) => {
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);

    await page
      .getByRole('tablist', { name: 'Evidence sections' })
      .getByRole('tab', { name: 'Screen', exact: true })
      .click();

    // The DOM view renders once the trace's snapshots have loaded, so the checks below see the loaded page.
    const views = page.getByRole('tablist', { name: 'Screen view' });
    await views.getByRole('tab', { name: 'DOM', exact: true }).click();
    await expect(page.locator('iframe[title="DOM at the end of the test"]')).toBeVisible();

    await views.getByRole('tab', { name: 'Screenshot', exact: true }).click();
    await expect(page.getByText('No screenshot for this execution.')).toBeVisible();
    await expect(page.getByText('Before the failing action')).toHaveCount(0);
    await expect(page.getByText('At the failure', { exact: true })).toHaveCount(0);
    await expect(views.getByRole('tab', { name: 'Page diff' })).toHaveCount(0);
  });

  test("the Timeline tab's filmstrip marks no step as failed", async ({ page }) => {
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);

    await page
      .getByRole('tablist', { name: 'Evidence sections' })
      .getByRole('tab', { name: 'Timeline', exact: true })
      .click();

    const filmstrip = page.getByRole('region', { name: 'Filmstrip of the page before each step' });
    await expect(filmstrip).toBeVisible();
    await expect(filmstrip.getByRole('listitem').first()).toBeVisible();
    await expect(filmstrip.locator('[aria-label="failed"]')).toHaveCount(0);
  });
});
