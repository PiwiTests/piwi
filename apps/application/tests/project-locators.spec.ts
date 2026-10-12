import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

/**
 * The project's Locators page: pasted locators checked against the locator
 * index, the index listed, and the branch select reading one branch at a time.
 * Runs are submitted with steps as Playwright 1.63 reports them.
 */

const ROOT = '/work/shop';
const PAY = "getByRole('button', { name: 'Pay' })";
const COUNTRY = "getByRole('form', { name: 'Shipping' }).getByLabel('Country')";
const VOUCHER = "getByLabel('Voucher')";

const step = (title: string, locator: string, location: string) => ({
  title,
  category: 'action',
  duration: 5,
  params: { locator },
  location: `${ROOT}/${location}`,
});

function run(branch: string, minutes: number, cases: Array<{ title: string; steps: unknown[] }>) {
  return {
    projectName: PROJECT.LOCATORS_PAGE,
    status: 'passed',
    startTime: new Date(Date.UTC(2026, 8, 1, 10, minutes)).toISOString(),
    duration: 1000,
    totalTests: cases.length,
    passedTests: cases.length,
    failedTests: 0,
    skippedTests: 0,
    metadata: { workingDir: ROOT, scm: { branch } },
    testCases: cases.map((c) => ({
      title: c.title,
      status: 'passed',
      duration: 100,
      location: 'tests/checkout.spec.ts:1:1',
      retries: 0,
      steps: c.steps,
    })),
  };
}

test.describe.serial('Project locators page', () => {
  let projectId: number;

  test('indexes the steps of runs on the default branch and on a feature branch', async ({ request }) => {
    const byCard = [
      step('Click', PAY, 'tests/checkout.spec.ts:20:3'),
      step('Select', COUNTRY, 'pages/shipping.ts:9:5'),
    ];
    const byVoucher = [step('Click', PAY, 'tests/checkout.spec.ts:40:3')];
    for (const minutes of [0, 1]) {
      const response = await request.post('/api/test-runs/submit', {
        data: run('main', minutes, [
          { title: 'pays by card', steps: byCard },
          { title: 'pays with a voucher', steps: byVoucher },
        ]),
      });
      expect(response.ok()).toBeTruthy();
      projectId = (await response.json()).projectId;
    }
    const feature = await request.post('/api/test-runs/submit', {
      data: run('feature/voucher', 2, [
        {
          title: 'pays by card',
          steps: [
            step('Click', PAY, 'tests/checkout.spec.ts:20:3'),
            step('Fill', VOUCHER, 'tests/checkout.spec.ts:21:3'),
          ],
        },
      ]),
    });
    expect(feature.ok()).toBeTruthy();

    const first = await request.get(`/api/projects/${projectId}/locator-index`);
    const main = await first.json();
    expect(main).toMatchObject({ branch: 'main', defaultBranch: 'main' });
    // The same index again, asked with its ETag, is a 304 without a body.
    const etag = first.headers()['etag'];
    expect(etag).toBeTruthy();
    const again = await request.get(`/api/projects/${projectId}/locator-index`, {
      headers: { 'If-None-Match': etag! },
    });
    expect(again.status()).toBe(304);
    expect(main.branches.map((b: { name: string }) => b.name)).toEqual(['feature/voucher']);
    expect(main.locators.map((l: { locator: string }) => l.locator)).toEqual([PAY, COUNTRY]);

    const onFeature = await (
      await request.get(`/api/projects/${projectId}/locator-index`, { params: { branch: 'feature/voucher' } })
    ).json();
    expect(onFeature.locators.map((l: { locator: string }) => l.locator).sort()).toEqual([PAY, VOUCHER].sort());

    const bad = await request.get(`/api/projects/${projectId}/locator-index`, { params: { branch: 'x'.repeat(300) } });
    expect(bad.status()).toBe(400);
  });

  test('predict_locator_breaks names the locators a diff breaks, with the rewrite', async ({ request }) => {
    const diff = [
      'diff --git a/src/components/PayButton.vue b/src/components/PayButton.vue',
      '--- a/src/components/PayButton.vue',
      '+++ b/src/components/PayButton.vue',
      '@@ -3 +3 @@',
      '-    <button class="pay">Pay</button>',
      '+    <button class="pay">Checkout</button>',
    ].join('\n');
    const res = await request.post('/mcp', {
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'predict_locator_breaks', arguments: { projectId, diff } },
      },
    });
    expect(res.ok()).toBeTruthy();
    const result = JSON.parse((await res.json()).result.content[0].text);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      locator: PAY,
      confidence: 'likely',
      rewrite: "getByRole('button', { name: 'Checkout' })",
      change: { filePath: 'src/components/PayButton.vue', line: 3, kind: 'text', before: 'Pay', after: 'Checkout' },
      edits: [{ before: 'Pay', after: 'Checkout' }],
    });
    expect(result.items[0].tests).toHaveLength(2);
  });

  test('checks pasted locators and lists the tests reaching them', async ({ page }) => {
    const pasted = `${PAY}\ngetByTestId('nowhere')`;
    await page.goto(`/projects/${projectId}/locators?q=${encodeURIComponent(pasted)}`);
    const check = page.locator('[data-shot="locator-check"]');
    // The index loads after the page, on the client.
    await expect(check).toBeVisible({ timeout: 20_000 });
    await expect(check.locator('[data-verdict]')).toHaveText(['Used by 2 tests', 'Not used by any test']);
    const reaching = page.locator('[data-shot="locator-check-tests"]');
    await expect(reaching).toContainText('Tests reaching these locators (2)');
    await expect(reaching.getByRole('link', { name: 'pays by card' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Branch' })).toContainText('main (default branch)');
  });

  test('the branch select reads what the branch tests use', async ({ page }) => {
    await page.goto(`/projects/${projectId}/locators`);
    const list = page.locator('[data-shot="locator-list"]');
    await expect(list).toContainText("getByLabel('Country')", { timeout: 20_000 });
    await page.getByRole('combobox', { name: 'Branch' }).click();
    await page.getByRole('option', { name: 'feature/voucher' }).click();
    await expect(page).toHaveURL(/branch=feature(%2F|\/)voucher/);
    await expect(list).toContainText("getByLabel('Voucher')");
    await expect(list).not.toContainText("getByLabel('Country')");
    await expect(page.getByText('Tests that ran on feature/voucher count with what they did there')).toBeVisible();

    // "Who uses this?" answers on the branch too.
    await list.getByTitle(`Who uses ${PAY}?`).click();
    const drawer = page.locator('[data-shot="locator-usage-drawer"]');
    await expect(drawer).toContainText('2 tests');
    await expect(drawer).toContainText('on feature/voucher');
  });

  test('the stability select lists the brittle locators, and Who uses this says why', async ({ page, request }) => {
    const BRITTLE = "locator('.btn-primary').nth(1)";
    const response = await request.post('/api/test-runs/submit', {
      data: run('main', 3, [
        { title: 'adds a legacy mug', steps: [step('Click', BRITTLE, 'tests/legacy.spec.ts:7:3')] },
      ]),
    });
    expect(response.ok()).toBeTruthy();

    await page.goto(`/projects/${projectId}/locators`);
    const list = page.locator('[data-shot="locator-list"]');
    await expect(list).toContainText(BRITTLE, { timeout: 20_000 });
    await expect(list.locator('li', { hasText: BRITTLE }).locator('[data-stability]')).toHaveText(
      'brittle: position, CSS class',
    );
    await expect(list.locator('li', { hasText: PAY }).locator('[data-stability]')).toHaveCount(0);

    await list.getByRole('combobox', { name: 'Stability' }).click();
    await page.getByRole('option', { name: 'Brittle (1)' }).click();
    await expect(page).toHaveURL(/stability=brittle/);
    await expect(list.locator('li')).toHaveCount(1);
    await expect(list).toContainText(BRITTLE);

    await list.getByTitle(`Who uses ${BRITTLE}?`).click();
    const drawer = page.locator('[data-shot="locator-usage-drawer"]');
    await expect(drawer.locator('[data-stability]')).toContainText('Brittle: position, CSS class');
  });

  test('the pages each call ran on reach the index, the list and its page filter', async ({ page, request }) => {
    const SEARCH = "getByRole('searchbox', { name: 'Search' })";
    const body = run('main', 4, [
      { title: 'searches the catalog', steps: [step('Fill', SEARCH, 'tests/search.spec.ts:5:3')] },
    ]);
    // As the capture fixtures record them: the call site, the chain, the page's origin and key.
    const withPages = {
      ...body,
      testCases: body.testCases.map((c) => ({
        ...c,
        locatorPages: [
          {
            location: `${ROOT}/tests/search.spec.ts:5:3`,
            locator: SEARCH,
            origin: 'https://shop.test',
            page: '/search',
            arrival: true,
          },
        ],
      })),
    };
    const response = await request.post('/api/test-runs/submit', { data: withPages });
    expect(response.ok()).toBeTruthy();

    const index = await (await request.get(`/api/projects/${projectId}/locator-index`)).json();
    expect(index.pages).toEqual(['/search']);
    const entry = index.locators.find((l: { locator: string }) => l.locator === SEARCH);
    expect(entry.uses[0]).toMatchObject({ pages: [0], arrival: [0] });

    await page.goto(`/projects/${projectId}/locators`);
    const list = page.locator('[data-shot="locator-list"]');
    await expect(list.locator('li', { hasText: SEARCH }).locator('[data-pages]')).toHaveText('/search', {
      timeout: 20_000,
    });
    await list.getByRole('combobox', { name: 'Page' }).click();
    await page.getByRole('option', { name: '/search' }).click();
    await expect(page).toHaveURL(/page=(%2F|\/)search/);
    await expect(list.locator('li')).toHaveCount(1);
  });
});
