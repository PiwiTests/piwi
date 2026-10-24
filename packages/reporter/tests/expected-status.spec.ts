import { describe, it, afterEach, expect } from 'vitest';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { startServer, jsonRes, textRes, fakeConfig, fakeSuite, fakeTestCase, fakeResult, type FakeServer } from './_helpers.js';

describe('expectedStatus on the wire', () => {
  let server: FakeServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  async function submitOne(test: { annotations: any[]; expectedStatus: string }, status: string): Promise<any> {
    let submitBody: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 1, projectId: 1 });
      } else {
        textRes(res, 404, 'nope');
      }
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName: 'piwi-expected-status-' + process.pid,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    const suite = fakeSuite();
    const testCase = fakeTestCase({ title: 'bug: coupon', parent: suite, ...test });
    suite.allTests = () => [testCase];
    reporter.onBegin(fakeConfig(), suite);
    reporter.onTestBegin(testCase, fakeResult({ workerIndex: 0 }));
    reporter.onTestEnd(testCase, fakeResult({ status, duration: 5, workerIndex: 0 }));
    await reporter.onEnd({ status: 'passed' } as any);
    return submitBody.testCases[0];
  }

  it('sends Playwright’s expected status with an expected failure that passed', async () => {
    const sent = await submitOne({ annotations: [{ type: 'fail' }], expectedStatus: 'failed' }, 'passed');
    expect(sent.status).toBe('failed');
    expect(sent.expectedStatus).toBe('failed');
    expect(sent.error).toBe('Expected to fail, but passed.');
  });

  it('sends it with an expected failure that failed, stored as passed', async () => {
    const sent = await submitOne({ annotations: [{ type: 'fail' }], expectedStatus: 'failed' }, 'failed');
    expect(sent.status).toBe('passed');
    expect(sent.expectedStatus).toBe('failed');
  });

  it('sends passed for an ordinary test', async () => {
    const sent = await submitOne({ annotations: [], expectedStatus: 'passed' }, 'passed');
    expect(sent.expectedStatus).toBe('passed');
  });
});
