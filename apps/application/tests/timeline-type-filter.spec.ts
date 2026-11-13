import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * The failure timeline's type filter: one chip per item type in the current
 * window (Steps, Network, Console, Backend here; the Dialogs chip joins on the
 * whole test), each hiding or showing that type on both the axis and the steps
 * table. The failing step always stays, the last shown type stays, a line says
 * what is hidden and names the failed request among it, *Only ▾* and Alt-click
 * show just one type, *Show all* brings the rest back, and the choice persists
 * per browser — rendered by the server, so a reload arrives already filtered.
 */
test.describe('Timeline type filter', () => {
  test.describe.configure({ mode: 'serial' });

  let failedCaseId: number;
  let stepsOnlyCaseId: number;
  let passedCaseId: number;

  const STORAGE_KEY = 'piwi-timeline-hidden-types';
  const QUOTE_REQUEST = 'GET http://localhost:3000/api/quote';
  const FAILING_STEP = "getByRole('button', { name: 'Pay' }).click()";

  test.beforeAll(async ({ request }) => {
    const startTime = Date.now();
    const res = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.TIMELINE_TYPE_FILTER,
        status: 'failed',
        startTime: new Date(startTime).toISOString(),
        duration: 12000,
        totalTests: 3,
        passedTests: 1,
        failedTests: 2,
        skippedTests: 0,
        testCases: [
          {
            title: 'checkout shows the quote',
            status: 'failed',
            duration: 6500,
            location: 'tests/checkout.spec.ts:12:3',
            error:
              "TimeoutError: locator.click: Timeout 5000ms exceeded.\n  - waiting for getByRole('button', { name: 'Pay' })",
            retries: 0,
            workerIndex: 0,
            startedAt: startTime,
            steps: [
              { title: "page.goto('/checkout')", duration: 800, category: 'navigation', startTime },
              {
                title: 'Fill "ada@example.com"',
                duration: 400,
                category: 'input',
                startTime: startTime + 900,
              },
              {
                title: FAILING_STEP,
                duration: 5000,
                category: 'action',
                failed: true,
                startTime: startTime + 1400,
              },
            ],
            networkRequests: [
              {
                method: 'GET',
                url: 'http://localhost:3000/checkout',
                status: 200,
                duration: 180,
                startTime: startTime + 100,
                resourceType: 'document',
              },
              {
                method: 'GET',
                url: 'http://localhost:3000/api/quote',
                status: 504,
                duration: 900,
                startTime: startTime + 1500,
                resourceType: 'fetch',
                serverLogs: [{ timestamp: startTime + 2300, level: 'error', message: 'quote upstream timed out' }],
              },
            ],
            consoleLogs: [{ type: 'error', text: 'quote request failed', timestamp: startTime + 2500 }],
            // Closed after the window around the failure (which ends 2 s after
            // the failing step), so only the whole test shows it.
            dialogs: [{ type: 'alert', message: 'Session expired', closedAt: startTime + 9500 }],
          },
          {
            title: 'profile saves',
            status: 'failed',
            duration: 3000,
            location: 'tests/profile.spec.ts:5:3',
            error: 'Error: expect(received).toBe(expected)',
            retries: 0,
            workerIndex: 0,
            startedAt: startTime,
            steps: [
              { title: "page.goto('/profile')", duration: 600, category: 'navigation', startTime },
              { title: 'Fill "Ada"', duration: 300, category: 'input', startTime: startTime + 700 },
              {
                title: 'Expect "toBe"',
                duration: 200,
                category: 'assertion',
                failed: true,
                startTime: startTime + 1100,
              },
            ],
          },
          {
            title: 'homepage loads',
            status: 'passed',
            duration: 1500,
            location: 'tests/home.spec.ts:3:1',
            retries: 0,
            workerIndex: 0,
            startedAt: startTime,
            steps: [{ title: "page.goto('/')", duration: 700, category: 'navigation' }],
          },
        ],
      },
    });

    const data = await res.json();
    const proj = await (await request.get(`/api/projects/${data.projectId}`)).json();
    const run = await (await request.get(`/api/test-runs/${proj.testRuns[0].id}`)).json();
    const byTitle = (title: string) =>
      run.testCases.find((c: { title: string }) => c.title === title).executionId as number;
    failedCaseId = byTitle('checkout shows the quote');
    stepsOnlyCaseId = byTitle('profile saves');
    passedCaseId = byTitle('homepage loads');
  });

  async function openTimeline(page: Page, id: number) {
    await page.goto(`/test-run-cases/${id}`);
    await waitForHydration(page);
    await page
      .getByRole('tablist', { name: 'Evidence sections' })
      .getByRole('tab', { name: 'Timeline', exact: true })
      .click();
  }

  /** Store a hidden-types value in localStorage before the page loads. */
  async function storeHidden(page: Page, value: string) {
    await page.addInitScript(([key, raw]) => localStorage.setItem(key!, raw!), [STORAGE_KEY, value]);
  }

  const evidenceCard = (page: Page) => page.locator('[data-shot="evidence-card"]');
  const chipGroup = (page: Page) => page.getByRole('group', { name: 'Show on the timeline' });
  const chips = (page: Page) => chipGroup(page).locator('button[aria-pressed]');
  const chip = (page: Page, label: string) => chipGroup(page).getByRole('button', { name: new RegExp(`^${label}`) });
  const axisLane = (page: Page, label: string) =>
    page.locator('[data-shot="evidence-card"] svg').getByText(label, { exact: true });
  const summary = (page: Page) => page.getByTestId('timeline-hidden-summary');

  test('one chip per type with its count; hiding a type drops its rows and its axis lane', async ({ page }) => {
    await openTimeline(page, failedCaseId);

    // Every type in the window, in lane order, all shown to begin with.
    await expect(chips(page)).toHaveText([/Steps\s*3/, /Network\s*2/, /Console\s*1/, /Backend\s*1/]);
    for (const label of ['Steps', 'Network', 'Console', 'Backend']) {
      await expect(chip(page, label)).toHaveAttribute('aria-pressed', 'true');
    }
    const table = page.getByRole('table');
    await expect(table.getByText(QUOTE_REQUEST)).toBeVisible();
    await expect(axisLane(page, 'Network')).toHaveCount(1);
    await expect(summary(page)).toHaveCount(0);
    // The chips key the lanes; the marks they do not explain keep a key of their own.
    await expect(evidenceCard(page).getByText('Failed or error', { exact: true })).toBeVisible();

    await chip(page, 'Network').click();

    await expect(chip(page, 'Network')).toHaveAttribute('aria-pressed', 'false');
    await expect(table.getByText(QUOTE_REQUEST)).toHaveCount(0);
    await expect(axisLane(page, 'Network')).toHaveCount(0);
    // The line names what the filter leaves out — the failed request among it.
    await expect(summary(page)).toHaveText('Hidden: 2 requests (1 failed) · Show all');

    await chip(page, 'Network').click();
    await expect(table.getByText(QUOTE_REQUEST)).toBeVisible();
    await expect(summary(page)).toHaveCount(0);
  });

  test('the chips follow the window: a type outside it has no chip and no lane', async ({ page }) => {
    await openTimeline(page, failedCaseId);
    await expect(chips(page)).toHaveCount(4);
    await expect(chip(page, 'Dialogs')).toHaveCount(0);
    await expect(axisLane(page, 'Dialogs')).toHaveCount(0);

    await page.getByRole('button', { name: 'Whole test' }).click();
    await expect(chips(page)).toHaveText([/Steps\s*3/, /Network\s*2/, /Console\s*1/, /Dialogs\s*1/, /Backend\s*1/]);
    await expect(axisLane(page, 'Dialogs')).toHaveCount(1);
    await expect(page.getByRole('table').getByText('alert: Session expired')).toBeVisible();

    await page.getByRole('button', { name: 'Around the failure' }).click();
    await expect(chip(page, 'Dialogs')).toHaveCount(0);
  });

  test('hiding steps keeps the failing step, the moment the timeline reads against', async ({ page }) => {
    await openTimeline(page, failedCaseId);
    const table = page.getByRole('table');

    await chip(page, 'Steps').click();

    await expect(table.getByText(FAILING_STEP)).toBeVisible();
    await expect(table.getByText("page.goto('/checkout')")).toHaveCount(0);
    await expect(summary(page)).toHaveText('Hidden: 2 steps · Show all');
  });

  test('Only and Alt-click show just one type; Show all brings every type back', async ({ page }) => {
    await openTimeline(page, failedCaseId);
    const table = page.getByRole('table');

    await page.getByRole('button', { name: 'Show only one type' }).click();
    await page.getByRole('menuitem', { name: 'Only console entries' }).click();
    for (const [label, pressed] of [
      ['Steps', 'false'],
      ['Network', 'false'],
      ['Console', 'true'],
      ['Backend', 'false'],
    ] as const) {
      await expect(chip(page, label)).toHaveAttribute('aria-pressed', pressed);
    }
    await expect(table.getByText('quote request failed')).toBeVisible();
    await expect(table.getByText(FAILING_STEP)).toBeVisible();
    await expect(summary(page)).toHaveText(
      'Hidden: 2 steps, 2 requests (1 failed), 1 backend log (1 error) · Show all',
    );

    // Console is the one type shown, so it cannot be hidden.
    await expect(chip(page, 'Console')).toHaveAttribute('aria-disabled', 'true');

    await chip(page, 'Network').click({ modifiers: ['Alt'] });
    await expect(chip(page, 'Network')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip(page, 'Console')).toHaveAttribute('aria-pressed', 'false');
    await expect(chip(page, 'Steps')).toHaveAttribute('aria-pressed', 'false');

    await page.getByRole('button', { name: 'Show all' }).click();
    for (const label of ['Steps', 'Network', 'Console', 'Backend']) {
      await expect(chip(page, label)).toHaveAttribute('aria-pressed', 'true');
    }
    // The line that held Show all is gone; focus moves to the first chip.
    await expect(chip(page, 'Steps')).toBeFocused();
  });

  test('the last shown type stays shown', async ({ page }) => {
    await openTimeline(page, failedCaseId);
    await chip(page, 'Steps').click();
    await chip(page, 'Network').click();
    await chip(page, 'Console').click();

    const last = chip(page, 'Backend');
    await expect(last).toHaveAttribute('aria-disabled', 'true');
    await last.click({ force: true });
    await expect(last).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('table').getByText('quote upstream timed out')).toBeVisible();
  });

  test('a stored choice that would hide every type here hides nothing, and clicks act on what shows', async ({
    page,
  }) => {
    // What Only dialogs stores; the window around the failure has no dialog.
    await storeHidden(page, JSON.stringify(['steps', 'network', 'console', 'backend']));
    await openTimeline(page, failedCaseId);
    for (const label of ['Steps', 'Network', 'Console', 'Backend']) {
      await expect(chip(page, label)).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(page.getByRole('table').getByText(QUOTE_REQUEST)).toBeVisible();

    await chip(page, 'Console').click();
    await expect(chip(page, 'Console')).toHaveAttribute('aria-pressed', 'false');
    await expect(chip(page, 'Steps')).toHaveAttribute('aria-pressed', 'true');
    await expect(summary(page)).toHaveText('Hidden: 1 console entry (1 error) · Show all');
  });

  test('a window with one type shows no chips and ignores the stored choice', async ({ page }) => {
    await storeHidden(page, JSON.stringify(['steps']));
    await openTimeline(page, stepsOnlyCaseId);
    await expect(chipGroup(page)).toHaveCount(0);
    await expect(evidenceCard(page).getByText('Failed step', { exact: true })).toBeVisible();
    await expect(page.getByRole('table').getByText("page.goto('/profile')")).toBeVisible();
  });

  test('a malformed stored value reads as nothing hidden', async ({ page, baseURL }) => {
    await page.context().addCookies([{ name: STORAGE_KEY, value: 'not-json', url: baseURL! }]);
    await storeHidden(page, '{not json');
    await openTimeline(page, failedCaseId);
    for (const label of ['Steps', 'Network', 'Console', 'Backend']) {
      await expect(chip(page, label)).toHaveAttribute('aria-pressed', 'true');
    }
  });

  test('the choice persists per browser and the server renders it, with no hydration mismatch', async ({
    page,
    browser,
  }) => {
    const hydrationErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('Hydration completed but contains mismatches')) hydrationErrors.push(msg.text());
    });

    await openTimeline(page, failedCaseId);
    // Nothing hidden, nothing stored: no cookie rides the requests.
    expect((await page.context().cookies()).some((c) => c.name === STORAGE_KEY)).toBe(false);

    await chip(page, 'Network').click();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe('["network"]');
    const cookie = (await page.context().cookies()).find((c) => c.name === STORAGE_KEY);
    expect(decodeURIComponent(cookie?.value ?? '')).toBe('["network"]');

    // The server reads the cookie: without any JavaScript the page is already filtered.
    const origin = new URL(page.url()).origin;
    const noJs = await browser.newContext({ javaScriptEnabled: false });
    await noJs.addCookies([{ name: STORAGE_KEY, value: cookie!.value, url: origin }]);
    const ssr = await noJs.newPage();
    await ssr.goto(`${origin}/test-run-cases/${failedCaseId}`);
    const card = ssr.locator('[data-shot="evidence-card"]');
    await expect(card.getByRole('button', { name: /^Network/ })).toHaveAttribute('aria-pressed', 'false');
    await expect(card.getByText(QUOTE_REQUEST)).toHaveCount(0);
    await expect(card.getByTestId('timeline-hidden-summary')).toHaveText('Hidden: 2 requests (1 failed) · Show all');
    await noJs.close();

    await page.reload();
    await waitForHydration(page);
    await page
      .getByRole('tablist', { name: 'Evidence sections' })
      .getByRole('tab', { name: 'Timeline', exact: true })
      .click();
    await expect(chip(page, 'Network')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('table').getByText(QUOTE_REQUEST)).toHaveCount(0);
    expect(hydrationErrors).toEqual([]);

    // Show all removes the cookie again.
    await page.getByRole('button', { name: 'Show all' }).click();
    await expect.poll(async () => (await page.context().cookies()).some((c) => c.name === STORAGE_KEY)).toBe(false);
  });

  test('a passing execution has nothing to filter and shows no chips', async ({ page }) => {
    await openTimeline(page, passedCaseId);
    await expect(page.getByRole('table')).toBeVisible();
    await expect(chipGroup(page)).toHaveCount(0);
  });

  test('at phone width the chips wrap and filter the step cards', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await openTimeline(page, failedCaseId);
    const quoteCard = evidenceCard(page).getByText(QUOTE_REQUEST).filter({ visible: true });
    await expect(quoteCard.first()).toBeVisible();

    await chip(page, 'Network').click();
    await expect(summary(page)).toBeVisible();
    await expect(quoteCard).toHaveCount(0);
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
