import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { waitForHydration } from './utils';

/**
 * A project's URL patterns: the endpoints the browser extension reads and
 * writes, and the editor in the project's Settings tab, which suggests one
 * pattern per origin the suite visited, with the environment of its runs.
 */
test.describe.serial('project URL patterns', () => {
  let projectId: number;

  test.beforeAll(async ({ request }) => {
    const submit = async (secondsAgo: number, environment: string, baseUrls: string[]) => {
      const res = await request.post('/api/test-runs/submit', {
        data: {
          projectName: PROJECT.URL_PATTERNS,
          status: 'passed',
          environment,
          startTime: new Date(Date.now() - secondsAgo * 1000).toISOString(),
          duration: 1000,
          totalTests: 1,
          passedTests: 1,
          failedTests: 0,
          skippedTests: 0,
          metadata: { htmlReport: { projects: baseUrls.map((baseURL) => ({ use: { baseURL } })) } },
          testCases: [{ title: 'opens the shop', status: 'passed', duration: 100, location: 'tests/shop.spec.ts:3:1' }],
        },
      });
      expect(res.ok()).toBeTruthy();
      return ((await res.json()) as { projectId: number }).projectId;
    };
    projectId = await submit(60, 'staging', ['https://staging.shop.example/app']);
    await submit(30, 'production', ['https://shop.example', 'https://admin.shop.example']);
    await request.put(`/api/projects/${projectId}/url-patterns`, { data: { items: [] } });
  });

  test('replace, add, refuse a duplicate and an address without a scheme', async ({ request }) => {
    const put = await request.put(`/api/projects/${projectId}/url-patterns`, {
      data: { items: [{ pattern: 'https://shop.example/**', environment: 'production' }] },
    });
    expect(put.ok()).toBeTruthy();

    const post = await request.post(`/api/projects/${projectId}/url-patterns`, {
      data: { pattern: 'https://qa.shop.example/**', branch: 'develop', pathPrefix: 'app/' },
    });
    expect(post.status()).toBe(201);
    const reverse = await request.post(`/api/projects/${projectId}/url-patterns`, {
      data: { pattern: 'http://localhost:4173/**', testPathPrefix: 'shop/' },
    });
    expect(reverse.status()).toBe(201);

    const list = (await (await request.get(`/api/projects/${projectId}/url-patterns`)).json()) as {
      items: Array<{
        pattern: string;
        environment: string | null;
        branch: string | null;
        pathPrefix: string | null;
        testPathPrefix: string | null;
      }>;
    };
    expect(list.items.map((i) => [i.pattern, i.environment, i.branch, i.pathPrefix, i.testPathPrefix])).toEqual([
      ['https://shop.example/**', 'production', null, null, null],
      ['https://qa.shop.example/**', null, 'develop', '/app', null],
      ['http://localhost:4173/**', null, null, null, '/shop'],
    ]);

    const badPrefix = await request.post(`/api/projects/${projectId}/url-patterns`, {
      data: { pattern: 'https://eu.shop.example/**', pathPrefix: '/app?lang=fr' },
    });
    expect(badPrefix.status()).toBe(400);
    const badTestsPrefix = await request.post(`/api/projects/${projectId}/url-patterns`, {
      data: { pattern: 'https://eu.shop.example/**', testPathPrefix: 'https://shop.example/app' },
    });
    expect(badTestsPrefix.status()).toBe(400);

    const duplicate = await request.post(`/api/projects/${projectId}/url-patterns`, {
      data: { pattern: 'https://shop.example/**' },
    });
    expect(duplicate.status()).toBe(409);
    const invalid = await request.post(`/api/projects/${projectId}/url-patterns`, {
      data: { pattern: 'shop.example/**' },
    });
    expect(invalid.status()).toBe(400);

    const visible = (await (await request.get('/api/extension/url-patterns')).json()) as {
      user: unknown;
      items: Array<{ projectId: number; pattern: string; pathPrefix: string | null; testPathPrefix: string | null }>;
      projects: Array<{ id: number; canEdit: boolean }>;
    };
    expect(visible.user).toBeNull(); // authentication is off on this server
    expect(
      visible.items.filter((i) => i.projectId === projectId).map((i) => [i.pattern, i.pathPrefix, i.testPathPrefix]),
    ).toEqual([
      ['https://shop.example/**', null, null],
      ['https://qa.shop.example/**', '/app', null],
      ['http://localhost:4173/**', null, '/shop'],
    ]);
    expect(visible.projects.find((p) => p.id === projectId)?.canEdit).toBe(true);
  });

  test('suggestions come from the base URL of the project’s runs, with their environment', async ({ request }) => {
    await request.put(`/api/projects/${projectId}/url-patterns`, { data: { items: [] } });
    const suggestions = (await (await request.get(`/api/projects/${projectId}/url-patterns/suggestions`)).json()) as {
      items: Array<{ pattern: string; environment: string | null; sources: string[] }>;
    };
    expect(suggestions.items.map((s) => [s.pattern, s.environment, s.sources])).toEqual(
      expect.arrayContaining([
        ['https://staging.shop.example/**', 'staging', ['base-url']],
        ['https://shop.example/**', 'production', ['base-url']],
        ['https://admin.shop.example/**', 'production', ['base-url']],
      ]),
    );
  });

  test('the Settings tab adds every suggestion of an environment with its environment', async ({ page, request }) => {
    await request.put(`/api/projects/${projectId}/url-patterns`, { data: { items: [] } });
    await page.goto(`/projects/${projectId}?tab=settings&section=browser-extension`);
    await waitForHydration(page);

    const card = page.locator('[data-shot="project-url-patterns"]');
    const production = card.getByTestId('url-pattern-suggestion-group').filter({ hasText: 'production' });
    await expect(production.getByText('https://admin.shop.example/**')).toBeVisible();
    // A single suggestion has its own Add button only.
    const staging = card.getByTestId('url-pattern-suggestion-group').filter({ hasText: 'staging' });
    await expect(staging.getByRole('button', { name: /^Add all/ })).toHaveCount(0);

    await production.getByRole('button', { name: 'Add all production suggestions' }).click();
    await expect(card.getByLabel('URL pattern', { exact: true })).toHaveCount(2);
    for (const [index, pattern] of ['https://admin.shop.example/**', 'https://shop.example/**'].entries()) {
      await expect(card.getByLabel('URL pattern', { exact: true }).nth(index)).toHaveValue(pattern);
      await expect(card.getByLabel('Environment').nth(index)).toHaveText('production');
    }
    await expect(production).toBeHidden();
    await expect(staging).toBeVisible();
  });

  test('the Settings tab adds a suggestion and saves the list', async ({ page, request }) => {
    await request.put(`/api/projects/${projectId}/url-patterns`, { data: { items: [] } });
    await page.goto(`/projects/${projectId}?tab=settings&section=browser-extension`);
    await waitForHydration(page);

    const card = page.locator('[data-shot="project-url-patterns"]');
    await expect(card.getByRole('heading', { name: 'URL patterns' })).toBeVisible();
    await expect(card.getByText('No pattern yet.')).toBeVisible();
    await card.getByRole('button', { name: 'Add https://staging.shop.example/**' }).click();
    await expect(card.getByLabel('Environment')).toHaveText('staging');
    await expect(card.getByTestId('url-pattern-prefix-hint')).toContainText(
      'your site serves the pages under this path, the tests did not, e.g. /app',
    );
    await expect(card.getByTestId('url-pattern-prefix-hint')).toContainText(
      'the tests ran the pages under this path, your site does not, e.g. /app',
    );
    await card.getByLabel('Path prefix', { exact: true }).fill('app/');
    await card.getByLabel('Tests’ path prefix').fill('/v2/');
    await card.getByRole('button', { name: 'Save patterns' }).click();
    await expect(page.getByText('URL patterns saved', { exact: true })).toBeVisible();

    const list = (await (await request.get(`/api/projects/${projectId}/url-patterns`)).json()) as {
      items: Array<{
        pattern: string;
        environment: string | null;
        pathPrefix: string | null;
        testPathPrefix: string | null;
      }>;
    };
    expect(list.items).toEqual([
      expect.objectContaining({
        pattern: 'https://staging.shop.example/**',
        environment: 'staging',
        pathPrefix: '/app',
        testPathPrefix: '/v2',
      }),
    ]);

    await page.reload();
    await waitForHydration(page);
    await expect(card.getByLabel('URL pattern', { exact: true })).toHaveValue('https://staging.shop.example/**');
    await expect(card.getByLabel('Path prefix', { exact: true })).toHaveValue('/app');
    await expect(card.getByLabel('Tests’ path prefix')).toHaveValue('/v2');
    // A pattern already in the list is no longer suggested.
    await expect(card.getByRole('button', { name: 'Add https://shop.example/**' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Add https://staging.shop.example/**' })).toBeHidden();
  });

  test('the editor flags a pattern without a scheme and does not save it', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=settings&section=browser-extension`);
    await waitForHydration(page);
    const card = page.locator('[data-shot="project-url-patterns"]');
    await card.getByRole('button', { name: 'Add a pattern' }).click();
    await card.getByLabel('URL pattern', { exact: true }).last().fill('shop.example/**');
    await expect(card.getByText('Start with http://, https:// or a wildcard')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Save patterns' })).toBeDisabled();
  });

  test('the editor flags a refused path prefix of either kind and does not save it', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=settings&section=browser-extension`);
    await waitForHydration(page);
    const card = page.locator('[data-shot="project-url-patterns"]');
    await card.getByLabel('Path prefix', { exact: true }).first().fill('/app?lang=fr');
    await expect(card.getByText('No query or hash')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Save patterns' })).toBeDisabled();
    await card.getByLabel('Path prefix', { exact: true }).first().fill('/app');
    await card.getByLabel('Tests’ path prefix').first().fill('/shop/*');
    await expect(card.getByText('A plain path, such as /app')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Save patterns' })).toBeDisabled();
  });
});

/**
 * A suite whose runs record no baseURL: the editor reads the full addresses its
 * tests opened with page.goto and the pages they loaded, and says why it has
 * nothing to suggest while there are none.
 */
test.describe.serial('project URL patterns without a baseURL', () => {
  let projectId: number;

  const submit = async (request: APIRequestContext, steps: unknown[], networkRequests?: unknown[]) => {
    const res = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.URL_PATTERNS_GOTO,
        status: 'passed',
        environment: 'qa',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'opens the cart',
            status: 'passed',
            duration: 100,
            location: 'tests/cart.spec.ts:3:1',
            steps,
            networkRequests,
          },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
    return ((await res.json()) as { projectId: number }).projectId;
  };

  test.beforeAll(async ({ request }) => {
    projectId = await submit(request, [{ title: 'Click', category: 'action', duration: 5 }]);
    await request.put(`/api/projects/${projectId}/url-patterns`, { data: { items: [] } });
  });

  test('the Settings tab says why it has nothing to suggest', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=settings&section=browser-extension`);
    await waitForHydration(page);
    const card = page.locator('[data-shot="project-url-patterns"]');
    await expect(card.getByText('No pattern yet. Add one.', { exact: true })).toBeVisible();
    await expect(card.getByTestId('url-pattern-no-suggestions')).toContainText(
      'no recent run recorded a Playwright baseURL, opened a full address with page.goto or kept the network requests of a page it loaded',
    );
    await expect(card.getByTestId('url-pattern-suggestions')).toBeHidden();
  });

  test('a page.goto to a full address is suggested with the run’s environment', async ({ page, request }) => {
    await submit(request, [
      { title: 'Navigate', category: 'navigation', duration: 5, params: { url: 'https://goto.shop.example/cart' } },
    ]);
    const suggestions = (await (await request.get(`/api/projects/${projectId}/url-patterns/suggestions`)).json()) as {
      items: Array<{ pattern: string; environment: string | null; sources: string[] }>;
      covered: number;
    };
    expect(suggestions.items.map((s) => [s.pattern, s.environment, s.sources])).toEqual([
      ['https://goto.shop.example/**', 'qa', ['navigation']],
    ]);

    await page.goto(`/projects/${projectId}?tab=settings&section=browser-extension`);
    await waitForHydration(page);
    const card = page.locator('[data-shot="project-url-patterns"]');
    await expect(card.getByText('From page.goto calls')).toBeVisible();
    await card.getByRole('button', { name: 'Add https://goto.shop.example/**' }).click();
    await expect(card.getByLabel('Environment')).toHaveText('qa');
    await card.getByRole('button', { name: 'Save patterns' }).click();
    await expect(page.getByText('URL patterns saved', { exact: true })).toBeVisible();

    await page.reload();
    await waitForHydration(page);
    await expect(card.getByTestId('url-pattern-no-suggestions')).toHaveText(
      'Every site the suite visited already has a pattern.',
    );
  });

  test('a page the tests loaded is suggested when they opened a path only', async ({ page, request }) => {
    // A run merged from blob reports: no baseURL, and `page.goto('/orders')` names no site.
    await submit(
      request,
      [{ title: 'Navigate', category: 'navigation', duration: 5, params: { url: '/orders' } }],
      [
        { method: 'GET', url: 'https://merged.shop.example/orders', status: 200, resourceType: 'document' },
        { method: 'GET', url: 'https://api.merged.shop.example/orders', status: 200, resourceType: 'fetch' },
      ],
    );
    const suggestions = (await (await request.get(`/api/projects/${projectId}/url-patterns/suggestions`)).json()) as {
      items: Array<{ pattern: string; environment: string | null; sources: string[] }>;
    };
    expect(suggestions.items.map((s) => [s.pattern, s.environment, s.sources])).toEqual([
      ['https://merged.shop.example/**', 'qa', ['network']],
    ]);

    await page.goto(`/projects/${projectId}?tab=settings&section=browser-extension`);
    await waitForHydration(page);
    const card = page.locator('[data-shot="project-url-patterns"]');
    await expect(card.getByText('From network requests')).toBeVisible();
  });
});
