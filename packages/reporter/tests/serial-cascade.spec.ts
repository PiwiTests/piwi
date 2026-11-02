import { describe, it, expect } from 'vitest';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { startServer, jsonRes, textRes, fakeConfig, fakeSuite, fakeTestCase, fakeResult } from './_helpers.js';

describe('a describe.serial cascade on the wire', () => {
  it('links each test that did not run to the failure that stopped its group', async () => {
    let submitBody: any;
    const server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 1, projectId: 1 });
      } else {
        textRes(res, 404, 'nope');
      }
    });
    try {
      const reporter = new PiwiDashboardReporter({
        serverUrl: server.url,
        projectName: 'piwi-serial-cascade-' + process.pid,
        streaming: false,
        uploadReport: false,
        uploadTraces: false,
        liveFileUploads: false,
      });
      const root = fakeSuite();
      const group = { ...fakeSuite(), title: 'checkout', parent: root, _parallelMode: 'serial' };
      const titles = ['adds to cart', 'pays', 'confirms', 'emails the receipt'];
      const tests = titles.map((title, i) => fakeTestCase({ id: `t${i}`, title, line: 10 + i, parent: group }));
      root.allTests = () => tests;
      // As Playwright reports a serial group whose second test failed: the rest are skipped, with no skip annotation.
      const results = [
        fakeResult({ status: 'passed' }),
        fakeResult({ status: 'failed', error: new Error('payment declined') }),
        fakeResult({ status: 'skipped' }),
        fakeResult({ status: 'skipped' }),
      ];

      reporter.onBegin(fakeConfig(), root);
      tests.forEach((test, i) => {
        reporter.onTestBegin(test, fakeResult({}));
        reporter.onTestEnd(test, results[i]);
      });
      await reporter.onEnd({ status: 'failed' } as any);

      const byTitle = new Map<string, any>(submitBody.testCases.map((tc: any) => [tc.title, tc]));
      const pays = byTitle.get('pays');
      for (const title of ['confirms', 'emails the receipt']) {
        expect(byTitle.get(title)).toMatchObject({
          status: 'didnotrun',
          didNotRunReason: 'previous-failure',
          blockedBy: pays.location,
        });
      }
      expect(byTitle.get('adds to cart').blockedBy ?? null).toBeNull();
    } finally {
      await server.close();
    }
  });
});
