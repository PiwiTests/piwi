import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * The trace aria/screen snapshots and the screencast a Playwright 1.63 run
 * records (`trace: { snapshots: { dom, aria, screen } }`): the Screen tab's
 * "Before the failing action" screenshots and in-execution page diff, the
 * Timeline tab's Screen lane and page panel, and a passing test's filmstrip.
 * Driven by a real 1.63 trace fixture uploaded for a failing case.
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
              { title: 'Click "Cancel"', category: 'click', duration: 1500, startTime: 300, failed: true },
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

  test('the trace-frames endpoint lists the screencast on the wall clock and serves a pooled frame', async ({
    request,
  }) => {
    const res = await request.get(`/api/test-run-cases/${executionId}/trace-frames`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();

    expect(data).toMatchObject({ status: 'ok', total: 15, capped: false });
    const frames: Array<{ epochMs: number; name: string; width: number }> = data.pages.flatMap(
      (p: { frames: unknown[] }) => p.frames,
    );
    expect(frames).toHaveLength(15);
    for (const frame of frames) {
      // Playwright names a frame by the wall clock it was painted at; the list places it on the same clock.
      const named = Number(/-(\d+)\.jpeg$/.exec(frame.name)![1]);
      expect(Math.abs(frame.epochMs - named)).toBeLessThan(25);
      expect(frame.width).toBe(1280);
    }

    const jpeg = await request.get(
      `/api/test-run-cases/${executionId}/trace-frame?name=${encodeURIComponent(frames[0]!.name)}`,
    );
    expect(jpeg.ok()).toBeTruthy();
    expect(jpeg.headers()['content-type']).toBe('image/jpeg');

    // Only a frame the trace lists is served, never another entry of the archive.
    const other = await request.get(
      `/api/test-run-cases/${executionId}/trace-frame?name=${encodeURIComponent('aria/x.json')}`,
    );
    expect(other.status()).toBe(404);
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
    // A trace frame was not attached under a name: no Screenshot line.
    await expect(details.getByText('Screenshot', { exact: true })).toHaveCount(0);

    // The page before the action raised no error yet: its details name the step only.
    await page.keyboard.press('ArrowLeft');
    const before = page.getByRole('dialog', { name: 'Before the failing action' });
    await expect(before.getByRole('complementary', { name: 'Screenshot details' })).not.toContainText('Timeout 1500ms');

    await before.getByRole('button', { name: 'Hide details' }).click();
    await expect(before.getByRole('complementary', { name: 'Screenshot details' })).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(before).toBeHidden();
  });

  test("the Timeline tab's Screen lane shows the page through the test, in place of the filmstrip", async ({
    page,
  }) => {
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);

    await page
      .getByRole('tablist', { name: 'Evidence sections' })
      .getByRole('tab', { name: 'Timeline', exact: true })
      .click();

    const lane = page.getByRole('button', { name: 'Screen: open the page as the trace recorded it, at the failure' });
    await expect(lane).toBeVisible();
    await expect(page.locator('[data-timeline-screen] image').first()).toBeAttached();
    // The lane shows what the filmstrip would: the filmstrip is gone.
    await expect(page.getByRole('region', { name: 'Filmstrip of the page before each step' })).toHaveCount(0);

    // Hovering the lane shows the page at that moment.
    await lane.scrollIntoViewIfNeeded();
    const box = (await lane.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.95, box.y + box.height / 2);
    await expect(page.getByTestId('timeline-screen-preview')).toContainText('Recorded at');
    await page.mouse.move(0, 0);

    // From the keyboard, the lane opens its frames on the page at the failure, with the error raised on it.
    await lane.focus();
    await page.keyboard.press('Enter');
    const viewer = page.getByRole('dialog', { name: /^Page at / });
    await expect(viewer.getByRole('complementary', { name: 'Screenshot details' })).toContainText(
      'locator.click: Timeout 1500ms exceeded.',
    );
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();

    // A drag across the axis zooms it and the steps under it; Reset zoom gives the window back.
    const axis = page.locator('svg:has([data-timeline-screen])');
    const plot = (await axis.boundingBox())!;
    const y = plot.y + plot.height - 30;
    await page.mouse.move(plot.x + plot.width * 0.3, y);
    await page.mouse.down();
    await page.mouse.move(plot.x + plot.width * 0.7, y, { steps: 6 });
    await page.mouse.up();
    const reset = page.getByTestId('timeline-zoom-reset');
    await expect(reset).toBeVisible();
    await expect(
      page.getByRole('group', { name: 'Timeline window' }).getByRole('button', { pressed: true }),
    ).toHaveCount(0);
    await reset.click();
    await expect(reset).toBeHidden();

    // The lane can be turned off, and the page beside the steps goes with it.
    await page.getByTestId('timeline-screen-toggle').click();
    await expect(lane).toBeHidden();
    await expect(page.getByTestId('timeline-page-panel')).toHaveCount(0);
  });

  test('beside the steps, a panel shows the page before or after a step, under the tapped row when narrower', async ({
    page,
  }) => {
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);
    await page
      .getByRole('tablist', { name: 'Evidence sections' })
      .getByRole('tab', { name: 'Timeline', exact: true })
      .click();

    // It opens on the failing step, before it ran, and shows it at the failure on request.
    const panel = page.getByTestId('timeline-page-panel');
    await expect(panel).toHaveAttribute('aria-label', /^Before the step, t-/);
    await panel.getByRole('button', { name: 'At the failure', exact: true }).click();
    await expect(panel).toHaveAttribute('aria-label', /^At the failure, t/);

    // Hovering another step shows the page after it; leaving the table goes back to the picked one.
    await page.locator('table tbody tr', { hasText: 'Fill' }).first().hover();
    await expect(panel).toHaveAttribute('aria-label', /^After the step, t-/);
    await expect(panel).toContainText('Fill');
    await page.mouse.move(0, 0);
    await expect(panel).toHaveAttribute('aria-label', /^At the failure, t/);

    // Reached from a row, the panel keeps that row, and its controls act on it: the failing step's arrows move to
    // another frame, another step's Before shows that step.
    const enterPanelFrom = async (text: string) => {
      const row = (await page.locator('table tbody tr', { hasText: text }).first().boundingBox())!;
      await page.mouse.move(row.x + 120, row.y + 12);
      const box = (await panel.boundingBox())!;
      await page.mouse.move(box.x + 24, Math.min(Math.max(row.y + 12, box.y + 24), box.y + box.height - 24));
    };
    await enterPanelFrom('Cancel');
    await expect(panel).toHaveAttribute('aria-label', /^At the failure, t/);
    await panel.getByRole('button', { name: 'The page at its previous frame' }).click();
    await expect(panel).toHaveAttribute('aria-label', /^The page then, t/);
    await enterPanelFrom('Fill');
    await expect(panel).toHaveAttribute('aria-label', /^After the step, t-/);
    await panel.getByRole('button', { name: 'Before', exact: true }).click();
    await expect(panel).toHaveAttribute('aria-label', /^Before the step, t-/);
    await expect(panel).toContainText('Fill');
    await page.mouse.move(0, 0);
    await page
      .getByRole('button', { name: /^Show the page at / })
      .last()
      .click();
    await panel.getByRole('button', { name: 'At the failure', exact: true }).click();

    // Its frame opens full screen.
    await panel.getByRole('button', { name: /^Open the page full screen/ }).click();
    await expect(page.getByRole('dialog', { name: /^Page at / })).toBeVisible();
    await page.keyboard.press('Escape');

    // Narrower, a row's time opens the page under that row instead.
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect(panel).toHaveCount(0);
    await page
      .getByRole('button', { name: /^Show the page at / })
      .first()
      .click();
    await expect(page.getByTestId('timeline-page-panel')).toHaveCount(1);
  });

  test('the page switch shows the page in a hover card or as thumbnails, and keeps the choice', async ({ page }) => {
    const openTimeline = async () => {
      await page.goto(`/test-run-cases/${executionId}`);
      await waitForHydration(page);
      await page
        .getByRole('tablist', { name: 'Evidence sections' })
        .getByRole('tab', { name: 'Timeline', exact: true })
        .click();
    };
    await openTimeline();
    const views = page.getByRole('group', { name: 'How the list shows the page' });

    // A hover card: the page before and after the row under the pointer, and no side panel.
    await views.getByRole('button', { name: 'Hover card' }).click();
    await expect(page.getByTestId('timeline-page-panel')).toHaveCount(0);
    const failingRow = page.locator('table tbody tr', { hasText: 'Cancel' }).first();
    await failingRow.hover({ position: { x: 240, y: 12 } });
    await expect(page.getByTestId('timeline-page-hover-card')).toContainText('At the failure');
    // Over the failing step's own views, the card makes way.
    await failingRow.getByRole('tablist', { name: 'Page at the failing step' }).hover();
    await expect(page.getByTestId('timeline-page-hover-card')).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(page.getByTestId('timeline-page-hover-card')).toHaveCount(0);

    // Thumbnails: a column of the page after each row, each opening the frames full screen.
    await views.getByRole('button', { name: 'Thumbnails' }).click();
    await expect(page.getByRole('columnheader', { name: 'Page' })).toBeVisible();
    await page.getByTestId('timeline-row-thumbnail').last().click();
    await expect(page.getByRole('dialog', { name: /^Page at / })).toBeVisible();
    await page.keyboard.press('Escape');

    // The choice is kept for the next page.
    await openTimeline();
    await expect(views.getByRole('button', { name: 'Thumbnails' })).toHaveAttribute('aria-pressed', 'true');
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
