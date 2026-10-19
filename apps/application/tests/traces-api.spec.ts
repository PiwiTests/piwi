import { test, expect } from './fixtures';
import { createHash } from 'crypto';
import { PROJECT } from '#shared/test-project-names';

test.describe('Traces API', () => {
  test.describe.configure({ mode: 'serial' });
  let testRunsCaseId: number;
  let noTraceCaseId: number;

  test('should store traces via multipart upload and retrieve them', async ({ request }) => {
    // Upload a run with a trace file attached to the first test case
    const traceContent = Buffer.from('Mock Playwright trace data');
    const uploadResponse = await request.post('/api/test-runs/upload', {
      multipart: {
        projectName: PROJECT.TRACES_API,
        testRun: JSON.stringify({
          status: 'passed',
          startTime: new Date().toISOString(),
          duration: 20000,
          totalTests: 2,
          passedTests: 2,
          failedTests: 0,
          skippedTests: 0,
        }),
        testCases: JSON.stringify([
          {
            title: 'test with trace',
            status: 'passed',
            duration: 1200,
            location: 'tests/trace-test.spec.ts:5:3',
          },
          {
            title: 'test without trace',
            status: 'passed',
            duration: 800,
            location: 'tests/trace-test.spec.ts:15:3',
          },
        ]),
        trace_0: {
          name: 'trace.zip',
          mimeType: 'application/zip',
          buffer: traceContent,
        },
      },
    });

    expect(uploadResponse.ok()).toBeTruthy();
    const uploadData = await uploadResponse.json();
    expect(uploadData.runId).toBeDefined();

    // Get the test run to find the testRunsCase IDs
    const runResponse = await request.get(`/api/test-runs/${uploadData.runId}`);
    expect(runResponse.ok()).toBeTruthy();
    const runData = await runResponse.json();

    const testCaseWithTrace = runData.testCases.find((tc: { title: string }) => tc.title === 'test with trace');
    expect(testCaseWithTrace).toBeDefined();
    testRunsCaseId = testCaseWithTrace.executionId;

    const testCaseWithoutTrace = runData.testCases.find((tc: { title: string }) => tc.title === 'test without trace');
    expect(testCaseWithoutTrace).toBeDefined();
    noTraceCaseId = testCaseWithoutTrace.executionId;

    // Fetch traces for the test case that had a trace file
    const tracesResponse = await request.get(`/api/test-run-cases/${testRunsCaseId}/traces`);
    expect(tracesResponse.ok()).toBeTruthy();
    const { items: traces } = await tracesResponse.json();

    expect(Array.isArray(traces)).toBe(true);
    expect(traces.length).toBe(1);
    expect(traces[0].id).toBeDefined();
    expect(traces[0].filePath).toBeDefined();
    const hash = createHash('sha256').update(traceContent).digest('hex');
    expect(traces[0].filePath).toMatch(new RegExp(`/blobs/${hash}\\.zip$`));
    expect(traces[0].createdAt).toBeDefined();
  });

  test('should return empty traces for a test case without trace files', async ({ request }) => {
    expect(noTraceCaseId).toBeDefined();

    const tracesResponse = await request.get(`/api/test-run-cases/${noTraceCaseId}/traces`);
    expect(tracesResponse.ok()).toBeTruthy();
    const { items: traces } = await tracesResponse.json();

    expect(Array.isArray(traces)).toBe(true);
    expect(traces.length).toBe(0);
  });

  test('should return 400 for invalid test case ID', async ({ request }) => {
    const response = await request.get('/api/test-run-cases/abc/traces');
    expect(response.status()).toBe(400);
  });

  test('should return 404 for non-existent test case', async ({ request }) => {
    const response = await request.get('/api/test-run-cases/99999/traces');
    expect(response.status()).toBe(404);
  });
});
