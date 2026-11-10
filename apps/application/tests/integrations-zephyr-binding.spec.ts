/**
 * Binding a project to a Zephyr Scale project: the form saves a dry-run binding, Refresh catalog reads the cases, the
 * mapping summary names the keys the catalog holds and the one it does not, a tag's hover card shows the case behind
 * it, the tracker binding and this one stay apart, and the token comes back from nowhere.
 *
 * The spec starts a server of its own (port 3106, its own database) whose requests to Zephyr's regional hosts are
 * redirected to a local mock serving the recorded fixtures; the real service is never called.
 */
import { test, expect } from './fixtures';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startSpawnedServer, type SpawnedServer } from './utils/spawned-server';
import { startMockZephyr, type MockZephyr } from './utils/mock-zephyr';
import { waitForHydration } from './utils';

const PORT = 3106;
const TOKEN = 'zephyr-binding-e2e-token-0123456789';
const PROJECT_NAME = 'zephyr-binding-e2e';

test.describe.configure({ mode: 'serial' });

let server: SpawnedServer | null = null;
let zephyr: MockZephyr | null = null;
let connectionId = 0;
let projectId = 0;
const bodies: string[] = [];

test.describe('Zephyr Scale — binding and catalog', () => {
  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(6 * 60_000);
    zephyr = await startMockZephyr(TOKEN);
    const redirect = pathToFileURL(resolve('tests', 'utils', 'zephyr-fetch-redirect.mjs')).href;
    server = startSpawnedServer({
      port: PORT,
      tempDir: resolve('.test-temp', 'zephyr-binding'),
      env: {
        PIWI_E2E_ZEPHYR_MOCK: zephyr.url,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${redirect}`.trim(),
      },
    });
    await server.ready(5 * 60_000);

    const api = await playwright.request.newContext({ baseURL: server.baseUrl });
    const created = await api.post('/api/integrations/connections', {
      data: { provider: 'zephyr-scale', name: 'Zephyr (sample)', region: 'us', credentials: { apiToken: TOKEN } },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    connectionId = ((await created.json()) as { connection: { id: number } }).connection.id;

    // Three tests carry a key (two the catalog holds, one it does not), one carries none.
    const submit = await api.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT_NAME,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 4000,
        totalTests: 4,
        passedTests: 4,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'pays with a saved card',
            status: 'passed',
            duration: 900,
            location: 'checkout.spec.ts:3:1',
            tags: ['SHOP-T1'],
          },
          {
            title: 'finds a product',
            status: 'passed',
            duration: 800,
            location: 'search.spec.ts:3:1',
            tags: ['SHOP-T2'],
          },
          { title: 'keeps the cart', status: 'passed', duration: 700, location: 'cart.spec.ts:3:1', tags: ['SHOP-T9'] },
          {
            title: 'opens the help page',
            status: 'passed',
            duration: 600,
            location: 'help.spec.ts:3:1',
            tags: ['smoke'],
          },
        ],
      },
    });
    expect(submit.ok(), await submit.text()).toBeTruthy();
    projectId = ((await submit.json()) as { projectId: number }).projectId;
    await api.dispose();
  });

  test.afterAll(async () => {
    await server?.stop();
    await zephyr?.close();
  });

  test.beforeEach(async ({ page }) => {
    page.on('response', async (res) => {
      if (res.url().startsWith(server!.baseUrl) && res.url().includes('/api/')) {
        bodies.push(await res.text().catch(() => ''));
      }
    });
  });

  test('a project is bound from the form, with dry run on', async ({ page, playwright }) => {
    test.setTimeout(3 * 60_000);
    await page.goto(`${server!.baseUrl}/projects/${projectId}?tab=settings&section=test-management`);
    await waitForHydration(page);
    const form = page.getByTestId('test-management-binding');
    await expect(form).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('test-management-connection').click();
    await page.getByRole('option', { name: /Zephyr \(sample\)/ }).click();
    await page.getByTestId('test-management-project').click();
    await page.getByRole('option', { name: 'SHOP', exact: true }).click();
    await expect(page.getByTestId('test-management-dry-run')).toBeChecked();
    await expect(page.getByTestId('test-management-truthful-copy')).toBeVisible();

    await page.getByTestId('test-management-save').click();
    await expect(page.getByText('Test management binding saved').first()).toBeVisible();

    const api = await playwright.request.newContext({ baseURL: server!.baseUrl });
    const saved = (await (await api.get(`/api/projects/${projectId}/test-management`)).json()) as {
      binding: { connectionId: number; providerProjectKey: string; dryRun: boolean; enabled: boolean };
    };
    expect(saved.binding).toMatchObject({ connectionId, providerProjectKey: 'SHOP', dryRun: true, enabled: true });
    await api.dispose();
  });

  test('Refresh catalog reads the cases and the summary names the keys the catalog lacks', async ({ page }) => {
    test.setTimeout(3 * 60_000);
    await page.goto(`${server!.baseUrl}/projects/${projectId}?tab=settings&section=test-management`);
    await waitForHydration(page);
    const summary = page.getByTestId('test-management-summary');
    await expect(summary).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('test-management-catalog')).toContainText('not read yet');

    await page.getByTestId('test-management-refresh').click();
    await expect(page.getByTestId('test-management-catalog')).toContainText('3 test cases', { timeout: 30_000 });
    expect(zephyr!.caseRequests()).toBe(2);

    await expect(page.getByTestId('test-management-mapped')).toContainText('3 tests carry a test case key');
    await expect(page.getByTestId('test-management-mapped')).toContainText('1 has none');
    await expect(page.getByTestId('test-management-unknown')).toContainText('SHOP-T9');
    await expect(page.getByTestId('test-management-unknown')).not.toContainText('SHOP-T1');
  });

  test('a tag shows the name and status of its case on hover', async ({ page, playwright }) => {
    test.setTimeout(3 * 60_000);
    const api = await playwright.request.newContext({ baseURL: server!.baseUrl });
    const listed = (await (
      await api.get(`/api/projects/${projectId}/test-cases?tags=SHOP-T1&maxAgeDays=0`)
    ).json()) as {
      items: Array<{ id: number }>;
    };
    expect(listed.items.length).toBeGreaterThan(0);
    await api.dispose();

    await page.goto(`${server!.baseUrl}/test-cases/${listed.items[0]!.id}`);
    await waitForHydration(page);
    await page.getByText('@SHOP-T1', { exact: true }).first().hover();
    const card = page.getByTestId('test-case-key-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('test-case-key-name')).toHaveText('Checkout with a saved card');
    await expect(card.getByTestId('test-case-key-status')).toHaveText('Approved');
  });

  test('an external ID that is a case key keeps the chip spacing and shows its case on hover', async ({
    page,
    playwright,
  }) => {
    test.setTimeout(3 * 60_000);
    const api = await playwright.request.newContext({ baseURL: server!.baseUrl });
    const current = (await (await api.get(`/api/projects/${projectId}/test-management`)).json()) as {
      binding: { keySources: { tags: boolean; externalId: boolean } };
    };
    const withIds = await api.put(`/api/projects/${projectId}/test-management`, {
      data: { ...current.binding, keySources: { ...current.binding.keySources, externalId: true } },
    });
    expect(withIds.ok(), await withIds.text()).toBeTruthy();
    const submit = await api.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT_NAME,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'pays with an ID',
            status: 'passed',
            duration: 900,
            location: 'id.spec.ts:3:1',
            externalId: 'SHOP-T1',
          },
        ],
      },
    });
    expect(submit.ok(), await submit.text()).toBeTruthy();
    const { runId } = (await submit.json()) as { runId: number };
    const run = (await (await api.get(`/api/test-runs/${runId}`)).json()) as {
      testCases: Array<{ testCaseId: number }>;
    };

    try {
      await page.goto(`${server!.baseUrl}/test-cases/${run.testCases[0]!.testCaseId}`);
      await waitForHydration(page);
      const chip = page.getByRole('heading', { level: 1 }).getByTestId('test-id-chip');
      await expect(chip).toHaveClass(/\bmr-2\b/);
      await chip.hover();
      await expect(page.getByTestId('test-case-key-card').getByTestId('test-case-key-name')).toHaveText(
        'Checkout with a saved card',
        { timeout: 30_000 },
      );
    } finally {
      await api.put(`/api/projects/${projectId}/test-management`, { data: current.binding });
      await api.dispose();
    }
  });

  test('the form takes a typed project, clears the flaky status, starts a new binding with dry run on and shows an options error', async ({
    page,
  }) => {
    test.setTimeout(3 * 60_000);
    await page.goto(`${server!.baseUrl}/projects/${projectId}?tab=settings&section=test-management`);
    await waitForHydration(page);
    await expect(page.getByTestId('test-management-binding')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('test-management-options-error')).toHaveCount(0);

    // Dry run off is unsaved state; None and then a connection again starts over with it on.
    const dryRun = page.getByTestId('test-management-dry-run');
    await dryRun.click();
    await expect(dryRun).not.toBeChecked();
    await page.getByTestId('test-management-connection').click();
    await page.getByRole('option', { name: /None — unbound/ }).click();
    await expect(dryRun).toHaveCount(0);
    await page.getByTestId('test-management-connection').click();
    await page.getByRole('option', { name: /Zephyr \(sample\)/ }).click();
    await expect(dryRun).toBeChecked();

    // A project key the tool does not list is typed, upper-cased and kept.
    await page.getByTestId('test-management-project').click();
    await page.getByRole('combobox').last().fill('zzz');
    await page.getByRole('option', { name: /Use ZZZ/ }).click();
    await expect(page.getByTestId('test-management-project')).toContainText('ZZZ');

    // The flaky status can be set and cleared.
    const flaky = page.getByTestId('test-management-status-flaky');
    await flaky.click();
    await page.getByRole('option', { name: 'In Progress' }).click();
    await expect(flaky).toContainText('In Progress');
    await flaky.locator('xpath=..').locator('[data-slot="trailingClear"]').click();
    await expect(flaky).not.toContainText('In Progress');
    await expect(flaky).toContainText('None');

    // A failed read of the tool's options is an error above the form.
    await page.route('**/test-management/options**', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          statusCode: 502,
          statusMessage: 'The tool did not answer',
          message: 'The tool did not answer',
        }),
      }),
    );
    await page.getByTestId('test-management-project').click();
    await page.getByRole('combobox').last().fill('zzz2');
    await page.getByRole('option', { name: /Use ZZZ2/ }).click();
    await expect(page.getByTestId('test-management-options-error')).toContainText('The tool did not answer');
  });

  test('saving the tracker binding leaves the test management binding in place', async ({ playwright }) => {
    const api = await playwright.request.newContext({ baseURL: server!.baseUrl });
    const put = await api.put(`/api/projects/${projectId}/integrations`, { data: { connectionId: null } });
    expect(put.ok(), await put.text()).toBeTruthy();
    const after = (await (await api.get(`/api/projects/${projectId}/test-management`)).json()) as {
      binding: { connectionId: number; providerProjectKey: string };
    };
    expect(after.binding).toMatchObject({ connectionId, providerProjectKey: 'SHOP' });
    await api.dispose();
  });

  test('the token went to the mock as a bearer and came back from no response', async ({ playwright }) => {
    const api = await playwright.request.newContext({ baseURL: server!.baseUrl });
    for (const path of [
      '/api/integrations/connections',
      `/api/integrations/connections/${connectionId}`,
      `/api/projects/${projectId}/test-management`,
      `/api/projects/${projectId}/test-management/summary`,
      `/api/projects/${projectId}/test-management/key-config`,
      `/api/projects/${projectId}/test-management/cases?keys=SHOP-T1`,
      `/api/projects/${projectId}/test-management/options?connectionId=${connectionId}&projectKey=SHOP`,
    ]) {
      const res = await api.get(path);
      expect(res.ok(), `${path}: ${await res.text()}`).toBeTruthy();
      bodies.push(await res.text());
    }
    await api.dispose();

    expect(bodies.length).toBeGreaterThan(10);
    expect(bodies.filter((b) => b.includes(TOKEN))).toEqual([]);
    const sent = zephyr!.calls.filter((c) => c.authorization === `Bearer ${TOKEN}`);
    expect(sent.length).toBeGreaterThan(0);
    expect(zephyr!.calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });
});
