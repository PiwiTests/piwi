import { test, expect, type APIRequestContext } from './fixtures';
import { createHash } from 'crypto';
import { PROJECT } from '#shared/test-project-names';
import { buildZip, parseZip } from '../server/utils/trace-zip';

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Build a minimal valid Playwright-like trace ZIP, optionally with resources/. */
function buildTraceZip(resources: Array<{ name: string; data: Buffer }> = []): Buffer {
  return buildZip([
    { name: 'trace.trace', data: Buffer.from('{"type":"contextOptions","callId":"ctx@1"}\n') },
    { name: 'trace.network', data: Buffer.from('') },
    ...resources.map((r) => ({ name: `resources/${r.name}`, data: r.data })),
  ]);
}

const baseRun = {
  status: 'passed',
  startTime: new Date().toISOString(),
  duration: 5000,
  totalTests: 1,
  passedTests: 1,
  failedTests: 0,
  skippedTests: 0,
};

const baseCase = [{ title: 'test case', status: 'passed', duration: 1000, location: 'tests/t.spec.ts:1:1' }];

// Helper: upload a run and return the response
async function upload(request: APIRequestContext, projectName: string, traceZip: Buffer, testCases = baseCase) {
  return request.post('/api/test-runs/upload', {
    multipart: {
      projectName,
      testRun: JSON.stringify(baseRun),
      testCases: JSON.stringify(testCases),
      trace_0: { name: 'trace.zip', mimeType: 'application/zip', buffer: traceZip },
    },
  });
}

// Helper: get traces for the first test case of a run
async function getFirstCaseTraces(request: APIRequestContext, runId: number) {
  const runData = await (await request.get(`/api/test-runs/${runId}`)).json();
  const tc = runData.testCases?.[0];
  expect(tc).toBeDefined();
  return {
    traces: (
      (await (await request.get(`/api/test-run-cases/${tc.executionId}/traces`)).json()) as {
        items: Array<{ id: number; filePath: string }>;
      }
    ).items,
    testCase: tc,
  };
}

test.describe('Trace deduplication — preflight check', () => {
  test('returns all hashes as missing for an unknown project', async ({ request }) => {
    const hash = 'a'.repeat(64);
    const res = await request.post('/api/traces/check', {
      data: { projectName: PROJECT.TRACE_PREFLIGHT, hashes: [hash] },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.existing).toHaveLength(0);
    expect(body.missing).toContain(hash);
  });

  test('returns 400 when projectName is missing', async ({ request }) => {
    const res = await request.post('/api/traces/check', { data: { hashes: [] } });
    expect(res.status()).toBe(400);
  });

  test('returns 400 when hashes is not an array', async ({ request }) => {
    const res = await request.post('/api/traces/check', {
      data: { projectName: PROJECT.TRACE_PREFLIGHT, hashes: 'not-an-array' },
    });
    expect(res.status()).toBe(400);
  });

  test('silently filters out invalid hash formats', async ({ request }) => {
    const res = await request.post('/api/traces/check', {
      data: {
        projectName: PROJECT.TRACE_PREFLIGHT,
        hashes: ['short', 'z'.repeat(64), 'UPPERCASE-NOT-HEX' + 'a'.repeat(47)],
      },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    // 'short' is invalid; 'z'.repeat(64) has non-hex chars; third is wrong length — all filtered
    expect(body.missing).toHaveLength(0);
    expect(body.existing).toHaveLength(0);
  });

  test('reports a hash as existing after the trace is uploaded', async ({ request }) => {
    const traceZip = buildTraceZip();
    const hash = sha256(traceZip);

    const uploadRes = await upload(request, PROJECT.TRACE_PREFLIGHT, traceZip);
    expect(uploadRes.ok()).toBe(true);

    const checkRes = await request.post('/api/traces/check', {
      data: { projectName: PROJECT.TRACE_PREFLIGHT, hashes: [hash] },
    });
    expect(checkRes.ok()).toBe(true);
    const body = await checkRes.json();
    expect(body.existing).toContain(hash);
    expect(body.missing).toHaveLength(0);
  });

  test('partitions existing and missing hashes correctly', async ({ request }) => {
    const knownZip = buildTraceZip();
    const knownHash = sha256(knownZip);
    const unknownHash = 'b'.repeat(64);

    await upload(request, PROJECT.TRACE_PREFLIGHT, knownZip);

    const res = await request.post('/api/traces/check', {
      data: { projectName: PROJECT.TRACE_PREFLIGHT, hashes: [knownHash, unknownHash] },
    });
    const body = await res.json();
    expect(body.existing).toContain(knownHash);
    expect(body.missing).toContain(unknownHash);
  });
});

test.describe('Trace deduplication — upload', () => {
  test('an uploaded trace is stored as a blob under its hash, with a trace record', async ({ request }) => {
    const traceZip = buildTraceZip();
    const hash = sha256(traceZip);

    const uploadRes = await upload(request, PROJECT.TRACE_DEDUP, traceZip);
    expect(uploadRes.ok()).toBe(true);
    const { runId } = await uploadRes.json();

    const { traces } = await getFirstCaseTraces(request, runId);
    expect(traces).toHaveLength(1);
    // Content-addressed path inside the blobs directory
    expect(traces[0].filePath).toContain('/blobs/');
    expect(traces[0].filePath).toContain(hash);
  });

  test('uploading the same trace twice stores only one blob', async ({ request }) => {
    const traceZip = buildTraceZip();

    const r1 = await upload(request, PROJECT.TRACE_DEDUP, traceZip);
    const r2 = await upload(request, PROJECT.TRACE_DEDUP, traceZip);
    expect(r1.ok()).toBe(true);
    expect(r2.ok()).toBe(true);

    const { traces: t1 } = await getFirstCaseTraces(request, (await r1.json()).runId);
    const { traces: t2 } = await getFirstCaseTraces(request, (await r2.json()).runId);
    expect(t1[0].filePath).toBe(t2[0].filePath);
  });

  test('a trace that is not a ZIP is stored as uploaded, in the blob store', async ({ request }) => {
    const traceData = Buffer.from('trace data — not a valid ZIP');

    const res = await upload(request, PROJECT.TRACE_DEDUP, traceData);
    expect(res.ok()).toBe(true);
    const { runId } = await res.json();

    const { traces } = await getFirstCaseTraces(request, runId);
    expect(traces).toHaveLength(1);
    expect(traces[0].filePath).toContain(`/blobs/${sha256(traceData)}`);
    const served = await request.get(`/api/files/${traces[0].filePath}`);
    expect(Buffer.from(await served.body()).equals(traceData)).toBe(true);
  });
});

test.describe('Trace deduplication — resource extraction and reconstruction', () => {
  test('served trace ZIP contains the resources originally inside it', async ({ request }) => {
    const resourceData = Buffer.from('network response body — unique content for this test');
    const resourceName = sha256(resourceData).slice(0, 16) + '.net';
    const traceZip = buildTraceZip([{ name: resourceName, data: resourceData }]);

    const uploadRes = await upload(request, PROJECT.TRACE_RESOURCES, traceZip);
    expect(uploadRes.ok()).toBe(true);
    const { runId } = await uploadRes.json();

    const { traces } = await getFirstCaseTraces(request, runId);
    expect(traces).toHaveLength(1);

    // Fetch the trace via the file serve endpoint — it should be reconstructed with the resource
    const fileRes = await request.get(`/api/files/${traces[0].filePath}`);
    expect(fileRes.ok()).toBe(true);
    expect(fileRes.headers()['content-type']).toContain('application/zip');

    const servedZip = Buffer.from(await fileRes.body());
    const entries = await parseZip(servedZip);
    const resourceEntry = entries.find((e) => e.name === `resources/${resourceName}`);
    expect(resourceEntry).toBeDefined();
    expect(resourceEntry!.data.equals(resourceData)).toBe(true);
  });

  test('shared resource between two traces is reconstructed correctly in both', async ({ request }) => {
    const sharedData = Buffer.from('shared network trace resource');
    const sharedName = sha256(sharedData).slice(0, 16) + '.net';
    const uniqueData = Buffer.from('unique to second trace');
    const uniqueName = sha256(uniqueData).slice(0, 16) + '.net';

    const zip1 = buildTraceZip([{ name: sharedName, data: sharedData }]);
    const zip2 = buildTraceZip([
      { name: sharedName, data: sharedData },
      { name: uniqueName, data: uniqueData },
    ]);

    const r1 = await upload(request, PROJECT.TRACE_RESOURCES, zip1, [
      { title: 'run-1', status: 'passed', duration: 100, location: 'tests/a.spec.ts:1:1' },
    ]);
    const r2 = await upload(request, PROJECT.TRACE_RESOURCES, zip2, [
      { title: 'run-2', status: 'passed', duration: 100, location: 'tests/b.spec.ts:1:1' },
    ]);
    expect(r1.ok()).toBe(true);
    expect(r2.ok()).toBe(true);

    async function getResourceEntries(runId: number) {
      const { traces } = await getFirstCaseTraces(request, runId);
      const fileRes = await request.get(`/api/files/${traces[0].filePath}`);
      expect(fileRes.ok()).toBe(true);
      return await parseZip(Buffer.from(await fileRes.body()));
    }

    const entries1 = await getResourceEntries((await r1.json()).runId);
    const entries2 = await getResourceEntries((await r2.json()).runId);

    // Trace 1 must contain the shared resource
    expect(entries1.find((e) => e.name === `resources/${sharedName}`)).toBeDefined();

    // Trace 2 must contain both the shared and the unique resource
    expect(entries2.find((e) => e.name === `resources/${sharedName}`)).toBeDefined();
    expect(entries2.find((e) => e.name === `resources/${uniqueName}`)).toBeDefined();

    // Shared resource content must be identical in both
    const s1 = entries1.find((e) => e.name === `resources/${sharedName}`)!;
    const s2 = entries2.find((e) => e.name === `resources/${sharedName}`)!;
    expect(s1.data.equals(s2.data)).toBe(true);
  });

  test('served ZIP also contains the event files (trace.trace, trace.network)', async ({ request }) => {
    const traceZip = buildTraceZip([
      { name: sha256(Buffer.from('x')).slice(0, 16) + '.net', data: Buffer.from('resource') },
    ]);

    const uploadRes = await upload(request, PROJECT.TRACE_RESOURCES, traceZip);
    const { runId } = await uploadRes.json();
    const { traces } = await getFirstCaseTraces(request, runId);

    const fileRes = await request.get(`/api/files/${traces[0].filePath}`);
    const entries = await parseZip(Buffer.from(await fileRes.body()));

    expect(entries.find((e) => e.name === 'trace.trace')).toBeDefined();
    expect(entries.find((e) => e.name === 'trace.network')).toBeDefined();
  });
});
