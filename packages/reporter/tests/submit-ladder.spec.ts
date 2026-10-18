import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { RunSubmitter, type CollectedRun } from '../src/internal/submit/run-submitter.js';
import { HttpClient } from '../src/internal/transport/http-client.js';
import { Uploader } from '../src/internal/submit/uploader.js';
import { CrashRecovery } from '../src/internal/streaming/crash-recovery.js';
import { FileHandler } from '../src/internal/files/file-handler.js';
import { Logger } from '../src/internal/support/logger.js';
import { hashForProject } from '../src/internal/support/instance-id.js';
import {
  startServer,
  jsonRes,
  textRes,
  urlsHit,
  fakeConfig,
  fakeSuite,
  fakeTestCase,
  fakeResult,
  type FakeServer,
} from './_helpers.js';

const RECOVERY_PREFIX = 'piwi-dashboard-recovery-';
const STREAM_PREFIX = 'piwi-dashboard-stream-';
const SETUP_PREFIX = 'piwi-dashboard-setup-';

function cleanupProjectArtifacts(projectName: string): void {
  // Recovery and stream-buffer files are keyed by a sha1 hash of the project
  // name, so match on the hash rather than the raw name.
  const tmp = os.tmpdir();
  const hash = hashForProject(projectName);
  for (const f of fs.readdirSync(tmp)) {
    if (f.startsWith(RECOVERY_PREFIX) || f.startsWith(STREAM_PREFIX) || f.startsWith(SETUP_PREFIX)) {
      if (f.includes(hash) || f.includes(projectName)) {
        try {
          fs.unlinkSync(path.join(tmp, f));
        } catch {
          /* ignore */
        }
      }
    }
  }
}

function recoveryFilePath(projectName: string): string {
  return path.join(os.tmpdir(), `${RECOVERY_PREFIX}${hashForProject(projectName)}.json`);
}

async function runOneTest(reporter: PiwiDashboardReporter, title: string, status = 'passed'): Promise<void> {
  const suite = fakeSuite();
  const test = fakeTestCase({ title, parent: suite });
  suite.allTests = () => [test];
  reporter.onBegin(fakeConfig(), suite);
  reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
  reporter.onTestEnd(test, fakeResult({ status, duration: 5, workerIndex: 0 }));
  await reporter.onEnd({ status: 'passed' } as any);
}

describe('PiwiDashboardReporter submit/fallback ladder', () => {
  let server: FakeServer;
  const projectName = 'piwi-ladder-' + process.pid;

  beforeEach(() => {
    cleanupProjectArtifacts(projectName);
  });

  afterEach(async () => {
    if (server) await server.close();
    cleanupProjectArtifacts(projectName);
  });

  it('a run that stopped before any test began (its global setup threw) sends and saves nothing', async () => {
    server = await startServer((_req, res) => textRes(res, 400, 'no'));
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      uploadReport: false,
      uploadTraces: false,
    });
    await reporter.onEnd({ status: 'failed' } as any);
    expect(urlsHit(server)).toEqual([]);
    expect(fs.existsSync(recoveryFilePath(projectName))).toBe(false);
  });

  it('streaming success path: /start → /events → /finish', async () => {
    let eventsBody: any;
    let finishBody: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok-123' });
      } else if (req.url === '/api/test-runs/1/events') {
        eventsBody = JSON.parse(req.body);
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/1/finish') {
        finishBody = JSON.parse(req.body);
        jsonRes(res, 200, {});
      } else if (req.url === '/api/auth/me') {
        jsonRes(res, 200, {});
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 50,
    });
    await runOneTest(reporter, 'streaming-test');

    const urls = urlsHit(server).filter((u) => u !== '/api/auth/me');
    expect(urls.includes('/api/test-runs/start'), `urls: ${urls.join(', ')}`).toBeTruthy();
    expect(urls.includes('/api/test-runs/1/events'), `urls: ${urls.join(', ')}`).toBeTruthy();
    expect(urls.includes('/api/test-runs/1/finish'), `urls: ${urls.join(', ')}`).toBeTruthy();
    expect(urls.includes('/api/test-runs/submit')).toBeFalsy();
    expect(urls.includes('/api/test-runs/upload')).toBeFalsy();

    // finish body carries the run status + counters
    expect(finishBody.status).toBe('passed');
    expect(finishBody.streamToken).toBe('tok-123');
    expect(finishBody.totalTests).toBe(1);
    expect(finishBody.passedTests).toBe(1);
    // events body carries testCases array
    expect(Array.isArray(eventsBody.testCases)).toBeTruthy();
    expect(eventsBody.testCases.length >= 1).toBeTruthy();
  });

  it('streaming disabled, no files: JSON /submit only', async () => {
    let submitBody: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 10, projectId: 20 });
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    await runOneTest(reporter, 'json-test');

    const urls = urlsHit(server);
    expect(urls.includes('/api/test-runs/submit')).toBeTruthy();
    expect(urls.includes('/api/test-runs/upload')).toBeFalsy();
    expect(urls.some((u) => u.endsWith('/finish'))).toBeFalsy();
    // submit payload has the wire testCases (no `attachments` / `_filesUploaded`)
    expect(submitBody.projectName).toBe(projectName);
    expect(submitBody.status).toBe('passed');
    expect(submitBody.testCases.length).toBe(1);
    expect('attachments' in submitBody.testCases[0]).toBe(false);
    expect('_filesUploaded' in submitBody.testCases[0]).toBe(false);
  });

  it('writes the CI output file with the submitted run identity', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        jsonRes(res, 200, { runId: 99, projectId: 5 });
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const outputFile = path.join(os.tmpdir(), `piwi-run-${process.pid}.json`);
    try {
      const reporter = new PiwiDashboardReporter({
        serverUrl: server.url,
        projectName,
        streaming: false,
        uploadReport: false,
        uploadTraces: false,
        liveFileUploads: false,
        outputFile,
      });
      await runOneTest(reporter, 'output-file-test');

      const parsed = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      expect(parsed.runId).toBe(99);
      expect(parsed.projectId).toBe(5);
      expect(parsed.status).toBe('passed');
      expect(parsed.runUrl).toBe(`${server.url}/test-runs/99`);
    } finally {
      fs.rmSync(outputFile, { force: true });
    }
  });

  it('streaming disabled, uploadReport=true: multipart /upload only (no /submit)', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/upload') {
        jsonRes(res, 200, { runId: 11, projectId: 21 });
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false, // no html report on disk → appendReportsToForm finds nothing
      uploadTraces: false,
      liveFileUploads: false,
      reports: [{ type: 'missing-type', dir: '/nonexistent' }], // forces hasReports=true but no files
    });
    await runOneTest(reporter, 'upload-test');

    const urls = urlsHit(server);
    // hasReports is true (reports array non-empty) so /upload is attempted;
    // it succeeds so /submit is NOT called.
    expect(urls.includes('/api/test-runs/upload'), `urls: ${urls.join(', ')}`).toBeTruthy();
    expect(urls.includes('/api/test-runs/submit')).toBeFalsy();
  });

  it('fallback: /upload fails → /submit succeeds', async () => {
    let submitBody: any;
    let uploadBody = '';
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/upload') {
        uploadBody = req.body;
        textRes(res, 500, 'boom');
      } else if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 12, projectId: 22 });
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      reports: [{ type: 'missing-type', dir: '/nonexistent' }],
    });
    await runOneTest(reporter, 'fallback-test');

    const urls = urlsHit(server);
    const uploadIdx = urls.indexOf('/api/test-runs/upload');
    const submitIdx = urls.indexOf('/api/test-runs/submit');
    expect(uploadIdx, `urls: ${urls.join(', ')}`).toBeGreaterThanOrEqual(0);
    expect(submitIdx, `urls: ${urls.join(', ')}`).toBeGreaterThanOrEqual(0);
    expect(uploadIdx < submitIdx, 'upload must be tried before submit').toBeTruthy();
    // The dashboard learns which rung delivered the run, and why.
    expect(submitBody.metadata.ingestHealth).toEqual({ submitFallback: { path: 'submit', reason: 'upload-failed' } });
    // Both rungs deliver the run under one key, so a dashboard that stored the upload stores the run once.
    expect(submitBody.deliveryKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(uploadBody).toContain(`"deliveryKey":"${submitBody.deliveryKey}"`);
  });

  it('a failed /finish falls back to /upload and names the fallback in the run metadata', async () => {
    let uploadBody = '';
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/1/finish') {
        textRes(res, 500, 'boom');
      } else if (req.url === '/api/test-runs/upload') {
        uploadBody = req.body;
        jsonRes(res, 200, { runId: 2, projectId: 3 });
      } else if (req.url === '/api/auth/me') {
        jsonRes(res, 200, {});
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: true,
      liveFileUploads: false,
      streamingBatchDelay: 50,
    });
    await runOneTest(reporter, 'finish-fails-test');

    expect(urlsHit(server)).toContain('/api/test-runs/upload');
    expect(uploadBody).toContain('"ingestHealth":{"submitFallback":{"path":"upload","reason":"finish-failed"}}');
  });

  it('all upload methods fail → recovery file is written', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        textRes(res, 500, 'down');
      } else if (req.url === '/api/test-runs/upload') {
        textRes(res, 500, 'down');
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    // Should not throw — recovery saves the payload instead.
    await runOneTest(reporter, 'recovery-test');

    // A recovery file should now exist in tmpdir for this project.
    const recovered = JSON.parse(fs.readFileSync(recoveryFilePath(projectName), 'utf8'));
    expect(recovered.projectName).toBe(projectName);
  });

  it('batch mode retries a saved recovery payload on the next run', async () => {
    server = await startServer((_req, res) => textRes(res, 500, 'down'));
    const failing = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    await runOneTest(failing, 'lost-run-test');
    await server.close();
    expect(fs.existsSync(recoveryFilePath(projectName)), 'expected a recovery file after the failed run').toBe(true);

    const submits: any[] = [];
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        submits.push(JSON.parse(req.body));
        jsonRes(res, 200, { runId: 30 + submits.length, projectId: 20 });
      } else {
        textRes(res, 404, 'nope');
      }
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    await runOneTest(reporter, 'second-run-test');

    const titles = submits.map((s) => s.testCases[0].title);
    expect(titles, `submits: ${titles.join(', ')}`).toContain('lost-run-test');
    const lost = submits.find((s) => s.testCases[0].title === 'lost-run-test');
    const second = submits.find((s) => s.testCases[0].title === 'second-run-test');
    expect(lost.metadata.ingestHealth).toEqual({ submitFallback: { path: 'recovery' } });
    // A run delivered by its usual rung names no fallback.
    expect(second.metadata.ingestHealth).toBeUndefined();
    expect(titles, `submits: ${titles.join(', ')}`).toContain('second-run-test');
    expect(fs.existsSync(recoveryFilePath(projectName)), 'recovery file is cleared after the retry').toBe(false);
  });

  it('buffer overflow drops results → skips /finish and re-sends the full run via /submit', async () => {
    let finishHit = false;
    let submitBody: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/1/finish') {
        finishHit = true;
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 1, projectId: 2 });
      } else if (req.url === '/api/auth/me') {
        jsonRes(res, 200, {});
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      // Huge batch settings so events accumulate in the buffer (no mid-run
      // flush), and a tiny budget so per-test results are evicted.
      streamingBatchSize: 100000,
      streamingBatchDelay: 60000,
      maxStreamBufferBytes: 1000,
    });

    // Each complete event carries a big error string, blowing past the budget.
    const bigError = new Error('x'.repeat(3000));
    const suite = fakeSuite();
    const tests = ['t1', 't2', 't3', 't4'].map((t) => fakeTestCase({ title: t, parent: suite }));
    suite.allTests = () => tests;
    reporter.onBegin(fakeConfig(), suite);
    for (const test of tests) {
      reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
      reporter.onTestEnd(test, fakeResult({ status: 'failed', duration: 5, workerIndex: 0, error: bigError }));
    }
    await reporter.onEnd({ status: 'failed' } as any);

    const urls = urlsHit(server).filter((u) => u !== '/api/auth/me');
    // /finish must be skipped because live results were dropped under pressure…
    expect(finishHit, `urls: ${urls.join(', ')}`).toBe(false);
    // …and the full run must still reach the server via the batch /submit.
    expect(submitBody, `urls: ${urls.join(', ')}`).toBeTruthy();
    expect(submitBody.testCases.length).toBe(4);
    expect(submitBody.metadata.ingestHealth).toEqual({ submitFallback: { path: 'submit', reason: 'results-lost' } });
  });

  it('a result too large for /events keeps the stream going and re-sends the full run via /submit', async () => {
    const streamed: string[] = [];
    let finishHit = false;
    let submitBody: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        // A request-size limit in front of the dashboard, like a reverse proxy's.
        if (Buffer.byteLength(req.body) > 1024 * 1024) return textRes(res, 413, 'too large');
        streamed.push(...JSON.parse(req.body).testCases.map((e: any) => `${e.type}:${e.title}`));
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/1/finish') {
        finishHit = true;
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 1, projectId: 2 });
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 50,
    });
    const suite = fakeSuite();
    const tests = ['small-1', 'huge', 'small-2'].map((t) => fakeTestCase({ title: t, parent: suite }));
    suite.allTests = () => tests;
    reporter.onBegin(fakeConfig(), suite);
    for (const test of tests) {
      const huge = test.title === 'huge';
      const result = fakeResult({ status: huge ? 'failed' : 'passed', workerIndex: 0 });
      if (huge) result.errors = [{ message: 'x'.repeat(2 * 1024 * 1024) }];
      reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
      reporter.onTestEnd(test, result);
    }
    await reporter.onEnd({ status: 'failed' } as any);

    expect(streamed).toContain('complete:small-1');
    expect(streamed).toContain('complete:small-2');
    expect(streamed).not.toContain('complete:huge');
    expect(finishHit).toBe(false);
    expect(submitBody.testCases.map((tc: any) => tc.title)).toEqual(['small-1', 'huge', 'small-2']);
  });

  it('submitTimeout stops waiting for a hung dashboard and saves the run for the next one', async () => {
    // Accepts every request and never answers, like a hung process or a
    // firewall that drops the replies.
    server = await startServer(() => {});

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 50,
      submitTimeout: 300,
    });
    const started = Date.now();
    await runOneTest(reporter, 'hung-dashboard-test');

    // Each request alone would wait for the 30 s socket timeout.
    expect(Date.now() - started).toBeLessThan(10_000);
    const recovered = JSON.parse(fs.readFileSync(recoveryFilePath(projectName), 'utf8'));
    expect(recovered.testCases[0].title).toBe('hung-dashboard-test');
    server.server.closeAllConnections();
  });

  it('a non-finite submitTimeout means no limit', async () => {
    server = await startServer((req, res) =>
      req.url === '/api/test-runs/submit' ? jsonRes(res, 200, { runId: 5 }) : textRes(res, 404, 'nope'),
    );
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      submitTimeout: Infinity,
    });
    await runOneTest(reporter, 'unbounded-test');

    expect(urlsHit(server)).toContain('/api/test-runs/submit');
    expect(fs.existsSync(recoveryFilePath(projectName))).toBe(false);
  });

  it('401 with no auth propagates (does not fall back) and saves a recovery copy', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        textRes(res, 401, 'unauthorized');
      } else if (req.url === '/api/test-runs/upload') {
        textRes(res, 401, 'unauthorized');
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      reports: [{ type: 'missing-type', dir: '/nonexistent' }],
    });
    await expect(runOneTest(reporter, 'auth-fail-test')).rejects.toThrow(/401/);

    // The run is not lost: a recovery copy is written before the throw.
    const recovered = JSON.parse(fs.readFileSync(recoveryFilePath(projectName), 'utf8'));
    expect(recovered.projectName).toBe(projectName);
    expect(recovered.testCases[0].title).toBe('auth-fail-test');
  });
});

describe('RunSubmitter local copies', () => {
  let server: FakeServer;
  const projectName = 'piwi-submitter-' + process.pid;

  beforeEach(() => cleanupProjectArtifacts(projectName));
  afterEach(async () => {
    if (server) await server.close();
    cleanupProjectArtifacts(projectName);
  });

  function collectedRun(serverUrl: string): CollectedRun {
    return {
      options: { serverUrl, projectName, uploadReport: false, uploadTraces: false },
      testCases: [],
      startTime: new Date().toISOString(),
      playwrightVersion: null,
      reporterVersion: null,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      skippedTests: 0,
      timedOutTests: 0,
      didNotRunTests: 0,
      metadata: {},
      instanceId: 'instance',
      shardInfo: null,
      setupSteps: [],
      isFullRun: true,
      filterDetails: null,
    };
  }

  function streamSession(overrides: Record<string, unknown> = {}) {
    return {
      startPromise: null,
      drain: async () => {},
      auth: null,
      enabled: true,
      runId: 1,
      token: 'tok',
      lostResults: false,
      uploadRemaining: async () => {},
      discardBuffered: vi.fn(),
      ...overrides,
    };
  }

  function submitter(url: string, sm: ReturnType<typeof streamSession>): RunSubmitter {
    const logger = new Logger(false);
    const http = new HttpClient(url, logger);
    return new RunSubmitter(
      http,
      new Uploader(http, new FileHandler(logger), logger),
      new CrashRecovery(projectName, logger),
      sm as any,
      logger,
    );
  }

  it("discards the run's buffered live events once /finish succeeds", async () => {
    server = await startServer((req, res) =>
      req.url === '/api/test-runs/1/finish' ? jsonRes(res, 200, {}) : textRes(res, 404, 'nope'),
    );
    const sm = streamSession();
    await submitter(server.url, sm).submit(collectedRun(server.url), { status: 'passed' } as any);
    expect(sm.discardBuffered).toHaveBeenCalledOnce();
  });

  it("discards the run's buffered live events once the batch submit succeeds", async () => {
    server = await startServer((req, res) =>
      req.url === '/api/test-runs/submit' ? jsonRes(res, 200, { runId: 2 }) : textRes(res, 404, 'nope'),
    );
    const sm = streamSession({ lostResults: true });
    await submitter(server.url, sm).submit(collectedRun(server.url), { status: 'passed' } as any);
    expect(urlsHit(server)).toEqual(['/api/test-runs/submit']);
    expect(sm.discardBuffered).toHaveBeenCalledOnce();
  });

  it('keeps the buffered live events when no rung reaches the server', async () => {
    server = await startServer((_req, res) => textRes(res, 500, 'down'));
    const sm = streamSession();
    await submitter(server.url, sm).submit(collectedRun(server.url), { status: 'passed' } as any);
    expect(sm.discardBuffered).not.toHaveBeenCalled();
    expect(fs.existsSync(recoveryFilePath(projectName))).toBe(true);
  });
});
