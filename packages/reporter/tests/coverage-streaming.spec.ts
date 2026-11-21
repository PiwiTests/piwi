import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { ATTACHMENT_NAMES } from '../src/internal/capture/attachments.js';
import {
  fakeConfig,
  fakeResult,
  fakeSuite,
  fakeTestCase,
  jsonRes,
  startServerOnTestPort,
  textRes,
  type FakeServer,
} from './_helpers.js';

/** The result event of a test, once streamed. */
const resultOf = (events: Array<Record<string, unknown>>, title: string) =>
  events.find((event) => event.type === 'complete' && event.title === title);

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const COVERAGE_ENV = ['PIWI_COVERAGE_BROWSER', 'PIWI_COVERAGE_SERVER', 'PIWI_CAPTURE_CODE_REACH'];

describe('server coverage in the reporter', () => {
  let servers: FakeServer[] = [];
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = Object.fromEntries(COVERAGE_ENV.map((key) => [key, process.env[key]]));
    for (const key of COVERAGE_ENV) delete process.env[key];
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers = [];
    for (const key of COVERAGE_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.restoreAllMocks();
  });

  /** A dashboard recording the streamed events, the finish call, the batch submit and the run coverage. */
  async function dashboard() {
    const events: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const runCoverage: unknown[] = [];
    const submitted: Array<Record<string, unknown>> = [];
    const server = await startServerOnTestPort((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      if (req.url === '/api/test-runs/start') jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      else if (req.url === '/api/test-runs/1/events') {
        events.push(...(JSON.parse(req.body) as { testCases: Array<Record<string, unknown>> }).testCases);
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/1/finish') jsonRes(res, 200, {});
      else if (req.url === '/api/test-runs/submit') {
        submitted.push(...(JSON.parse(req.body) as { testCases: Array<Record<string, unknown>> }).testCases);
        jsonRes(res, 200, { runId: 2, projectId: 1 });
      } else if (req.method === 'PUT' && /^\/api\/test-runs\/\d+\/coverage$/.test(req.url)) {
        runCoverage.push(JSON.parse(req.body));
        jsonRes(res, 200, { files: 1 });
      } else textRes(res, 404, 'nope');
    });
    servers.push(server);
    return { server, events, calls, runCoverage, submitted };
  }

  /** A backend whose collection answers wait for `gate`. */
  async function backend(gate: Promise<void>) {
    const server = await startServerOnTestPort((req, res) => {
      if (req.method === 'POST' && req.url === '/__piwi/coverage/collect') {
        const body = JSON.parse(req.body) as {
          granularity: string;
          groups: Array<{ key: string; requests: string[] }>;
        };
        void gate.then(() =>
          jsonRes(res, 200, {
            v: 1,
            groups: body.groups.map((group) => ({
              key: group.key,
              files: [{ path: 'src/Web/Basket.cs', runtime: 'server', functions: [[3, 9]], lines: [[4, 5]] }],
              missing: [],
            })),
          }),
        );
      } else if (req.method === 'GET' && req.url === '/__piwi/coverage/run?granularity=functions') {
        jsonRes(res, 200, {
          v: 1,
          files: [{ path: 'src/Web/Basket.cs', runtime: 'server', functions: [[3, 9]], executable: [[4, 20]] }],
        });
      } else textRes(res, 404, 'nope');
    });
    servers.push(server);
    return server;
  }

  function reporterFor(dashboardUrl: string, streaming: boolean): PiwiDashboardReporter {
    return new PiwiDashboardReporter({
      serverUrl: dashboardUrl,
      projectName: `piwi-coverage-${streaming ? 'stream' : 'batch'}-${process.pid}`,
      streaming,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      captureResources: false,
      collectScmInfo: false,
      streamingBatchDelay: 20,
      streamingBatchSize: 1,
      coverage: { server: 'functions' },
    });
  }

  function tests(backendUrl: string) {
    const suite = fakeSuite();
    const plain = { ...fakeTestCase({ title: 'plain', parent: suite }), id: 'plain', retries: 0 };
    const covered = { ...fakeTestCase({ title: 'covered', parent: suite, line: 9 }), id: 'covered', retries: 0 };
    suite.allTests = () => [plain, covered];
    const coveredResult = fakeResult({
      attachments: [
        {
          name: ATTACHMENT_NAMES.serverCoverageRequests,
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify({ [backendUrl]: ['p.1', 'p.2'] })),
        },
      ],
    });
    return { suite, plain, covered, coveredResult };
  }

  it('streams a test once its server coverage is in, the others at once, then sends the run coverage', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const dash = await dashboard();
    const back = await backend(gate);
    const reporter = reporterFor(dash.server.url, true);
    const { suite, plain, covered, coveredResult } = tests(back.url);

    reporter.onBegin(fakeConfig({ projects: [{ use: { baseURL: back.url } }] }), suite);
    expect(process.env.PIWI_COVERAGE_SERVER).toBe('functions');
    reporter.onTestBegin(plain, fakeResult({}));
    reporter.onTestBegin(covered, fakeResult({}));
    reporter.onTestEnd(covered, coveredResult);
    reporter.onTestEnd(plain, fakeResult({}));

    // The last test ended: its collection and the run's coverage are asked for at once.
    await waitFor(() => back.requests.some((req) => req.method === 'GET'));
    await waitFor(() => !!resultOf(dash.events, 'plain'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(dash.events.filter((event) => event.type === 'complete').map((event) => event.title)).toEqual(['plain']);
    expect(resultOf(dash.events, 'plain')!.coverage).toBeNull();

    open();
    await waitFor(() => !!resultOf(dash.events, 'covered'));
    const streamed = resultOf(dash.events, 'covered')!;
    expect(streamed.coverage).toEqual({
      v: 1,
      files: [{ path: 'src/Web/Basket.cs', runtime: 'server', functions: [[3, 9]] }],
    });

    await reporter.onEnd({ status: 'passed' } as never);
    const collect = JSON.parse(back.requests.find((req) => req.method === 'POST')!.body);
    expect(collect).toEqual({
      granularity: 'functions',
      groups: [{ key: expect.any(String), requests: ['p.1', 'p.2'] }],
    });
    // The run's coverage goes out after the finish, once.
    const finishAt = dash.calls.indexOf('POST /api/test-runs/1/finish');
    const coverageAt = dash.calls.indexOf('PUT /api/test-runs/1/coverage');
    expect(finishAt).toBeGreaterThan(-1);
    expect(coverageAt).toBeGreaterThan(finishAt);
    expect(dash.runCoverage).toEqual([
      { v: 1, files: [{ path: 'src/Web/Basket.cs', runtime: 'server', functions: [[3, 9]], executable: [[4, 20]] }] },
    ]);
  });

  it('waits at the end of the run for a test still collecting', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const dash = await dashboard();
    const back = await backend(gate);
    const reporter = reporterFor(dash.server.url, true);
    const { suite, covered, coveredResult } = tests(back.url);
    suite.allTests = () => [covered];

    reporter.onBegin(fakeConfig({ projects: [{ use: { baseURL: back.url } }] }), suite);
    reporter.onTestBegin(covered, fakeResult({}));
    reporter.onTestEnd(covered, coveredResult);
    setTimeout(open, 300);
    await reporter.onEnd({ status: 'passed' } as never);

    const streamed = resultOf(dash.events, 'covered')!;
    expect((streamed.coverage as { files: unknown[] }).files).toHaveLength(1);
    expect(dash.calls.indexOf('POST /api/test-runs/1/finish')).toBeGreaterThan(-1);
  });

  it('includes the collected coverage in the batch submit', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const dash = await dashboard();
    const back = await backend(gate);
    const reporter = reporterFor(dash.server.url, false);
    const { suite, covered, coveredResult } = tests(back.url);
    suite.allTests = () => [covered];

    reporter.onBegin(fakeConfig({ projects: [{ use: { baseURL: back.url } }] }), suite);
    reporter.onTestBegin(covered, fakeResult({}));
    reporter.onTestEnd(covered, coveredResult);
    setTimeout(open, 100);
    await reporter.onEnd({ status: 'passed' } as never);

    expect(dash.submitted).toHaveLength(1);
    expect(dash.submitted[0]!.coverage).toEqual({
      v: 1,
      files: [{ path: 'src/Web/Basket.cs', runtime: 'server', functions: [[3, 9]] }],
    });
    expect(dash.calls).toContain('PUT /api/test-runs/2/coverage');
  });
});

describe('the manifests of the origins a run reaches', () => {
  let servers: FakeServer[] = [];

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers = [];
    vi.restoreAllMocks();
  });

  it('fetches an origin manifest as the origin is first noted, and uploads it after the finish', async () => {
    const projectName = `piwi-manifests-${process.pid}`;
    const calls: string[] = [];
    const uploads: unknown[] = [];
    const dash = await startServerOnTestPort((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      if (req.url === '/api/test-runs/start') jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      else if (req.url === '/api/test-runs/1/events' || req.url === '/api/test-runs/1/finish') jsonRes(res, 200, {});
      else if (req.url === '/api/projects/menu') jsonRes(res, 200, { items: [{ id: 7, name: projectName }] });
      else if (req.method === 'PUT' && req.url === '/api/projects/7/surface/manifest') {
        uploads.push(JSON.parse(req.body));
        jsonRes(res, 200, {});
      } else textRes(res, 404, 'nope');
    });
    servers.push(dash);
    const portal = await startServerOnTestPort((req, res) => {
      if (req.url === '/__piwi/manifest') jsonRes(res, 200, { routes: [{ method: 'GET', pattern: '/Commande' }] });
      else textRes(res, 404, 'nope');
    });
    servers.push(portal);

    const reporter = new PiwiDashboardReporter({
      serverUrl: dash.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      captureResources: false,
      collectScmInfo: false,
      streamingBatchDelay: 20,
      streamingBatchSize: 1,
    });
    const suite = fakeSuite();
    const first = { ...fakeTestCase({ title: 'first', parent: suite }), id: 'first', retries: 0 };
    const never = { ...fakeTestCase({ title: 'never', parent: suite, line: 9 }), id: 'never', retries: 0 };
    suite.allTests = () => [first, never];
    const network = [{ method: 'GET', url: `${portal.url}/Commande`, status: 200, duration: 1, serverLogs: [] }];

    reporter.onBegin(fakeConfig({ projects: [{ use: { baseURL: 'http://127.0.0.1:1/' } }] }), suite);
    reporter.onTestBegin(first, fakeResult({}));
    reporter.onTestEnd(
      first,
      fakeResult({
        attachments: [
          {
            name: ATTACHMENT_NAMES.network,
            contentType: 'application/json',
            body: Buffer.from(JSON.stringify(network)),
          },
        ],
      }),
    );

    // Fetched now, though a planned test never ends (an interrupted run, --max-failures).
    await waitFor(() => portal.requests.some((req) => req.url === '/__piwi/manifest'));
    // The origin's server stops before the end of the run, as a webServer does.
    await portal.close();
    servers = servers.filter((server) => server !== portal);

    await reporter.onEnd({ status: 'interrupted' } as never);

    expect(uploads).toEqual([
      expect.objectContaining({
        source: 'instrumentation',
        manifest: { routes: [{ method: 'GET', pattern: '/Commande' }] },
      }),
    ]);
    const finishAt = calls.indexOf('POST /api/test-runs/1/finish');
    expect(finishAt).toBeGreaterThan(-1);
    expect(calls.indexOf('PUT /api/projects/7/surface/manifest')).toBeGreaterThan(finishAt);
  });
});
