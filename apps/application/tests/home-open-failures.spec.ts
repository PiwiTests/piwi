import { test, expect, type APIRequestContext } from './fixtures';
import { pressChord, waitForHydration } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * The Home failure inbox: open clusters across the visible projects, deep-linkable
 * queues, the row opens the cluster, keyboard and per-row triage (resolve with an
 * Undo), snooze that hides the row, a bulk selection bar, and — on the cluster
 * page — the snooze badge with its Unsnooze action.
 */
test.describe.serial('Home — failure inbox', () => {
  test.setTimeout(90000);

  // A distinctive selector so this project's cluster is identifiable among the
  // other clusters the card lists across projects.
  const SELECTOR = "getByTestId('home-open-failures-btn')";
  const failure = (ms: number) =>
    `TimeoutError: locator.click: Timeout ${ms}ms exceeded.\nCall log:\n  - waiting for ${SELECTOR}`;

  let clusterId: number | null = null;

  async function submitFailingRun(request: APIRequestContext): Promise<{ runId: number }> {
    const response = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.HOME_OPEN_FAILURES,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 60000,
        totalTests: 2,
        passedTests: 1,
        failedTests: 1,
        skippedTests: 0,
        testCases: [
          {
            title: 'opens the account menu',
            status: 'failed',
            duration: 31000,
            location: 'tests/account.spec.ts:12:5',
            error: failure(30000),
          },
          { title: 'homepage loads', status: 'passed', duration: 900, location: 'tests/home.spec.ts:5:5' },
        ],
      },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()) as { runId: number };
  }

  const CARD = '[data-shot="open-failures"]';

  // Ensure this project's cluster is open (a previous test may have snoozed or
  // resolved it) and visible in the card, then return its row locator.
  async function revealRow(page: import('@playwright/test').Page) {
    const card = page.locator(CARD);
    await expect(card.getByRole('heading', { name: 'Failure inbox' })).toBeVisible();
    const showAll = card.getByRole('button', { name: /Show all/ });
    if (await showAll.count()) await showAll.first().click();
    return card.locator(`[data-cluster-row="${clusterId}"]`);
  }

  test.beforeAll(async ({ request }) => {
    const { runId } = await submitFailingRun(request);
    const run = await (await request.get(`/api/test-runs/${runId}`)).json();
    const failed = run.testCases.find((tc: { title: string }) => tc.title === 'opens the account menu');
    clusterId = failed.failureClusterId as number;
    expect(clusterId).toEqual(expect.any(Number));
  });

  test('row opens the failure cluster', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    const row = await revealRow(page);
    await expect(row).toBeVisible();
    await row.getByRole('link', { name: new RegExp('home-open-failures-btn') }).click();
    await page.waitForURL(`/failure-clusters/${clusterId}`);
  });

  test('queues are deep-linkable via ?queue=', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    const card = page.locator(CARD);
    await card.getByRole('tab', { name: /Mine/ }).click();
    await expect(page).toHaveURL(/\?queue=mine/);
    await expect(card.getByRole('tab', { name: /Mine/ })).toHaveAttribute('aria-selected', 'true');
    // Back to All open clears the query.
    await card.getByRole('tab', { name: /All open/ }).click();
    await expect(page).not.toHaveURL(/queue=/);
  });

  test('keyboard: j selects a row and o opens it', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    const card = page.locator(CARD);
    await expect(card.getByRole('heading', { name: 'Failure inbox' })).toBeVisible();
    await page.keyboard.press('j');
    await expect(card.locator('[aria-current="true"]')).toBeVisible();
    await page.keyboard.press('o');
    await page.waitForURL(/\/failure-clusters\/\d+/);
  });

  test('keyboard: the go-to chords g a and g s leave the row alone', async ({ page }) => {
    await page.clock.install();
    // `/settings` opens its first page at once.
    for (const [key, url] of [
      ['a', /\/analytics$/],
      ['s', /\/settings(\/|$)/],
    ] as const) {
      await page.goto('/');
      await waitForHydration(page);
      const row = await revealRow(page);
      await row.hover();
      await expect(row).toHaveAttribute('aria-current', 'true');
      // Records any of the row's menus (Assign, Snooze) opening before the page changes.
      await row.evaluate((el) => {
        const opened: string[] = [];
        Object.assign(window, { __inboxOpened: opened });
        new MutationObserver(() => {
          for (const trigger of el.querySelectorAll('[aria-expanded="true"]')) {
            opened.push(trigger.getAttribute('title') ?? '');
          }
        }).observe(el, { attributes: true, subtree: true, attributeFilter: ['aria-expanded'] });
      });

      await pressChord(page, 'g', key);
      await page.waitForURL(url);
      expect(await page.evaluate(() => (window as unknown as { __inboxOpened: string[] }).__inboxOpened)).toEqual([]);
    }
  });

  test('selecting a row shows the bulk bar', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    const row = await revealRow(page);
    await row.getByRole('checkbox').check();
    await expect(page.locator(CARD).getByText(/\d+ selected/)).toBeVisible();
  });

  test('resolve removes the row and Undo restores it', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    const row = await revealRow(page);
    await row.hover();
    await row.getByRole('button', { name: 'Resolve (r)' }).click();
    // The row drops out at once.
    await expect(page.locator(CARD).locator(`[data-cluster-row="${clusterId}"]`)).toHaveCount(0);
    // The toast offers an Undo that brings it back.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator(CARD).locator(`[data-cluster-row="${clusterId}"]`)).toBeVisible();
  });

  test('snooze hides the row and Undo restores it', async ({ page, request }) => {
    await page.goto('/');
    await waitForHydration(page);
    const row = await revealRow(page);
    await row.hover();
    await row.getByRole('button', { name: 'Snooze (s)' }).click();
    await page.getByRole('menuitem', { name: '1 day' }).click();
    // Snoozed → gone from the queue.
    await expect(page.locator(CARD).locator(`[data-cluster-row="${clusterId}"]`)).toHaveCount(0);
    // And really snoozed server-side.
    const afterSnooze = await (await request.get(`/api/failure-clusters/${clusterId}`)).json();
    expect(afterSnooze.snoozedUntil).not.toBeNull();
    // Undo unsnoozes.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator(CARD).locator(`[data-cluster-row="${clusterId}"]`)).toBeVisible();
    const afterUndo = await (await request.get(`/api/failure-clusters/${clusterId}`)).json();
    expect(afterUndo.snoozedUntil).toBeNull();
  });

  test('cluster page shows the snooze state with an Unsnooze action', async ({ page, request }) => {
    // Snooze via the API, then confirm the cluster page surfaces it and lifts it.
    const res = await request.patch(`/api/failure-clusters/${clusterId}/snooze`, { data: { snooze: '1-week' } });
    expect(res.ok()).toBeTruthy();

    await page.goto(`/failure-clusters/${clusterId}`);
    await waitForHydration(page);
    await expect(page.getByText(/Snoozed until/)).toBeVisible();
    await page.getByRole('button', { name: 'Unsnooze' }).click();
    await expect(page.getByText(/Snoozed until/)).toHaveCount(0);
    const after = await (await request.get(`/api/failure-clusters/${clusterId}`)).json();
    expect(after.snoozedUntil).toBeNull();
  });
});
