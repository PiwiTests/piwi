/**
 * Sending a finished run's results to Zephyr Scale: a dry-run binding sends nothing and shows what it would, a live
 * binding makes one test cycle with the worst result of each case key, a sharded run sends once when its last shard
 * finishes, a partial run and a run outside the scope send nothing, and an upload that ended without an answer reads as
 * an unknown outcome until Sync again finds the cycle it made.
 *
 * The spec starts a server of its own (port 3107, its own database) whose requests to Zephyr's regional hosts are
 * redirected to a local mock; the real service is never called.
 */
import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startSpawnedServer, type SpawnedServer } from './utils/spawned-server';
import { startMockZephyr, type MockZephyr } from './utils/mock-zephyr';
import { waitForHydration } from './utils';

const PORT = 3107;
const TOKEN = 'zephyr-sync-e2e-token-0123456789';
const PROJECT_NAME = 'zephyr-sync-e2e';

test.describe.configure({ mode: 'serial' });

let server: SpawnedServer | null = null;
let zephyr: MockZephyr | null = null;
let api: APIRequestContext;
let connectionId = 0;
let projectId = 0;

interface Sync {
  status: string;
  error: string | null;
  dryRun: boolean;
  outcomeUnknown: boolean;
  runKey: string | null;
  resultCount: number;
  counts: { passed: number; failed: number; flaky: number; notExecuted: number };
  unknownKeys: string[];
}

const syncOf = async (runId: number): Promise<Sync | null> =>
  ((await (await api.get(`/api/test-runs/${runId}/test-management-sync`)).json()) as { sync: Sync | null }).sync;

async function bind(binding: { dryRun: boolean; branches?: string[] }) {
  const put = await api.put(`/api/projects/${projectId}/test-management`, {
    data: {
      connectionId,
      providerProjectKey: 'SHOP',
      enabled: true,
      dryRun: binding.dryRun,
      runScope: { branches: binding.branches ?? ['main'], defaultBranch: false, environments: [] },
    },
  });
  expect(put.ok(), await put.text()).toBeTruthy();
}

/** The tests of a run: two cases share a key (the worst result wins), one fails, one carries an unknown key, one none. */
const TESTS = [
  { title: 'pays with a saved card', status: 'passed', location: 'checkout.spec.ts:3:1', tags: ['SHOP-T1'] },
  { title: 'pays with a gift card', status: 'failed', location: 'checkout.spec.ts:9:1', tags: ['SHOP-T1'] },
  { title: 'finds a product', status: 'passed', location: 'search.spec.ts:3:1', tags: ['SHOP-T2'] },
  { title: 'keeps the cart', status: 'passed', location: 'cart.spec.ts:3:1', tags: ['SHOP-T9'] },
  { title: 'opens the help page', status: 'passed', location: 'help.spec.ts:3:1', tags: ['smoke'] },
].map((t) => ({ ...t, duration: 500 }));

/** The upload a run of `TESTS` makes. */
const EXPECTED_EXECUTIONS = [
  { result: 'Fail', testCase: { key: 'SHOP-T1' } },
  { result: 'Pass', testCase: { key: 'SHOP-T2' } },
];

async function submitRun(options: { branch?: string; ci?: boolean; isFullRun?: boolean } = {}): Promise<number> {
  const { branch = 'main', ci = true, isFullRun = true } = options;
  const res = await api.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT_NAME,
      status: 'failed',
      startTime: new Date().toISOString(),
      duration: 4000,
      totalTests: TESTS.length,
      passedTests: TESTS.length - 1,
      failedTests: 1,
      skippedTests: 0,
      isFullRun,
      metadata: { scm: { branch }, ...(ci ? { ci: { provider: 'github', buildNumber: '4711' } } : {}) },
      testCases: TESTS,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { runId: number }).runId;
}

/** Wait out the moment a finished run's effects take, then read that nothing was queued. */
async function expectNoSync(runId: number) {
  await new Promise((done) => setTimeout(done, 3000));
  expect(await syncOf(runId)).toBeNull();
}

test.describe('Zephyr Scale — results sync', () => {
  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(6 * 60_000);
    zephyr = await startMockZephyr(TOKEN);
    const redirect = pathToFileURL(resolve('tests', 'utils', 'zephyr-fetch-redirect.mjs')).href;
    server = startSpawnedServer({
      port: PORT,
      tempDir: resolve('.test-temp', 'zephyr-sync'),
      env: {
        PIWI_E2E_ZEPHYR_MOCK: zephyr.url,
        PIWI_SITE_URL: `http://127.0.0.1:${PORT}`,
        PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE: '600',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${redirect}`.trim(),
      },
    });
    await server.ready(5 * 60_000);

    api = await playwright.request.newContext({ baseURL: server.baseUrl });
    const created = await api.post('/api/integrations/connections', {
      data: { provider: 'zephyr-scale', name: 'Zephyr (sample)', region: 'us', credentials: { apiToken: TOKEN } },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    connectionId = ((await created.json()) as { connection: { id: number } }).connection.id;

    // A run from a developer's machine makes the project; it sends nothing, as nothing is bound yet.
    const first = await api.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT_NAME,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: TESTS.length,
        passedTests: TESTS.length,
        failedTests: 0,
        skippedTests: 0,
        testCases: TESTS.map((t) => ({ ...t, status: 'passed' })),
      },
    });
    expect(first.ok(), await first.text()).toBeTruthy();
    projectId = ((await first.json()) as { projectId: number }).projectId;

    await bind({ dryRun: true });
    const refreshed = await api.post(`/api/projects/${projectId}/test-management/catalog/refresh`);
    expect(refreshed.ok(), await refreshed.text()).toBeTruthy();
  });

  test.afterAll(async () => {
    await api?.dispose();
    await server?.stop();
    await zephyr?.close();
  });

  test.beforeEach(() => zephyr!.reset());

  test('a dry run sends nothing and shows what it would send', async ({ page }) => {
    test.setTimeout(3 * 60_000);
    await bind({ dryRun: true });
    const runId = await submitRun();
    await expect.poll(() => syncOf(runId), { timeout: 60_000 }).toMatchObject({ status: 'done', dryRun: true });
    expect(await syncOf(runId)).toMatchObject({
      resultCount: 2,
      counts: { passed: 1, failed: 1, flaky: 0, notExecuted: 0 },
      runKey: null,
    });
    expect(zephyr!.uploads).toEqual([]);
    expect(zephyr!.weblinks).toEqual([]);

    await page.goto(`${server!.baseUrl}/test-runs/${runId}`);
    await waitForHydration(page);
    const panel = page.getByTestId('run-test-management-sync');
    await expect(panel.getByTestId('sync-dry-run')).toContainText('nothing was sent', { timeout: 60_000 });
    await expect(panel.getByTestId('sync-dry-run')).toContainText('2 results: 1 passed, 1 failed');
  });

  test('a run sends one test cycle with the worst result of each case key, and links it both ways', async ({
    page,
  }) => {
    test.setTimeout(3 * 60_000);
    await bind({ dryRun: false });
    const runId = await submitRun();
    await expect.poll(() => syncOf(runId), { timeout: 60_000 }).toMatchObject({ status: 'done', runKey: 'SHOP-R1' });

    expect(zephyr!.uploads).toHaveLength(1);
    const [upload] = zephyr!.uploads;
    expect(upload!.projectKey).toBe('SHOP');
    expect(upload!.name).toContain(`Piwi #${runId}`);
    expect([...upload!.executions].sort((a, b) => a.testCase.key.localeCompare(b.testCase.key))).toEqual(
      EXPECTED_EXECUTIONS,
    );
    expect(zephyr!.weblinks).toEqual([
      { cycleKey: 'SHOP-R1', url: `http://127.0.0.1:${PORT}/test-runs/${runId}`, description: `Piwi run #${runId}` },
    ]);
    expect(await syncOf(runId)).toMatchObject({
      resultCount: 2,
      counts: { passed: 1, failed: 1 },
      unknownKeys: ['SHOP-T9'],
    });

    const run = (await (await api.get(`/api/test-runs/${runId}`)).json()) as {
      links: Array<{ provider: string; key: string; url: string }>;
    };
    // Zephyr names the cycle by an API address that opens no page, so the link keeps the key and no address.
    expect(run.links).toMatchObject([{ provider: 'zephyr-scale', key: 'SHOP-R1', url: '' }]);

    await page.goto(`${server!.baseUrl}/test-runs/${runId}`);
    await waitForHydration(page);
    const panel = page.getByTestId('run-test-management-sync');
    await expect(panel.getByTestId('sync-run-key')).toHaveText('SHOP-R1', { timeout: 60_000 });
    await expect(panel.getByTestId('sync-sent')).toContainText('2 results sent: 1 passed, 1 failed');
    await expect(panel.getByTestId('sync-unknown-keys')).toContainText('SHOP-T9');
    await expect(panel.getByTestId('sync-again')).toHaveCount(0);
    const chip = page.locator('[data-tour="run-links"]').getByTestId('link-chip-open');
    await expect(chip).toContainText('SHOP-R1');
    expect(await chip.evaluate((element) => element.tagName)).toBe('SPAN');
  });

  test('a sharded run sends once, when its last shard finishes', async () => {
    test.setTimeout(3 * 60_000);
    await bind({ dryRun: false });
    const instanceId = `zephyr-sync-shards-${Date.now()}`;
    const startTime = new Date().toISOString();
    const start = async (shardIndex: number, totalTests: number) => {
      const res = await api.post('/api/test-runs/start', {
        data: {
          projectName: PROJECT_NAME,
          startTime,
          instanceId,
          shardIndex,
          shardTotal: 2,
          totalTests,
          metadata: { scm: { branch: 'main' }, ci: { provider: 'github', buildNumber: '4712' } },
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()) as { runId: number; streamToken: string };
    };
    const shard1 = await start(1, 3);
    const shard2 = await start(2, 2);
    expect(shard2.runId).toBe(shard1.runId);

    const stream = async (token: string, tests: typeof TESTS) => {
      const res = await api.post(`/api/test-runs/${shard1.runId}/events`, {
        data: { streamToken: token, testCases: tests.map((t) => ({ ...t, type: 'complete', retries: 0 })) },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
    };
    const finish = async (token: string, passed: number, failed: number) => {
      const res = await api.post(`/api/test-runs/${shard1.runId}/finish`, {
        data: {
          streamToken: token,
          status: failed ? 'failed' : 'passed',
          startTime,
          duration: 3000,
          totalTests: passed + failed,
          passedTests: passed,
          failedTests: failed,
          skippedTests: 0,
          flakyTests: 0,
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
    };

    await stream(shard1.streamToken, TESTS.slice(0, 3));
    await stream(shard2.streamToken, TESTS.slice(3));
    await finish(shard1.streamToken, 1, 2);
    await new Promise((done) => setTimeout(done, 3000));
    expect(zephyr!.uploads).toEqual([]);
    expect(await syncOf(shard1.runId)).toBeNull();

    await finish(shard2.streamToken, 2, 0);
    await expect.poll(() => syncOf(shard1.runId), { timeout: 60_000 }).toMatchObject({ status: 'done' });
    expect(zephyr!.uploads).toHaveLength(1);
    expect(zephyr!.uploads[0]!.name).toContain(`Piwi #${shard1.runId}`);
  });

  test('a partial run and a run outside the scope send nothing', async () => {
    test.setTimeout(3 * 60_000);
    await bind({ dryRun: false });
    const partial = await submitRun({ isFullRun: false });
    const elsewhere = await submitRun({ branch: 'feature/checkout' });
    const local = await submitRun({ ci: false });
    await expectNoSync(partial);
    await expectNoSync(elsewhere);
    await expectNoSync(local);
    expect(zephyr!.uploads).toEqual([]);

    // A run that qualifies after them still sends: the three were left out, not lost.
    const full = await submitRun();
    await expect.poll(() => syncOf(full), { timeout: 60_000 }).toMatchObject({ status: 'done' });
    expect(zephyr!.uploads).toHaveLength(1);
    expect(zephyr!.uploads[0]!.name).toContain(`Piwi #${full}`);
  });

  test('an upload that ended without an answer reads as an unknown outcome, and Sync again finds the cycle', async ({
    page,
  }) => {
    test.setTimeout(3 * 60_000);
    await bind({ dryRun: false });
    zephyr!.failNextUpload(503, { createsCycle: true });
    const runId = await submitRun();
    await expect
      .poll(() => syncOf(runId), { timeout: 60_000 })
      .toMatchObject({
        status: 'failed',
        outcomeUnknown: true,
        runKey: null,
      });
    expect(zephyr!.uploads).toHaveLength(1);
    expect(zephyr!.weblinks).toEqual([]);

    await page.goto(`${server!.baseUrl}/test-runs/${runId}`);
    await waitForHydration(page);
    const panel = page.getByTestId('run-test-management-sync');
    await expect(panel.getByTestId('sync-failed')).toContainText('Outcome unknown', { timeout: 60_000 });
    await expect(panel.getByTestId('sync-outcome-unknown')).toBeVisible();

    await panel.getByTestId('sync-again').click();
    await expect(panel.getByTestId('sync-run-key')).toHaveText('SHOP-R1', { timeout: 60_000 });
    // The cycle the first upload made was found and linked, not made a second time.
    expect(zephyr!.uploads).toHaveLength(1);
    expect(zephyr!.weblinks).toMatchObject([{ cycleKey: 'SHOP-R1' }]);
    expect(await syncOf(runId)).toMatchObject({ status: 'done', runKey: 'SHOP-R1' });
  });

  test('Sync again uploads when the tool holds no cycle of the run', async () => {
    test.setTimeout(3 * 60_000);
    await bind({ dryRun: false });
    zephyr!.failNextUpload(503);
    const runId = await submitRun();
    await expect.poll(() => syncOf(runId), { timeout: 60_000 }).toMatchObject({ outcomeUnknown: true });

    const again = await api.post(`/api/test-runs/${runId}/test-management-sync`);
    expect(again.ok(), await again.text()).toBeTruthy();
    expect(((await again.json()) as { status: string }).status).toBe('done');
    expect(zephyr!.uploads).toHaveLength(2);
    expect(await syncOf(runId)).toMatchObject({ status: 'done', runKey: 'SHOP-R1' });
  });

  test('the token reaches the tool as a bearer and comes back from nowhere', async () => {
    await bind({ dryRun: false });
    const runId = await submitRun();
    await expect.poll(() => syncOf(runId), { timeout: 60_000 }).toMatchObject({ status: 'done' });
    expect(zephyr!.calls.length).toBeGreaterThan(0);
    expect(zephyr!.calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
    for (const path of [`/api/projects/${projectId}/test-management`, `/api/test-runs/${runId}/test-management-sync`]) {
      expect(await (await api.get(path)).text()).not.toContain(TOKEN);
    }
  });
});
