import { test, expect, type APIRequestContext } from './fixtures';
import { createHash } from 'crypto';
import { PROJECT } from '#shared/test-project-names';
import { buildZip } from '../server/utils/trace-zip';

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

const SPEC_ABS = '/home/ci/repo/tests/insight.spec.ts';
const HELPER_ABS = '/home/ci/repo/helpers/actions.ts';
const BODY_SHA1 = 'd'.repeat(40) + '.json';
const JWT_SHAPED = 'eyJabcdefghij.abcde.abcde';

const HELPER_SOURCE = Array.from({ length: 10 }, (_, i) => `helper line ${i + 1}`).join('\n');
const SPEC_SOURCE = Array.from({ length: 15 }, (_, i) => `spec line ${i + 1}`).join('\n');

/** A modern-format trace: before/after events, a stacks index, HAR-like network entries and embedded sources. */
function buildInsightTraceZip(): Buffer {
  const jsonl = (events: unknown[]) => Buffer.from(events.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
  return buildZip([
    {
      name: 'trace.trace',
      data: jsonl([
        {
          type: 'before',
          callId: 'call@1',
          startTime: 1000,
          class: 'Frame',
          method: 'goto',
          params: { url: 'https://shop.test/checkout' },
        },
        { type: 'after', callId: 'call@1', endTime: 1200 },
        {
          type: 'before',
          callId: 'call@2',
          startTime: 2000,
          class: 'Frame',
          method: 'click',
          params: { selector: '#pay' },
        },
        {
          type: 'after',
          callId: 'call@2',
          endTime: 2500,
          error: { message: 'Timeout 1500ms exceeded.', name: 'TimeoutError' },
        },
      ]),
    },
    {
      name: 'trace.network',
      data: jsonl([
        {
          type: 'resource-snapshot',
          snapshot: {
            startedDateTime: '2026-07-11T15:50:59.282Z',
            time: 50,
            request: { method: 'GET', url: 'https://shop.test/checkout', headers: [], bodySize: 0 },
            response: { status: 200, statusText: 'OK', headers: [], content: { size: 1640, mimeType: 'text/html' } },
            timings: { dns: -1, connect: -1, ssl: -1, send: 0, wait: 30, receive: 20 },
            _monotonicTime: 900,
          },
        },
        {
          type: 'resource-snapshot',
          snapshot: {
            startedDateTime: '2026-07-11T15:51:00.100Z',
            time: 300,
            request: {
              method: 'POST',
              url: 'https://shop.test/api/payments',
              headers: [{ name: 'Authorization', value: 'Bearer super-secret-value' }],
              bodySize: 12,
              postData: { mimeType: 'application/json', text: `{"card":"4242","token":"${JWT_SHAPED}"}` },
            },
            response: {
              status: 500,
              statusText: 'Server Error',
              headers: [{ name: 'content-type', value: 'application/json' }],
              content: { size: 60, mimeType: 'application/json', _sha1: BODY_SHA1 },
            },
            timings: { dns: -1, connect: -1, ssl: -1, send: 1, wait: 250, receive: 49 },
            _monotonicTime: 2100,
          },
        },
      ]),
    },
    {
      name: 'trace.stacks',
      data: Buffer.from(
        JSON.stringify({
          files: [HELPER_ABS, SPEC_ABS],
          stacks: [
            [1, [[1, 3, 1, 'checkout works']]],
            [
              2,
              [
                [0, 5, 3, 'clickPay'],
                [1, 9, 7, 'checkout works'],
              ],
            ],
          ],
        }),
        'utf8',
      ),
    },
    { name: `resources/src@${sha1(HELPER_ABS)}.txt`, data: Buffer.from(HELPER_SOURCE, 'utf8') },
    { name: `resources/src@${sha1(SPEC_ABS)}.txt`, data: Buffer.from(SPEC_SOURCE, 'utf8') },
    { name: `resources/${BODY_SHA1}`, data: Buffer.from(`{"error":"internal","token":"${JWT_SHAPED}"}`, 'utf8') },
  ]);
}

const baseRun = {
  status: 'failed',
  startTime: new Date().toISOString(),
  duration: 5000,
  totalTests: 1,
  passedTests: 0,
  failedTests: 1,
  skippedTests: 0,
};

async function uploadRun(request: APIRequestContext, traceZip: Buffer | null) {
  const multipart: Record<string, unknown> = {
    projectName: PROJECT.TRACE_INSIGHTS,
    testRun: JSON.stringify(baseRun),
    testCases: JSON.stringify([
      { title: 'checkout works', status: 'failed', duration: 2500, location: 'tests/insight.spec.ts:9:7' },
    ]),
  };
  if (traceZip) {
    multipart.trace_0 = { name: 'trace.zip', mimeType: 'application/zip', buffer: traceZip };
  }
  const res = await request.post('/api/test-runs/upload', { multipart });
  expect(res.ok()).toBe(true);
  const { runId } = await res.json();
  const runData = await (await request.get(`/api/test-runs/${runId}`)).json();
  const caseId = runData.testCases?.[0]?.executionId;
  expect(caseId).toBeDefined();
  return { runId, caseId };
}

test.describe('Trace insights — call stack with source', () => {
  test('returns the full stack with embedded source, project-relative paths and the failing action', async ({
    request,
  }) => {
    const { caseId } = await uploadRun(request, buildInsightTraceZip());

    const res = await request.get(`/api/test-run-cases/${caseId}/trace-stacks`);
    expect(res.ok()).toBe(true);
    const body = await res.json();

    expect(body.status).toBe('ok');
    expect(body.apiName).toBe('Frame.click');
    expect(body.errorMessage).toContain('Timeout 1500ms exceeded.');
    expect(body.hasSources).toBe(true);
    expect(body.frames).toHaveLength(2);

    const [helper, spec] = body.frames;
    expect(helper).toMatchObject({ file: 'helpers/actions.ts', line: 5, functionName: 'clickPay', inProject: true });
    expect(helper.source.lines).toContain('helper line 5');
    expect(spec).toMatchObject({ file: 'tests/insight.spec.ts', line: 9, inProject: true });
    expect(spec.source.startLine).toBeLessThanOrEqual(9);
  });

  test('reports no-trace for a case uploaded without a trace', async ({ request }) => {
    const { caseId } = await uploadRun(request, null);

    const stacksRes = await (await request.get(`/api/test-run-cases/${caseId}/trace-stacks`)).json();
    expect(stacksRes.status).toBe('no-trace');
    const networkRes = await (await request.get(`/api/test-run-cases/${caseId}/trace-network`)).json();
    expect(networkRes.status).toBe('no-trace');
  });
});

test.describe('Trace insights — full network trace', () => {
  test('lists every request with masked headers and failing-window correlation', async ({ request }) => {
    const { caseId } = await uploadRun(request, buildInsightTraceZip());

    const res = await request.get(`/api/test-run-cases/${caseId}/trace-network`);
    expect(res.ok()).toBe(true);
    const body = await res.json();

    expect(body.status).toBe('ok');
    expect(body.requests).toHaveLength(2);

    const doc = body.requests[0];
    expect(doc).toMatchObject({ method: 'GET', status: 200, failed: false, duringFailure: false, start: 0 });

    const payment = body.requests[1];
    expect(payment).toMatchObject({
      method: 'POST',
      url: 'https://shop.test/api/payments',
      status: 500,
      failed: true,
      duringFailure: true,
      bodySha1: BODY_SHA1,
      bodyPreviewable: true,
    });
    // The Authorization value must never leave the server; the post data's JWT is masked.
    expect(payment.requestHeaders).toContainEqual({ name: 'Authorization', value: '[masked]' });
    expect(JSON.stringify(body)).not.toContain('super-secret-value');
    expect(payment.requestPostData).toContain('[masked-token]');

    expect(body.failingWindow).toMatchObject({ start: 100 });
  });

  test('serves a masked JSON body preview by hash, with or without the extension', async ({ request }) => {
    const { caseId } = await uploadRun(request, buildInsightTraceZip());
    const base = `/api/test-run-cases/${caseId}/trace-network-body`;

    for (const ref of [BODY_SHA1, BODY_SHA1.replace(/\.json$/, '')]) {
      const res = await request.get(`${base}?sha1=${ref}`);
      expect(res.ok()).toBe(true);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.kind).toBe('json');
      expect(body.content).toContain('"error": "internal"');
      expect(body.content).toContain('[masked-token]');
      expect(body.content).not.toContain(JWT_SHAPED);
    }
  });

  test('rejects malformed hashes and unknown ones the trace never referenced', async ({ request }) => {
    const { caseId } = await uploadRun(request, buildInsightTraceZip());
    const base = `/api/test-run-cases/${caseId}/trace-network-body`;

    expect((await request.get(`${base}?sha1=../../../etc/passwd`)).status()).toBe(400);
    expect((await request.get(`${base}?sha1=zz`)).status()).toBe(400);

    const unknown = await (await request.get(`${base}?sha1=${'e'.repeat(40)}`)).json();
    expect(unknown.status).toBe('not-found');
  });
});
