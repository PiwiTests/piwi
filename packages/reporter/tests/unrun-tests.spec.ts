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

  it('sends a test declared skipped as skipped when the run stopped before it', async () => {
    const suite = fakeSuite();
    const pays = fakeTestCase({ id: 'pays', title: 'pays', line: 1, parent: suite });
    // `test.skip('refunds', …)`: Playwright reports it as skipped once the run reaches it.
    const refunds = fakeTestCase({
      id: 'refunds',
      title: 'refunds',
      line: 2,
      parent: suite,
      expectedStatus: 'skipped',
      annotations: [{ type: 'skip' }],
    });
    const ships = fakeTestCase({ id: 'ships', title: 'ships', line: 3, parent: suite });
    const body = await submitted([pays, refunds, ships], [{ test: pays, status: 'failed' }], 'failed', { maxFailures: 1 });
    expect(sentCase(body, 'refunds')).toMatchObject({ status: 'skipped', didNotRunReason: null });
    expect(sentCase(body, 'ships')).toMatchObject({ status: 'didnotrun', didNotRunReason: 'max-failures' });
    expect(body).toMatchObject({ totalTests: 3, failedTests: 1, skippedTests: 1, didNotRunTests: 1 });
  });

  it('links the tests of a project whose dependency failed to that failure', async () => {
    const inProject = (name: string) => {
      const suite = fakeSuite();
      suite.project = () => ({ name, use: {} });
      return suite;
    };
    const login = fakeTestCase({ id: 'login', title: 'logs in', file: '/repo/auth.setup.ts', line: 3, parent: inProject('setup') });
    const cart = fakeTestCase({ id: 'cart', title: 'adds to cart', file: '/repo/cart.spec.ts', line: 5, parent: inProject('app') });
    const report = fakeTestCase({ id: 'report', title: 'reports', file: '/repo/report.spec.ts', line: 7, parent: inProject('reports') });
    const other = fakeTestCase({ id: 'other', title: 'other', file: '/repo/other.spec.ts', line: 9, parent: inProject('other') });
    const projects = [
      { name: 'setup', dependencies: [] },
      { name: 'app', dependencies: ['setup'] },
      { name: 'reports', dependencies: ['app'] },
      { name: 'other', dependencies: [] },
    ];
    // Playwright's authentication setup (`dependencies: ['setup']`): the login fails, and Playwright reports no test
    // of a project that depends on its project, directly or through another.
    const body = await submitted([login, cart, report, other], [{ test: login, status: 'failed' }], 'failed', {
      projects,
      configFile: '/repo/playwright.config.ts',
    });
    expect(body.testCases.find((tc: any) => tc.title === 'logs in').location).toBe('auth.setup.ts:3:1');
    for (const title of ['adds to cart', 'reports']) {
      expect(sentCase(body, title)).toMatchObject({
        status: 'didnotrun',
        didNotRunReason: 'dependency-failure',
        blockedBy: 'auth.setup.ts:3:1',
      });
    }
    // A test of a project that depends on no failed project keeps the run's reason.
    expect(sentCase(body, 'other')).toMatchObject({ status: 'didnotrun', didNotRunReason: 'interrupted', blockedBy: null });
  });
});
