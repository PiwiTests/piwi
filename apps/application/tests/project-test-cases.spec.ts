/**
 * UI tests for the project test catalog, folded into the project's Tests tab:
 * the server-driven search and its qualifiers, status filtering, file order and
 * the File and File + Describe groupings. The `/projects/:id/test-cases` route
 * redirects into the tab.
 */
import { test, expect, type APIRequestContext } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

async function seed(request: APIRequestContext) {
  const res = await retryPost(request, '/api/test-runs/submit', {
    data: {
      projectName: PROJECT.TEST_CASES_CATALOG,
      status: 'failed',
      startTime: new Date().toISOString(),
      duration: 5000,
      totalTests: 4,
      passedTests: 3,
      failedTests: 1,
      skippedTests: 0,
      testCases: [
        {
          title: 'checkout tax',
          status: 'passed',
          duration: 640,
          location: 'tests/shop/checkout.spec.ts:30:1',
          suitePath: ['Checkout'],
        },
        {
          title: 'login works',
          status: 'passed',
          duration: 500,
          location: 'tests/auth/login.spec.ts:1:1',
          suitePath: ['Login'],
          tags: ['smoke'],
        },
        {
          title: 'checkout works',
          status: 'failed',
          duration: 1200,
          location: 'tests/shop/checkout.spec.ts:1:1',
          suitePath: ['Checkout'],
          error: 'Error: expected total to update\n    at tests/shop/checkout.spec.ts:5:3',
          testAnnotations: [{ type: 'piwi:owner', description: '@shop-team' }],
        },
        {
          title: 'login validation',
          status: 'passed',
          retries: 2,
          duration: 800,
          location: 'tests/auth/login.spec.ts:20:1',
          suitePath: ['Login'],
        },
      ],
    },
    timeout: 20000,
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { projectId: number };
}

test.describe.serial('Project test-cases catalog', () => {
  let projectId = 0;

  const catalog = (page: import('@playwright/test').Page) => page.locator('[data-shot="test-cases-catalog"]');
  const titles = (page: import('@playwright/test').Page) => catalog(page).locator('a[href^="/test-cases/"]:visible');
  const searchBox = (page: import('@playwright/test').Page) => page.getByRole('combobox', { name: 'Search tests' });

  test('seeds a project with four test cases', async ({ request }) => {
    const { projectId: id } = await seed(request);
    projectId = id;
    expect(projectId).toBeGreaterThan(0);
  });

  test('lists cases with title and file path', async ({ page }) => {
    await page.goto(`/projects/${projectId}/test-cases`);
    await waitForHydration(page);

    await expect(page.getByText('4 tests')).toBeVisible();
    await expect(page.getByRole('link', { name: 'login works' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'checkout works' })).toBeVisible();
    await expect(page.getByText('tests/auth/login.spec.ts').first()).toBeVisible();
  });

  test('search narrows the list to matching cases', async ({ page }) => {
    await page.goto(`/projects/${projectId}/test-cases`);
    await waitForHydration(page);

    await searchBox(page).fill('checkout');
    // The query is debounced and refetched server-side; web-first assertions retry.
    await expect(page.getByRole('link', { name: 'checkout works' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'login works' })).toHaveCount(0);
    await expect(page.getByText('2 tests')).toBeVisible();
  });

  test('the Failed status pill filters to failing cases', async ({ page }) => {
    await page.goto(`/projects/${projectId}/test-cases`);
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Failed', exact: true }).click();
    await expect(page.getByRole('link', { name: 'checkout works' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'login works' })).toHaveCount(0);
    await expect(page.getByText('1 test', { exact: true })).toBeVisible();
  });

  test('the catalog opens in file order, each title after its describe block', async ({ page }) => {
    await page.goto(`/projects/${projectId}/test-cases`);
    await waitForHydration(page);

    await expect(page.getByRole('combobox', { name: 'Sort by' })).toContainText('File order');
    await expect(titles(page)).toHaveText(['login works', 'login validation', 'checkout works', 'checkout tax']);
    await expect(
      catalog(page)
        .getByText(/Checkout ›/)
        .filter({ visible: true }),
    ).toHaveCount(2);
  });

  test('group by file puts each spec file under its own header', async ({ page }) => {
    await page.goto(`/projects/${projectId}/test-cases`);
    await waitForHydration(page);

    await page.getByRole('combobox', { name: 'Group tests by' }).click();
    await page.getByRole('option', { name: 'File', exact: true }).click();
    // Each spec file appears as a group header with its test count.
    await expect(page.getByText('tests/auth/login.spec.ts', { exact: true })).toBeVisible();
    await expect(page.getByText('tests/shop/checkout.spec.ts', { exact: true })).toBeVisible();
    await expect(page.getByText('2 tests').first()).toBeVisible();
  });

  test('group by file and describe nests the describe blocks in their files', async ({ page }) => {
    await page.goto(`/projects/${projectId}/test-cases`);
    await waitForHydration(page);

    await page.getByRole('combobox', { name: 'Group tests by' }).click();
    await page.getByRole('option', { name: 'File + Describe' }).click();
    await expect(catalog(page).getByText('Login', { exact: true })).toBeVisible();
    await expect(catalog(page).getByText('Checkout', { exact: true })).toBeVisible();
    await expect(titles(page)).toHaveText(['login works', 'login validation', 'checkout works', 'checkout tax']);
    // The headers name the blocks, so the rows do not repeat them.
    await expect(
      catalog(page)
        .getByText(/Checkout ›/)
        .filter({ visible: true }),
    ).toHaveCount(0);
  });

  test('a qualifier filters on the server, completed from the whole catalog', async ({ page }) => {
    await page.goto(`/projects/${projectId}/test-cases`);
    await waitForHydration(page);

    await searchBox(page).click();
    await searchBox(page).pressSequentially('file:check');
    await expect(page.getByRole('option')).toHaveCount(1);
    await expect(page.getByRole('option').first()).toContainText('tests/shop/checkout.spec.ts');
    await page.keyboard.press('Enter');
    await expect(searchBox(page)).toHaveValue('file:tests/shop/checkout.spec.ts ');
    await expect(titles(page)).toHaveText(['checkout works', 'checkout tax']);
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('file:tests/shop/checkout.spec.ts');
    await expect(titles(page).first().locator('mark')).toHaveCount(0);
    await expect(catalog(page).locator('mark').first()).toHaveText('tests/shop/checkout.spec.ts');

    await searchBox(page).fill('-describe:login tag:smoke');
    await expect(catalog(page).getByText('No test cases match your filters.')).toBeVisible();
  });

  test('values that arrive after the typing still complete on Enter', async ({ page }) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname.endsWith('/test-cases/facets'),
      async (route) => {
        await held;
        await route.continue();
      },
    );
    await page.goto(`/projects/${projectId}/test-cases`);
    await waitForHydration(page);

    await searchBox(page).click();
    await searchBox(page).pressSequentially('file:login');
    await expect(page.getByRole('option')).toHaveCount(0);
    release();
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(searchBox(page)).toHaveValue('file:tests/auth/login.spec.ts ');
  });

  test('coming back to the project brings the search back, in the URL too', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=tests`);
    await waitForHydration(page);
    await searchBox(page).fill('checkout');
    await searchBox(page).press('Escape');
    await expect(titles(page)).toHaveText(['checkout works', 'checkout tax']);

    await titles(page).first().click();
    await expect(page).toHaveURL(/\/test-cases\/\d+/);
    // The breadcrumb opens the project on its Runs tab, with no search in the URL.
    await page.getByRole('navigation', { name: 'breadcrumb' }).locator(`a[href="/projects/${projectId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}(\\?tab=runs)?$`));
    await page
      .getByRole('button', { name: /^Tests/ })
      .first()
      .click();

    await expect(searchBox(page)).toHaveValue('checkout');
    await expect(titles(page)).toHaveText(['checkout works', 'checkout tax']);
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('checkout');
    expect(new URL(page.url()).searchParams.get('tab')).toBe('tests');
  });

  test('links filtering by tag or owner open with the matching search', async ({ page }) => {
    await page.goto(`/projects/${projectId}/test-cases?tags=smoke`);
    await waitForHydration(page);
    await expect(searchBox(page)).toHaveValue('tag:smoke');
    await expect(titles(page)).toHaveText(['login works']);
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('tag:smoke');
    expect(new URL(page.url()).searchParams.has('tags')).toBe(false);

    await page.goto(`/projects/${projectId}?tab=tests&owner=${encodeURIComponent('@shop-team')}`);
    await waitForHydration(page);
    await expect(searchBox(page)).toHaveValue('owner:@shop-team');
    await expect(titles(page)).toHaveText(['checkout works']);
  });
});
