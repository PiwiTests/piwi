import { describe, it, afterEach, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { PIWI_RESOURCES_RESULTS_ENV } from '../src/internal/config/env.js';
import { ATTACHMENT_NAMES } from '../src/internal/capture/attachments.js';
import type { ResourceCensus } from '../src/internal/capture/resource-ledger.js';
import { startServer, jsonRes, fakeConfig, fakeSuite, fakeTestCase, fakeResult, type FakeServer } from './_helpers.js';

const SPEC = path.resolve('tests/cart.spec.ts');

/** The census a test that left its context open attaches. */
function leakyCensus(): ResourceCensus {
  const test = { id: 't1', file: 'tests/cart.spec.ts', suite: [] };
  return {
    v: 1,
    worker: 0,
    pid: 1,
    at: 1000,
    test: { ...test, title: 'adds to cart' },
    born: [{ id: 1, kind: 'context', parent: null, at: 900, phase: 'test', fixture: null, test, site: 'tests/cart.spec.ts:4' }],
    closed: [],
    open: [{ id: 1, pages: 0 }],
  };
}

describe('the resource summary', () => {
  let server: FakeServer | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env[PIWI_RESOURCES_RESULTS_ENV];
    if (server) await server.close();
    server = undefined;
  });

  async function run(
    options: Record<string, unknown>,
    result: ReturnType<typeof fakeResult>,
    shutdown?: ResourceCensus,
    onBody?: (body: any) => void,
  ): Promise<string[]> {
    server = await startServer((req, res) => {
      if (onBody && req.body) onBody(JSON.parse(req.body));
      jsonRes(res, 200, { runId: 1, projectId: 1 });
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName: 'piwi-resources-' + process.pid,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      ...options,
    });
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logged.push(line));
    const suite = fakeSuite();
    const testCase = fakeTestCase({ title: 'adds to cart', file: SPEC, parent: suite });
    suite.allTests = () => [testCase];
    reporter.onBegin(fakeConfig(), suite);
    const resultsFile = process.env[PIWI_RESOURCES_RESULTS_ENV];
    if (shutdown && resultsFile) fs.appendFileSync(resultsFile, `${JSON.stringify(shutdown)}\n`);
    reporter.onTestBegin(testCase, result);
    reporter.onTestEnd(testCase, result);
    await reporter.onEnd({ status: 'passed' } as any);
    if (resultsFile) expect(fs.existsSync(resultsFile)).toBe(false);
    return logged.filter((line) => line.startsWith('[Piwi Dashboard] ')).map((line) => line.slice(17));
  }

  it('prints what the tests left open, stitched with the shutdown census each worker wrote', async () => {
    const shutdown: ResourceCensus = {
      ...leakyCensus(),
      at: 3000,
      test: null,
      born: [],
      open: [],
      closed: [{ id: 1, at: 3000, phase: 'worker', test: null }],
    };
    const attachments = [
      { name: ATTACHMENT_NAMES.resources, contentType: 'application/json', body: Buffer.from(JSON.stringify(leakyCensus())) },
    ];
    const lines = await run({}, fakeResult({ attachments }), shutdown);
    expect(lines).toContain('Resources: 1 leak');
    expect(lines).toContain(
      '  leaked   context     tests/cart.spec.ts:4 · 1 test · open until the worker shut down (2.0 s past its test)',
    );
  });

  it('counts probable leaks from the steps of a test that ran without the fixtures', async () => {
    const steps = [
      { title: 'Create context', category: 'pw:api', location: { file: SPEC, line: 7, column: 1 }, steps: [] },
    ];
    const lines = await run({}, fakeResult({ steps }));
    expect(lines).toContain('Resources: 1 probable leak');
    expect(lines).toContain('  probable context     tests/cart.spec.ts:7 · 1 opened, 0 closed in tests/cart.spec.ts');
  });

  it('prints what the run cost the machine, with the artifacts the tests attached', async () => {
    const trace = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-summary-')), 'trace.zip');
    fs.writeFileSync(trace, Buffer.alloc(3 * 1024 * 1024));
    const attachments = [{ name: 'trace', contentType: 'application/zip', path: trace }];
    const lines = await run({}, fakeResult({ attachments }));
    expect(lines.find((line) => line.startsWith('Machine: '))).toMatch(/^Machine: \d+ cores · /);
    expect(lines.find((line) => line.startsWith('  Disk     '))).toContain('3 MB of artifacts (traces 3 MB)');
    fs.rmSync(path.dirname(trace), { recursive: true, force: true });
  });

  it('sends the report with the run, and each execution its cost', async () => {
    const bodies: any[] = [];
    const attachments = [
      {
        name: ATTACHMENT_NAMES.resources,
        contentType: 'application/json',
        body: Buffer.from(
          JSON.stringify({
            ...leakyCensus(),
            metrics: {
              worker: { cpuMs: 40, involuntarySwitches: 2, loopUtilization: 0.2, loopDelayP99Ms: 12, loopDelayMaxMs: 20, heapUsedMb: 50, fds: 30 },
            },
            openAtStart: { contexts: 0, pages: 0 },
            leftOpen: 1,
          }),
        ),
      },
    ];
    await run({}, fakeResult({ attachments }), undefined, (body) => bodies.push(body));
    const submitted = bodies.find((body) => body.testCases);
    expect(submitted.resourceReport).toMatchObject({
      v: 1,
      counts: { leaked: 1 },
      findings: [expect.objectContaining({ verdict: 'leaked', site: 'tests/cart.spec.ts:4' })],
    });
    expect(submitted.resourceReport.profile.machine.cores).toBeGreaterThan(0);
    expect(submitted.testCases[0].resources).toMatchObject({ workerCpuMs: 40, leftOpen: 1 });
  });

  it('stays silent with captureResources: false, and tells no worker where to write', async () => {
    const attachments = [
      { name: ATTACHMENT_NAMES.resources, contentType: 'application/json', body: Buffer.from(JSON.stringify(leakyCensus())) },
    ];
    const lines = await run({ captureResources: false }, fakeResult({ attachments }));
    expect(process.env[PIWI_RESOURCES_RESULTS_ENV]).toBeUndefined();
    expect(lines.some((line) => line.startsWith('Resources:') || line.startsWith('Machine:'))).toBe(false);
  });
});
