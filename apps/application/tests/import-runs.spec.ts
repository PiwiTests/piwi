import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { buildZip } from '../server/utils/trace-zip';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { createHash } from 'node:crypto';
import { join } from 'path';
import { PROJECT } from '#shared/test-project-names';
import { buildBlobReport, buildTraceArchive, errorContextMarkdown } from './utils/blob-report-fixture';

/**
 * Deletes the projects a suite imports into. Imports are deduplicated by
 * content, so a suite that runs a second time against surviving data sees
 * `duplicate` where it asserts `imported`. Both suites below run serially,
 * where one failure replays every test in the block.
 */
async function resetImportProjects(playwright: typeof import('@playwright/test').playwright, names: string[]) {
  const api = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const response = await api.get('/api/projects/menu');
    if (!response.ok()) return;
    const projects = ((await response.json()) as { items: { id: number; name: string }[] }).items;
    for (const project of projects) {
      if (names.includes(project.name)) await api.delete(`/api/projects/${project.id}`);
    }
  } finally {
    await api.dispose();
  }
}

/**
 * End-to-end cover for importing historical blob reports: the pre-flight that
 * spares the user a doomed upload, the import itself, and the page that drives
 * both.
 */
test.describe('Blob report import', () => {
  test.describe.configure({ mode: 'serial' });

  const tempDir = join(process.cwd(), '.test-temp');
  const archivePath = join(tempDir, 'import-report-a.zip');
  const secondArchivePath = join(tempDir, 'import-report-b.zip');

  /** Bytes of the primary archive, reused for the duplicate assertions. */
  let archive: Buffer;

  test.beforeAll(async ({ playwright }) => {
    await resetImportProjects(playwright, [PROJECT.IMPORT_BLOB, PROJECT.IMPORT_BLOB_UI]);

    if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

    archive = buildBlobReport({
      runStatus: 'failed',
      rootDir: '/repo/tests',
      configFile: '../playwright.config.ts',
      file: 'checkout.spec.ts',
      tests: [
        {
          testId: 'import-pass',
          title: 'completes the checkout',
          suitePath: ['checkout'],
          attempts: [{ status: 'passed', duration: 120 }],
        },
        {
          testId: 'import-fail',
          title: 'shows a payment error',
          suitePath: ['checkout'],
          line: 14,
          attempts: [
            {
              status: 'failed',
              duration: 900,
              errorMessage: "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('button')",
              attachments: [
                {
                  name: 'error-context',
                  contentType: 'text/markdown',
                  body: errorContextMarkdown({
                    snapshot: '- heading "Checkout" [level=1]',
                    source: [
                      [13, "  test('shows a payment error', async ({ page }) => {"],
                      [14, "    await expect(page.getByRole('button')).toBeVisible();"],
                    ],
                  }),
                },
                { name: 'screenshot', contentType: 'image/png', body: 'not-really-a-png' },
              ],
            },
          ],
        },
      ],
    });
    writeFileSync(archivePath, archive);

    // A second, distinct archive so the UI has something to actually import.
    writeFileSync(
      secondArchivePath,
      buildBlobReport({
        startTime: 1_700_000_500_000,
        file: 'search.spec.ts',
        tests: [{ testId: 'import-search', title: 'finds a product', attempts: [{ status: 'passed', duration: 42 }] }],
      }),
    );
  });

  test('pre-flight judges archives before any upload', async ({ request }) => {
    const response = await request.post('/api/test-runs/import/check', {
      data: {
        projectName: PROJECT.IMPORT_BLOB,
        files: [
          { name: 'ok.zip', size: archive.length, hash: 'a'.repeat(64) },
          { name: 'huge.zip', size: 10 * 1024 * 1024 * 1024, hash: 'b'.repeat(64) },
          { name: 'notes.txt', size: 100, hash: 'c'.repeat(64) },
          { name: 'empty.zip', size: 0, hash: 'd'.repeat(64) },
          { name: 'no-hash.zip', size: 100, hash: 'nope' },
        ],
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.maxBytes).toBeGreaterThan(0);
    expect(body.results.map((r: { status: string }) => r.status)).toEqual([
      'ok',
      'too-large',
      'invalid',
      'invalid',
      'invalid',
    ]);
    expect(body.results[1].message).toContain('exceeds');
  });

  test('imports a run with its cases, evidence and files', async ({ request }) => {
    const response = await request.post('/api/test-runs/import', {
      multipart: {
        projectName: PROJECT.IMPORT_BLOB,
        archive: { name: 'report-a.zip', mimeType: 'application/zip', buffer: archive },
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();

    expect(body.status).toBe('imported');
    expect(body.runStatus).toBe('failed');
    expect(body.totalTests).toBe(2);
    expect(body.passedTests).toBe(1);
    expect(body.failedTests).toBe(1);
    expect(body.attachmentCount).toBe(2);
    // Recorded relative to the config directory, matching live reporter runs.
    expect(body.filePaths).toEqual(['tests/checkout.spec.ts']);

    const runResponse = await request.get(`/api/test-runs/${body.runId}`);
    expect(runResponse.status()).toBe(200);
    const run = await runResponse.json();

    const failing = run.testCases.find((c: { title: string }) => c.title === 'shows a payment error');
    expect(failing).toBeTruthy();
    expect(failing.status).toBe('failed');
    // Imported failures cluster exactly like reported ones.
    expect(failing.failureClusterId).toBeTruthy();

    // Evidence recovered from Playwright's own error-context attachment, read
    // back from the execution detail where the dashboard renders it.
    const caseResponse = await request.get(`/api/test-run-cases/${failing.executionId}`);
    expect(caseResponse.status()).toBe(200);
    const execution = await caseResponse.json();
    expect(execution.ariaSnapshot).toContain('heading "Checkout"');
    expect(execution.testSource).toContain('>   14 |');
  });

  test('re-importing the same archive changes nothing', async ({ request }) => {
    const first = await request.post('/api/test-runs/import', {
      multipart: {
        projectName: PROJECT.IMPORT_BLOB,
        archive: { name: 'report-a.zip', mimeType: 'application/zip', buffer: archive },
      },
    });
    const body = await first.json();
    expect(body.status).toBe('duplicate');

    // And the pre-flight now recognises it without an upload.
    const check = await request.post('/api/test-runs/import/check', {
      data: {
        projectName: PROJECT.IMPORT_BLOB,
        files: [{ name: 'report-a.zip', size: archive.length, hash: sha256(archive) }],
      },
    });
    const checkBody = await check.json();
    expect(checkBody.results[0].status).toBe('duplicate');
    expect(checkBody.results[0].runId).toBe(body.runId);
  });

  test('rejects something that is not a blob report with a usable message', async ({ request }) => {
    const response = await request.post('/api/test-runs/import', {
      multipart: {
        projectName: PROJECT.IMPORT_BLOB,
        archive: { name: 'bogus.zip', mimeType: 'application/zip', buffer: Buffer.from('definitely not a zip') },
      },
    });

    expect(response.status()).toBe(400);
    expect((await response.json()).message).toMatch(/ZIP|report\.jsonl/i);
  });

  test('imports through the project page', async ({ page, request }) => {
    // Create the project first so the page has one to navigate to.
    const seed = await request.post('/api/test-runs/import', {
      multipart: {
        projectName: PROJECT.IMPORT_BLOB_UI,
        archive: { name: 'seed.zip', mimeType: 'application/zip', buffer: archive },
      },
    });
    const projectId = (await seed.json()).projectId;

    await page.goto(`/projects/${projectId}/import`);
    // The limit line renders after mount, so its presence means the page has
    // hydrated and the file input's handler is live. Generous timeout: the dev
    // server compiles this route on first request, well past the default wait.
    await expect(page.getByText(/Up to .* per archive/)).toBeVisible({ timeout: 30000 });

    // The already-imported archive and a new one, together.
    await page.locator('input[type=file]').setInputFiles([archivePath, secondArchivePath]);

    await expect(page.getByText('Already imported into this project.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Import 1 archive$/ })).toBeEnabled();

    await page.getByRole('button', { name: /^Import 1 archive$/ }).click();

    // `exact` matters: "Already imported" also contains "Imported".
    await expect(page.getByText('Imported', { exact: true })).toBeVisible({ timeout: 30000 });
    // The summary names the spec path so the user can confirm history lines up.
    await expect(page.getByText('search.spec.ts')).toBeVisible();
    // The duplicate stayed a duplicate — it was never re-imported.
    await expect(page.getByText('Already imported', { exact: true })).toBeVisible();
  });

  test('settles an oversized file in the browser, without uploading it', async ({ page, request }) => {
    const seed = await request.post('/api/test-runs/import', {
      multipart: {
        projectName: PROJECT.IMPORT_BLOB_UI,
        archive: { name: 'seed.zip', mimeType: 'application/zip', buffer: archive },
      },
    });
    const projectId = (await seed.json()).projectId;

    await page.goto(`/projects/${projectId}/import`);
    await expect(page.getByText(/Up to .* per archive/)).toBeVisible({ timeout: 30000 });

    // Anything the server would refuse is refused here instead — no request.
    let importRequests = 0;
    page.on('request', (req) => {
      if (req.url().endsWith('/api/test-runs/import')) importRequests++;
    });

    await page
      .locator('input[type=file]')
      .setInputFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('nope') }]);

    await expect(page.getByText('Not importable')).toBeVisible();
    await expect(page.getByText('Expected a .zip blob report', { exact: false })).toBeVisible();
    expect(importRequests).toBe(0);
  });
});

test.describe('Trace file import', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ playwright }) => {
    await resetImportProjects(playwright, [
      PROJECT.IMPORT_TRACE,
      PROJECT.IMPORT_TRACE_GROUP,
      PROJECT.IMPORT_TRACE_RETRY,
    ]);
  });

  /** One trace per attempt, as Playwright writes them under test-results/. */
  const passing = buildTraceArchive({
    title: 'orders.spec.ts:8 › orders › lists orders',
    wallTime: 1_700_000_000_000,
    monotonicTime: 1000,
    actions: [{ apiName: 'page.goto', startTime: 1100, endTime: 1500 }],
  });
  const failingFirst = buildTraceArchive({
    title: 'orders.spec.ts:20 › orders › opens an order',
    wallTime: 1_700_000_010_000,
    monotonicTime: 2000,
    error: { message: "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('row')" },
  });
  const failingRetry = buildTraceArchive({
    title: 'orders.spec.ts:20 › orders › opens an order',
    wallTime: 1_700_000_020_000,
    monotonicTime: 3000,
    error: { message: "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('row')" },
  });

  const groupA = buildTraceArchive({ title: 'batch.spec.ts:1 › alpha', wallTime: 1_700_000_100_000 });
  const groupB = buildTraceArchive({ title: 'batch.spec.ts:2 › beta', wallTime: 1_700_000_200_000 });
  const groupC = buildTraceArchive({ title: 'batch.spec.ts:3 › gamma', wallTime: 1_700_000_300_000 });

  function post(request: APIRequestContext, projectName: string, archive: Buffer, group?: string) {
    return request.post('/api/test-runs/import', {
      multipart: {
        projectName,
        ...(group ? { importGroup: group } : {}),
        archive: { name: 'trace.zip', mimeType: 'application/zip', buffer: archive },
      },
    });
  }

  test('imports a lone trace as its own single-test run', async ({ request }) => {
    const response = await post(request, PROJECT.IMPORT_TRACE, passing);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.kind).toBe('trace');
    expect(body.status).toBe('imported');
    expect(body.totalTests).toBe(1);
    expect(body.passedTests).toBe(1);
    expect(body.traceCount).toBe(1);
    expect(body.caseTitle).toBe('orders › lists orders');
    expect(body.startTime).toBe(new Date(1_700_000_000_000).toISOString());

    const run = await (await request.get(`/api/test-runs/${body.runId}`)).json();
    const execution = run.testCases[0];
    expect(execution.title).toBe('lists orders');
    expect(execution.status).toBe('passed');
  });

  test('re-importing the same trace changes nothing', async ({ request }) => {
    const body = await (await post(request, PROJECT.IMPORT_TRACE, passing)).json();
    expect(body.status).toBe('duplicate');
    expect(body.totalTests).toBe(1);
  });

  test('gathers a group of traces into one run, with retries in order', async ({ request }) => {
    const group = 'f'.repeat(64);

    const first = await (await post(request, PROJECT.IMPORT_TRACE_GROUP, passing, group)).json();
    const second = await (await post(request, PROJECT.IMPORT_TRACE_GROUP, failingFirst, group)).json();
    const third = await (await post(request, PROJECT.IMPORT_TRACE_GROUP, failingRetry, group)).json();

    // Every trace lands in the same run, which grows as they arrive.
    expect(second.runId).toBe(first.runId);
    expect(third.runId).toBe(first.runId);
    // The run counts each test once, from its final attempt: `opens an order` failed on both of its attempts.
    expect(third.totalTests).toBe(2);
    expect(third.passedTests).toBe(1);
    expect(third.failedTests).toBe(1);
    // A failing execution makes the whole run failed.
    expect(third.runStatus).toBe('failed');
    // The run spans from the earliest trace to the end of the latest.
    expect(third.startTime).toBe(new Date(1_700_000_000_000).toISOString());

    const run = await (await request.get(`/api/test-runs/${first.runId}`)).json();
    const attempts = run.testCases
      .filter((c: { title: string }) => c.title === 'opens an order')
      .sort((a: { retries: number }, b: { retries: number }) => a.retries - b.retries);

    // Two distinct traces for one test are its two attempts, not a duplicate.
    expect(attempts.map((a: { retries: number }) => a.retries)).toEqual([0, 1]);
    // Both failures reach the same cluster.
    expect(attempts[0].failureClusterId).toBeTruthy();
    expect(attempts[1].failureClusterId).toBe(attempts[0].failureClusterId);
  });

  test('a retried upload rejoins the run its siblings went to', async ({ page, request }) => {
    // Seed the project so the import page has one to open.
    const seed = await post(request, PROJECT.IMPORT_TRACE_RETRY, passing);
    const projectId = (await seed.json()).projectId;

    // Fail the second upload once, so the batch finishes with one failure the
    // user then retries — the case where a per-click grouping key would send
    // the retry to a run of its own.
    let uploads = 0;
    await page.route('**/api/test-runs/import', async (route) => {
      uploads++;
      if (uploads === 2) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"try again"}' });
        return;
      }
      await route.continue();
    });

    await page.goto(`/projects/${projectId}/import`);
    await expect(page.getByText(/Up to .* per archive/)).toBeVisible({ timeout: 30000 });

    await page.locator('input[type=file]').setInputFiles([
      { name: 'a.zip', mimeType: 'application/zip', buffer: groupA },
      { name: 'b.zip', mimeType: 'application/zip', buffer: groupB },
      { name: 'c.zip', mimeType: 'application/zip', buffer: groupC },
    ]);

    await page.getByRole('button', { name: /^Import 3 archives$/ }).click();
    await expect(page.getByText('Failed', { exact: true })).toBeVisible({ timeout: 30000 });

    // Retry just the failure.
    await page.getByRole('button', { name: /^Import 1 archive$/ }).click();
    await expect(page.getByText('Failed', { exact: true })).toBeHidden({ timeout: 30000 });

    // All three executions belong to one run, retry included. Assert the count
    // first so the read waits for the retried row to render its link.
    const runLink = page.getByRole('link', { name: /^View run #\d+$/ });
    await expect(runLink).toHaveCount(3);
    expect(new Set(await runLink.allTextContents()).size).toBe(1);
  });

  test('refuses a trace whose test cannot be identified', async ({ request }) => {
    const response = await post(request, PROJECT.IMPORT_TRACE, buildTraceArchive({ omitLibraryContext: true }));
    expect(response.status()).toBe(400);
    expect((await response.json()).message).toMatch(/no test title/i);
  });

  test('refuses an archive that is neither a report nor a trace', async ({ request }) => {
    const response = await request.post('/api/test-runs/import', {
      multipart: {
        projectName: PROJECT.IMPORT_TRACE,
        archive: {
          name: 'plain.zip',
          mimeType: 'application/zip',
          buffer: buildZip([{ name: 'notes.txt', data: Buffer.from('hello') }]),
        },
      },
    });

    expect(response.status()).toBe(400);
    expect((await response.json()).message).toMatch(/blob report.*trace/i);
  });
});

/** Hex SHA-256, matching what the server derives from the uploaded bytes. */
function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
