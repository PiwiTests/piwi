import { describe, it, afterEach, expect } from 'vitest';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { startServer, jsonRes, textRes, fakeConfig, fakeSuite, fakeTestCase, fakeResult, type FakeServer } from './_helpers.js';

/** One attempt of a test, as `onTestEnd` reports it. */
type Attempt = { test: any; status: string; retry?: number };

describe('the tests a run never reached, on the wire', () => {
  let server: FakeServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  /** The run body the reporter submits for `planned` tests, of which `attempts` ended, under `config`. */
  async function submitted(
    planned: any[],
    attempts: Attempt[],
    runStatus: string,
    config: Record<string, unknown> = {},
  ): Promise<any> {
    let body: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        body = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 1, projectId: 1 });
      } else {
        textRes(res, 404, 'nope');
      }
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName: 'piwi-unrun-tests-' + process.pid,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      captureResources: false,
    });
    const root = fakeSuite();
    root.allTests = () => planned;
    reporter.onBegin({ ...fakeConfig(), ...config }, root);
    for (const { test, status, retry = 0 } of attempts) {
      reporter.onTestBegin(test, fakeResult({ retry }));
      reporter.onTestEnd(test, fakeResult({ status, retry, error: status === 'failed' ? new Error('no') : null }));
    }
    await reporter.onEnd({ status: runStatus } as any);
    return body;
  }

  const sentCase = (body: any, title: string) => body.testCases.find((tc: any) => tc.title === title && tc.duration === 0);

  it('counts failed tests, not failed attempts, against maxFailures', async () => {
    const suite = fakeSuite();
    const flaky = (title: string, line: number) => ({
      ...fakeTestCase({ id: title, title, line, parent: suite }),
      retries: 2,
    });
    const tests = [flaky('pays', 1), flaky('refunds', 2), fakeTestCase({ id: 'ships', title: 'ships', line: 3, parent: suite })];
    // Two tests failed on all three of their attempts: six failed attempts, two failed tests.
    const attempts: Attempt[] = [0, 1, 2].flatMap((retry) => [
      { test: tests[0], status: 'failed', retry },
      { test: tests[1], status: 'failed', retry },
    ]);

    // Stopped with Ctrl-C before the failure budget of five tests was reached.
    const interrupted = await submitted(tests, attempts, 'interrupted', { maxFailures: 5 });
    expect(sentCase(interrupted, 'ships')).toMatchObject({ status: 'didnotrun', didNotRunReason: 'interrupted' });

    const stopped = await submitted(tests, attempts, 'failed', { maxFailures: 2 });
    expect(sentCase(stopped, 'ships')).toMatchObject({ status: 'didnotrun', didNotRunReason: 'max-failures' });
  });
});
