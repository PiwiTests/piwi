import { describe, it, afterEach, expect } from 'vitest';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import {
  startServer,
  jsonRes,
  textRes,
  fakeConfig,
  fakeSuite,
  fakeTestCase,
  fakeResult,
  type FakeServer,
} from './_helpers.js';

/**
 * A `--repeat-each=3 --retries=0` run of one test, as Playwright reports it:
 * three test cases sharing a title and a line, each with its own id and
 * `repeatEachIndex`, the second failing.
 */
function repeatedRun(suite: any) {
  const tests = [0, 1, 2].map((repeatEachIndex) =>
    fakeTestCase({
      id: `pays-${repeatEachIndex}`,
      title: 'pays',
      line: 9,
      column: 5,
      parent: suite,
      repeatEachIndex,
    }),
  );
  suite.allTests = () => tests;
  const status = (repeatEachIndex: number) => (repeatEachIndex === 1 ? 'failed' : 'passed');
  return { tests, status };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('a --repeat-each run on the wire', () => {
  let server: FakeServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it('sends each repetition as its own result, and counts each', async () => {
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
      projectName: 'piwi-repeat-each-' + process.pid,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    const suite = fakeSuite();
    const { tests, status } = repeatedRun(suite);
    reporter.onBegin(fakeConfig(), suite);
    for (const test of tests) {
      reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
      reporter.onTestEnd(
        test,
        fakeResult({
          status: status(test.repeatEachIndex),
          error: test.repeatEachIndex === 1 ? new Error('boom') : null,
          workerIndex: 0,
        }),
      );
    }
    await reporter.onEnd({ status: 'failed' } as any);

    expect(submitBody.testCases.map((tc: any) => [tc.repeatEachIndex, tc.retries, tc.status])).toEqual([
      [0, 0, 'passed'],
      [1, 0, 'failed'],
      [2, 0, 'passed'],
    ]);
    // Each repetition's attempts are its own.
    expect(submitBody.testCases.map((tc: any) => tc.attempts.length)).toEqual([1, 1, 1]);
    expect(submitBody).toMatchObject({ totalTests: 3, passedTests: 2, failedTests: 1 });
  });

  it('streams the repetition with each begin and complete event', async () => {
    const events: Array<Record<string, any>> = [];
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        events.push(...(JSON.parse(req.body).testCases ?? []));
        jsonRes(res, 200, {});
      } else if (req.url === '/api/auth/me') {
        jsonRes(res, 200, {});
      } else {
        textRes(res, 404, 'nope');
      }
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName: 'piwi-repeat-each-stream-' + process.pid,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 30,
      streamingBatchSize: 1,
    });
    const suite = fakeSuite();
    const { tests, status } = repeatedRun(suite);
    reporter.onBegin(fakeConfig(), suite);
    for (const test of tests) {
      reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
      reporter.onTestEnd(test, fakeResult({ status: status(test.repeatEachIndex), workerIndex: 0 }));
    }
    await waitFor(() => events.filter((e) => e.type === 'complete').length === 3);

    expect(events.filter((e) => e.type === 'begin').map((e) => e.repeatEachIndex)).toEqual([0, 1, 2]);
    expect(events.filter((e) => e.type === 'complete').map((e) => [e.repeatEachIndex, e.status])).toEqual([
      [0, 'passed'],
      [1, 'failed'],
      [2, 'passed'],
    ]);
  });

  it('says with each begin which attempt it is, of how many, and the test’s tags and owner', async () => {
    const events: Array<Record<string, any>> = [];
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        events.push(...(JSON.parse(req.body).testCases ?? []));
        jsonRes(res, 200, {});
      } else if (req.url === '/api/auth/me') {
        jsonRes(res, 200, {});
      } else {
        textRes(res, 404, 'nope');
      }
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName: 'piwi-retry-begin-stream-' + process.pid,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 30,
      streamingBatchSize: 1,
    });
    const suite = fakeSuite();
    const test = {
      ...fakeTestCase({
        title: 'pays by card',
        parent: suite,
        annotations: [{ type: 'piwi:owner', description: 'checkout' }],
      }),
      tags: ['@smoke'],
      retries: 2,
    };
    reporter.onBegin(fakeConfig(), suite);
    reporter.onTestBegin(test, fakeResult({ workerIndex: 0, retry: 0 }));
    reporter.onTestEnd(test, fakeResult({ status: 'failed', workerIndex: 0, retry: 0 }));
    reporter.onTestBegin(test, fakeResult({ workerIndex: 1, retry: 1 }));
    await waitFor(() => events.filter((e) => e.type === 'begin').length === 2);

    const begins = events.filter((e) => e.type === 'begin');
    expect(begins.map((e) => [e.retries, e.maxRetries])).toEqual([
      [0, 2],
      [1, 2],
    ]);
    expect(begins[1]).toMatchObject({ tags: ['smoke'], testMeta: { owner: 'checkout' } });
  });

  it("names the worker's lane with each begin and complete, the same after Playwright starts the worker again", async () => {
    const events: Array<Record<string, any>> = [];
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        events.push(...(JSON.parse(req.body).testCases ?? []));
        jsonRes(res, 200, {});
      } else if (req.url === '/api/auth/me') {
        jsonRes(res, 200, {});
      } else {
        textRes(res, 404, 'nope');
      }
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName: 'piwi-lane-stream-' + process.pid,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 30,
      streamingBatchSize: 1,
    });
    const suite = fakeSuite();
    const test = { ...fakeTestCase({ title: 'pays by card', parent: suite }), retries: 1 };
    reporter.onBegin(fakeConfig(), suite);
    reporter.onTestBegin(test, fakeResult({ workerIndex: 1, parallelIndex: 1, retry: 0 }));
    reporter.onTestEnd(test, fakeResult({ status: 'failed', workerIndex: 1, parallelIndex: 1, retry: 0 }));
    reporter.onTestBegin(test, fakeResult({ workerIndex: 4, parallelIndex: 1, retry: 1 }));
    reporter.onTestEnd(test, fakeResult({ status: 'passed', workerIndex: 4, parallelIndex: 1, retry: 1 }));
    await waitFor(() => events.filter((e) => e.type === 'complete').length === 2);

    const lanes = (type: string) => events.filter((e) => e.type === type).map((e) => [e.workerIndex, e.parallelIndex]);
    expect(lanes('begin')).toEqual([
      [1, 1],
      [4, 1],
    ]);
    expect(lanes('complete')).toEqual([
      [1, 1],
      [4, 1],
    ]);
  });

  it('sends no lane for a result that carries none, in the batch body', async () => {
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
      projectName: 'piwi-lane-batch-' + process.pid,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    const suite = fakeSuite();
    const tests = ['pays', 'refunds'].map((title, i) => fakeTestCase({ id: title, title, line: i + 1, parent: suite }));
    suite.allTests = () => tests;
    reporter.onBegin(fakeConfig(), suite);
    reporter.onTestEnd(tests[0], fakeResult({ workerIndex: 2, parallelIndex: 0 }));
    reporter.onTestEnd(tests[1], fakeResult({ workerIndex: 3 }));
    await reporter.onEnd({ status: 'passed' } as any);

    expect(submitBody.testCases.map((tc: any) => [tc.title, tc.workerIndex, tc.parallelIndex])).toEqual([
      ['pays', 2, 0],
      ['refunds', 3, null],
    ]);
  });
});
