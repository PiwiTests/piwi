/**
 * Offline export of an execution and of a failure cluster.
 *
 * The point of the feature is that the file keeps working once it leaves the
 * dashboard, so these assert the two things that would silently break that: the
 * HTML must reference nothing it does not carry, and the ZIP must actually hold
 * the evidence its report points at.
 */

import { test, expect, type APIRequestContext } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { parseZipSync } from './utils/zip';

const ERROR_TEXT =
  "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('checkout-pay')";

async function submitFailingRun(request: APIRequestContext): Promise<number> {
  const res = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.EXPORT_OFFLINE,
      status: 'failed',
      startTime: new Date().toISOString(),
      duration: 4000,
      totalTests: 2,
      passedTests: 0,
      failedTests: 2,
      skippedTests: 0,
      testCases: [
        {
          title: 'checkout shows the total',
          status: 'failed',
          error: ERROR_TEXT,
          duration: 2000,
          location: 'tests/checkout.spec.ts:12:5',
          consoleLogs: [{ type: 'error', text: 'Uncaught TypeError: total is undefined', timestamp: Date.now() }],
          ariaSnapshot: '- button "Pay now"',
          testSource: "await page.getByTestId('checkout-pay').click();",
        },
        {
          title: 'cart badge updates',
          status: 'failed',
          error: ERROR_TEXT,
          duration: 2000,
          location: 'tests/cart.spec.ts:8:3',
        },
      ],
    },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).runId ?? (await res.json()).id;
}

async function firstExecutionAndCluster(request: APIRequestContext) {
  const runRes = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.EXPORT_OFFLINE,
      status: 'failed',
      startTime: new Date().toISOString(),
      duration: 4000,
      totalTests: 1,
      passedTests: 0,
      failedTests: 1,
      skippedTests: 0,
      testCases: [
        {
          title: 'checkout shows the total',
          status: 'failed',
          error: ERROR_TEXT,
          duration: 2000,
          location: 'tests/checkout.spec.ts:12:5',
        },
      ],
    },
  });
  expect(runRes.ok()).toBeTruthy();
  const runId = (await runRes.json()).runId;

  const detail = await (await request.get(`/api/test-runs/${runId}`)).json();
  const execution = detail.testCases?.[0];
  expect(execution, 'the submitted run should have an execution').toBeTruthy();

  const caseDetail = await (await request.get(`/api/test-run-cases/${execution.executionId}`)).json();
  return {
    executionId: execution.executionId as number,
    clusterId: caseDetail.failureCluster?.id as number | undefined,
  };
}

test.describe('offline export', () => {
  test.beforeEach(async ({ request }) => {
    await submitFailingRun(request);
  });

  test('exports one execution as a self-contained HTML file', async ({ request }) => {
    const { executionId } = await firstExecutionAndCluster(request);

    const res = await request.get(`/api/test-run-cases/${executionId}/export?format=html`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    expect(res.headers()['content-disposition']).toContain('attachment');
    expect(res.headers()['content-disposition']).toContain(`piwi-execution-${executionId}`);

    const html = await res.text();
    expect(html).toContain('checkout shows the total');
    expect(html).toContain('Timeout 30000ms exceeded');
    // Nothing may be fetched from the network for the file to render.
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
  });

  test('exports one execution as a real PDF file', async ({ request }) => {
    const { executionId } = await firstExecutionAndCluster(request);

    const res = await request.get(`/api/test-run-cases/${executionId}/export?format=pdf`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/pdf');
    expect(res.headers()['content-disposition']).toContain('attachment');
    expect(res.headers()['content-disposition']).toContain(`piwi-execution-${executionId}`);

    // A real PDF, not an HTML page a browser has to print — check the signature.
    const body = Buffer.from(await res.body());
    expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('exports an execution as a ZIP whose report points at real files', async ({ request }) => {
    const { executionId } = await firstExecutionAndCluster(request);

    const res = await request.get(`/api/test-run-cases/${executionId}/export?format=zip`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/zip');

    const entries = parseZipSync(Buffer.from(await res.body()));
    const names = entries.map((e) => e.name);
    expect(names).toContain('report.html');
    expect(names).toContain('data.json');
    expect(names).toContain('README.txt');

    const report = entries.find((e) => e.name === 'report.html')!.data.toString('utf8');
    expect(report).not.toContain('data:image/');

    // Every evidence path the report links to must exist in the archive.
    for (const match of report.matchAll(/(?:src|href)="(evidence\/[^"]+)"/g)) {
      expect(names).toContain(match[1]);
    }

    const data = JSON.parse(entries.find((e) => e.name === 'data.json')!.data.toString('utf8'));
    expect(data.kind).toBe('execution');
    expect(data.cases[0].title).toBe('checkout shows the total');
  });

  test('exports a cluster with every affected test', async ({ request }) => {
    const { clusterId } = await firstExecutionAndCluster(request);
    test.skip(!clusterId, 'the submitted failures did not cluster');

    const res = await request.get(`/api/failure-clusters/${clusterId}/export?format=zip`);
    expect(res.status()).toBe(200);

    const entries = parseZipSync(Buffer.from(await res.body()));
    const data = JSON.parse(entries.find((e) => e.name === 'data.json')!.data.toString('utf8'));
    expect(data.kind).toBe('cluster');
    expect(data.cluster.signature).toBeTruthy();
    expect(data.cases.length).toBeGreaterThan(0);

    const report = entries.find((e) => e.name === 'report.html')!.data.toString('utf8');
    for (const exportCase of data.cases) expect(report).toContain(exportCase.title);
  });

  test('exports text formats without touching evidence', async ({ request }) => {
    const { executionId } = await firstExecutionAndCluster(request);

    const md = await request.get(`/api/test-run-cases/${executionId}/export?format=md`);
    expect(md.headers()['content-type']).toContain('text/markdown');
    expect(await md.text()).toContain('# checkout shows the total');

    const json = await request.get(`/api/test-run-cases/${executionId}/export?format=json`);
    expect(json.headers()['content-type']).toContain('application/json');
    expect((await json.json()).kind).toBe('execution');
  });

  test('rejects an unknown format and a missing entity', async ({ request }) => {
    const { executionId } = await firstExecutionAndCluster(request);

    const bad = await request.get(`/api/test-run-cases/${executionId}/export?format=docx`);
    expect(bad.status()).toBe(400);
    expect(await bad.text()).toContain('Unsupported export format');

    const missing = await request.get('/api/test-run-cases/99999999/export?format=json');
    expect(missing.status()).toBe(404);
  });
});
