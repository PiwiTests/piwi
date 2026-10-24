import { test, expect, type APIRequestContext } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

test.describe.serial('Run page Tests tab', () => {
  const loginTimeout = (ms: number) =>
    `TimeoutError: locator.click: Timeout ${ms}ms exceeded.\nCall log:\n  - waiting for getByTestId('login-button')`;
  const cartAssertion = `Error: expect(locator).toHaveText(expected)\n\nLocator: getByTestId('cart-total')\nExpected string: "3 items"\nReceived string: "0 items"`;

  let runId = 0;
  let loginClusterId = 0;

  // The test-row title links — the visible copy at the test viewport.
  const visibleTitles = (page: import('@playwright/test').Page) => page.locator('a[href^="/test-run-cases/"]:visible');
  const groupBy = (page: import('@playwright/test').Page) => page.getByRole('combobox', { name: 'Group tests by' });

  async function selectGroup(page: import('@playwright/test').Page, label: string) {
    await groupBy(page).click();
    await page.getByRole('option', { name: label }).click();
  }

  async function selectSort(page: import('@playwright/test').Page, label: string) {
    await page.getByRole('combobox', { name: 'Sort tests by' }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
  }

  const searchBox = (page: import('@playwright/test').Page) => page.getByRole('combobox', { name: 'Search tests' });

  async function submitRun(request: APIRequestContext) {
    // The tests started in the reverse of their file order, so run order and file order differ.
    const startedAt = Date.now() - 60_000;
    const response = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.RUN_PAGE_FILTERS,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 60000,
        totalTests: 4,
        passedTests: 1,
        failedTests: 3,
        skippedTests: 0,
        testCases: [
          {
            title: 'login via header',
            status: 'failed',
            duration: 31000,
            location: 'tests/auth.spec.ts:10:5',
            suitePath: ['Authentication'],
            error: loginTimeout(30000),
            startedAt: startedAt + 3000,
          },
          {
            title: 'login via modal',
            status: 'failed',
            duration: 16000,
            location: 'tests/auth.spec.ts:30:5',
            suitePath: ['Authentication'],
            error: loginTimeout(15000),
            startedAt: startedAt + 2000,
          },
          {
            title: 'cart shows items',
            status: 'failed',
            duration: 2000,
            location: 'tests/cart.spec.ts:12:5',
            error: cartAssertion,
            startedAt: startedAt + 1000,
          },
          {
            title: 'homepage loads',
            status: 'passed',
            duration: 900,
            location: 'tests/home.spec.ts:5:5',
            startedAt,
          },
        ],
      },
      timeout: 20000,
    });
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as { runId: number; projectId: number };
    runId = body.runId;
  }

  test('seeds a failed run with two failure clusters', async ({ request }) => {
    await submitRun(request);

    const run = await (await request.get(`/api/test-runs/${runId}`)).json();
    const loginHeader = run.testCases.find((tc: { title: string }) => tc.title === 'login via header');
    const cart = run.testCases.find((tc: { title: string }) => tc.title === 'cart shows items');
    expect(loginHeader.failureClusterId).toEqual(expect.any(Number));
    expect(cart.failureClusterId).toEqual(expect.any(Number));
    expect(cart.failureClusterId).not.toBe(loginHeader.failureClusterId);
    loginClusterId = loginHeader.failureClusterId;
  });

  test('the None grouping lists the tests in run order, with their error text and a cluster chip', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await selectGroup(page, 'None');

    // Run order: when each test started.
    await expect(visibleTitles(page)).toHaveText([
      'homepage loads',
      'cart shows items',
      'login via modal',
      'login via header',
    ]);
    // Outside the File + Describe grouping, the describe block is named before the title.
    await expect(page.getByText(/Authentication ›/).filter({ visible: true })).toHaveCount(2);

    // The one-line headline under each failed title, with the raw error as its tooltip.
    const loginHeadline = page
      .getByText("getByTestId('login-button') was not found on the page — click timed out after 30 s")
      .filter({ visible: true });
    await expect(loginHeadline).toBeVisible();
    await expect(loginHeadline).toHaveAttribute('title', /TimeoutError: locator\.click: Timeout 30000ms exceeded\./);
    await expect(
      page
        .getByText('Expected text "3 items", got "0 items" — getByTestId(\'cart-total\') toHaveText')
        .filter({ visible: true }),
    ).toBeVisible();

    // A cluster chip on every failing row links to the cluster page.
    const clusterLinks = page.locator('a[href^="/failure-clusters/"]:visible');
    await expect(clusterLinks).toHaveCount(3, { timeout: 15000 });
    await expect(page.locator(`a[href="/failure-clusters/${loginClusterId}"]:visible`)).toHaveCount(2);
  });

  test('the sort puts the tests in file order, or the failures first', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await selectGroup(page, 'None');

    await selectSort(page, 'File order');
    await expect(visibleTitles(page)).toHaveText([
      'login via header',
      'login via modal',
      'cart shows items',
      'homepage loads',
    ]);

    // The failing tests first, each part in run order.
    await selectSort(page, 'Failures first');
    await expect(visibleTitles(page)).toHaveText([
      'cart shows items',
      'login via modal',
      'login via header',
      'homepage loads',
    ]);
  });

  test('the cluster grouping is the default on a red run and hides passing tests under a group', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    // Two clusters, each with an "Open cluster" link in its group header.
    await expect(page.getByRole('link', { name: /Open cluster/ })).toHaveCount(2, { timeout: 15000 });

    // The passing row lives in a collapsed Passed group, so only the failures show.
    await expect(visibleTitles(page)).toHaveCount(3);
    await expect(page.getByText('homepage loads')).toHaveCount(0);

    // Switching to None reveals every row.
    await selectGroup(page, 'None');
    await expect(visibleTitles(page)).toHaveCount(4);
  });

  test('the File + Describe grouping nests tests under their describe block', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await selectGroup(page, 'File + Describe');

    // The two auth tests share a describe block, so a nested "Authentication"
    // group header appears (under its file) with both tests beneath it, in the
    // order they are declared; the rows do not repeat the block's name.
    await expect(page.getByText('Authentication', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(visibleTitles(page)).toHaveText([
      'login via header',
      'login via modal',
      'cart shows items',
      'homepage loads',
    ]);
    await expect(page.getByText(/Authentication ›/).filter({ visible: true })).toHaveCount(0);
  });

  test('the count bar filters the list and switches to the Tests tab from another tab', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    // Move to another tab first, then click a count-bar segment.
    await page
      .getByRole('button', { name: /^Timeline/ })
      .first()
      .click();
    await expect(page).toHaveURL(/tab=workers/);

    await page.getByRole('button', { name: '3 failed' }).first().click();

    // It lands back on the Tests tab with only the failing rows.
    await expect(page).toHaveURL(/tab=test-cases/);
    await expect(groupBy(page)).toBeVisible();
    await expect(visibleTitles(page)).toHaveCount(3);
    await expect(page.getByText('homepage loads')).toHaveCount(0);
  });

  test('search matches the error text, not only the title', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    // "0 items" only appears in the cart assertion's error, never in a title.
    await searchBox(page).fill('"0 items"');
    await expect(visibleTitles(page)).toHaveCount(1);
    await expect(visibleTitles(page).first()).toHaveText('cart shows items');
  });

  test('a qualifier searches one field, completed from the run’s own values', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    // An empty box lists the qualifiers.
    await searchBox(page).click();
    await expect(page.getByRole('option', { name: /^describe:/ })).toBeVisible();

    // A qualifier lists the values it can take; Enter takes the highlighted one.
    await searchBox(page).pressSequentially('file:ca');
    await expect(page.getByRole('option')).toHaveCount(1);
    await expect(page.getByRole('option').first()).toContainText('tests/cart.spec.ts');
    await page.keyboard.press('Enter');
    await expect(searchBox(page)).toHaveValue('file:tests/cart.spec.ts ');
    await expect(visibleTitles(page)).toHaveText(['cart shows items']);

    // A title-only search skips the word in the file path.
    await searchBox(page).fill('title:auth');
    await expect(visibleTitles(page)).toHaveCount(0);
    await searchBox(page).fill('describe:authentication');
    await expect(visibleTitles(page)).toHaveCount(2);
  });

  test('a minus excludes, and the matches are marked in the rows', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await selectGroup(page, 'None');

    await searchBox(page).fill('login -modal');
    await expect(visibleTitles(page)).toHaveText(['login via header']);
    await expect(visibleTitles(page).first().locator('mark')).toHaveText('login');

    await searchBox(page).fill('-describe:authentication');
    await expect(visibleTitles(page)).toHaveText(['homepage loads', 'cart shows items']);
  });

  test('Ctrl+F focuses the search, and a second press is left to the browser', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.evaluate(() => {
      const presses: boolean[] = [];
      (window as unknown as { findPresses: boolean[] }).findPresses = presses;
      window.addEventListener(
        'keydown',
        (event) => {
          if (event.key === 'f' && event.ctrlKey) setTimeout(() => presses.push(event.defaultPrevented));
        },
        true,
      );
    });

    await page.keyboard.press('Control+f');
    await expect(searchBox(page)).toBeFocused();
    await page.keyboard.press('Control+f');
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { findPresses: boolean[] }).findPresses))
      .toEqual([true, false]);
  });

  test('Back from an execution shows the list with its sort and open groups', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    // Open the collapsed Passed group and sort by title.
    await page.locator('[data-index]').getByText('Passed', { exact: true }).click();
    await selectSort(page, 'Title');
    const titles = ['login via header', 'login via modal', 'cart shows items', 'homepage loads'];
    await expect(visibleTitles(page)).toHaveText(titles);

    await visibleTitles(page).first().click();
    await expect(page).toHaveURL(/\/test-run-cases\/\d+/);
    await page.goBack();

    await expect(page.getByRole('combobox', { name: 'Sort tests by' })).toContainText('Title');
    await expect(visibleTitles(page)).toHaveText(titles);
  });

  test('the breadcrumb back to the run shows the list with its search and status filter', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: '3 failed' }).first().click();
    await searchBox(page).fill('cart');
    await searchBox(page).press('Escape');
    await expect(visibleTitles(page)).toHaveText(['cart shows items']);

    await visibleTitles(page).first().click();
    await expect(page).toHaveURL(/\/test-run-cases\/\d+/);
    await page
      .getByRole('navigation', { name: 'breadcrumb' })
      .getByRole('link', { name: `Run #${runId}` })
      .click();

    await expect(page).toHaveURL(new RegExp(`/test-runs/${runId}`));
    await expect(searchBox(page)).toHaveValue('cart');
    await expect(page.getByRole('button', { name: '3 failed' }).first()).toHaveAttribute('aria-pressed', 'true');
    await expect(visibleTitles(page)).toHaveText(['cart shows items']);
  });

  test('?tab=failure-groups redirects to the Tests tab with the cluster grouping', async ({ page }) => {
    await page.goto(`/test-runs/${runId}?tab=failure-groups`);
    await waitForHydration(page);

    await expect(page).toHaveURL(/tab=test-cases/);
    await expect(page.getByRole('link', { name: /Open cluster/ })).toHaveCount(2, { timeout: 15000 });
  });
});

test.describe.serial('Run page status segments and tag filter', () => {
  let runId = 0;

  const visibleTitles = (page: import('@playwright/test').Page) => page.locator('a[href^="/test-run-cases/"]:visible');

  test('seeds a run with a pass on retry, plain skips, fixme skips and tagged tests', async ({ request }) => {
    const response = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.RUN_SKIP_KINDS,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 30000,
        totalTests: 5,
        passedTests: 2,
        failedTests: 0,
        skippedTests: 3,
        testCases: [
          { title: 'home loads', status: 'passed', duration: 800, location: 'tests/home.spec.ts:3:5', tags: ['smoke'] },
          {
            title: 'orders list',
            status: 'passed',
            retries: 1,
            duration: 900,
            location: 'tests/orders.spec.ts:3:5',
            tags: ['api'],
          },
          {
            title: 'webkit only flow',
            status: 'skipped',
            duration: 0,
            location: 'tests/home.spec.ts:9:5',
            tags: ['smoke'],
            testAnnotations: [{ type: 'skip', description: 'WebKit only' }],
          },
          {
            title: 'refund flow',
            status: 'skipped',
            duration: 0,
            location: 'tests/orders.spec.ts:9:5',
            tags: ['api'],
            testAnnotations: [{ type: 'fixme' }],
          },
          {
            title: 'refund email',
            status: 'skipped',
            duration: 0,
            location: 'tests/orders.spec.ts:15:5',
            tags: ['smoke', 'api'],
            testAnnotations: [{ type: 'fixme', description: 'Mail stub is down' }],
          },
        ],
      },
      timeout: 20000,
    });
    expect(response.ok()).toBeTruthy();
    runId = ((await response.json()) as { runId: number }).runId;
  });

  test('the count bar splits skipped from fixme and each segment filters its own rows', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await expect(page.getByRole('button', { name: '1 skipped' }).first()).toBeVisible();
    await page.getByRole('button', { name: '2 fixme' }).first().click();
    await expect(visibleTitles(page)).toHaveCount(2);
    await expect(visibleTitles(page).filter({ hasText: 'refund flow' })).toHaveCount(1);
    await expect(visibleTitles(page).filter({ hasText: 'refund email' })).toHaveCount(1);

    // The skipped segment holds the plain skip only.
    await page.getByRole('button', { name: '2 fixme' }).first().click();
    await page.getByRole('button', { name: '1 skipped' }).first().click();
    await expect(visibleTitles(page)).toHaveCount(1);
    await expect(visibleTitles(page).first()).toHaveText('webkit only flow');
  });

  test('the passed segment excludes the pass on retry, which has its own segment', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: '1 passed', exact: true }).first().click();
    await expect(visibleTitles(page)).toHaveCount(1);
    await expect(visibleTitles(page).first()).toHaveText('home loads');

    await page.getByRole('button', { name: '1 passed', exact: true }).first().click();
    // A narrow segment shows a short label first in its name: "1 flaky, passed on retry".
    await page.getByRole('button', { name: /^1 (flaky, )?passed on retry$/ }).click();
    await expect(visibleTitles(page)).toHaveCount(1);
    await expect(visibleTitles(page).first()).toHaveText('orders list');
  });

  test('the tag: qualifier keeps the tests carrying every tag it names', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    const search = page.getByRole('combobox', { name: 'Search tests' });
    await search.fill('tag:smoke');
    await expect(visibleTitles(page)).toHaveCount(3);

    await search.fill('tag:smoke tag:@api');
    await expect(visibleTitles(page)).toHaveCount(1);
    await expect(visibleTitles(page).first()).toHaveText('refund email');
  });

  test('the project runs table draws the fixme share of the skipped tests', async ({ page, request }) => {
    const run = await (await request.get(`/api/test-runs/${runId}`)).json();
    const project = await (await request.get(`/api/projects/${run.projectId}`)).json();
    const listed = project.testRuns.find((r: { id: number }) => r.id === runId);
    expect(listed).toMatchObject({ skippedTests: 3, fixmeTests: 2 });

    await page.goto(`/projects/${run.projectId}`);
    await waitForHydration(page);
    await expect(
      page.getByRole('progressbar', { name: 'Test results: 1 passed, 1 flaky, 1 skipped, 2 fixme' }).first(),
    ).toBeVisible();
  });
});
